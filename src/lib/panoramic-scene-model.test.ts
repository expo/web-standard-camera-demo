import { expect, test } from 'bun:test';

import {
  appendDepthSurfels,
  appendDepthSurfelsToFusion,
  appendMeshSurfelsToFusion,
  appendSurfelsToFusion,
  buildModel,
  buildModelFromFusion,
  canReusePanoramicModelSnapshot,
  createSurfelFusionAccumulator,
  DETAILED_TIMING_SAMPLE_STRIDE,
  derivePanoramicCaptureControls,
  formatFilesLocation,
  invertMatrix4,
  KEYFRAME_MAX_ROTATION_DEG_PER_SEC,
  KEYFRAME_MAX_TRANSLATION_M_PER_SEC,
  KEYFRAME_MIN_INTERVAL_MS,
  KEYFRAME_MIN_ROTATION_DEG,
  KEYFRAME_MIN_TRANSLATION_M,
  liveModelSnapshotIntervalMs,
  makeModelViewProjection,
  makeModelViewProjectionInto,
  MAX_KEYFRAMES,
  MAX_SURFELS,
  MATURE_DEPTH_VOXEL_SKIP_MIN_OBSERVATIONS,
  MIN_CAPTURE_KEYFRAMES,
  MIN_KEYFRAME_SURFELS,
  modelSurfelPointScalePx,
  nextSurfelBufferCapacityBytes,
  observedDepthSurfelCount,
  panoramicCoverageKey,
  panoramicCoveragePercent,
  panoramicCoverageSectors,
  panoramicDepthPreferenceFromSearchParam,
  panoramicDepthTypeRequestForPreference,
  sampleDepthMeters,
  sampleCameraColor,
  SAMPLE_GRID_X,
  SAMPLE_GRID_Y,
  preflightMeshSurfelsForFusion,
  serializeModelAsPly,
  shouldAcceptPanoramicKeyframe,
  shouldPublishLiveModelSnapshot,
  shouldRequestPanoramicMeshDetection,
  shouldScheduleNextXRScanFrame,
  shouldSkipCoveredPanoramicSector,
  summarizeCaptureGeometry,
  surfelSampleWeight,
  SURFEL_STRIDE_BYTES,
  SURFEL_STRIDE_FLOATS,
  transformPoint,
  unprojectViewSample,
  viewerYawForForward,
  xrScanFrameStopReason,
  type AppendDepthSurfelsProfile,
  type AppendMeshSurfelsProfile,
  type KeyframeSnapshot,
  type PanoramicCameraImage,
  type PanoramicDepthInformation,
  type Vec3,
} from './panoramic-scene-model';

const IDENTITY_4X4 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

test('unprojectViewSample treats depth as camera-plane meters', () => {
  const point = unprojectViewSample(IDENTITY_4X4, 0.5, 0.5, 2);

  expect(point[0]).toBeCloseTo(0, 6);
  expect(point[1]).toBeCloseTo(0, 6);
  expect(point[2]).toBeCloseTo(-2, 6);
});

test('unprojectViewSample honors asymmetric projection while keeping camera-plane depth', () => {
  const projection = new Float32Array([
    2, 0, 0, 0,
    0, 4, 0, 0,
    0.3, -0.2, -1.002, -1,
    0, 0, -0.2002, 0,
  ]);
  const inverseProjection = invertMatrix4(projection);

  expect(inverseProjection).not.toBeNull();
  const point = unprojectViewSample(inverseProjection!, 0.75, 0.25, 2);

  expect(point[0]).toBeCloseTo(0.8, 5);
  expect(point[1]).toBeCloseTo(0.15, 5);
  expect(point[2]).toBeCloseTo(-2, 6);
});

test('unprojectViewSample matches ARKit-intrinsics camera axes exposed through WebXR projection', () => {
  const width = 256;
  const height = 192;
  const fx = 210;
  const fy = 208;
  const cx = 119;
  const cy = 101;
  const projection = projectionFromIntrinsics(width, height, fx, fy, cx, cy);
  const inverseProjection = invertMatrix4(projection);

  expect(inverseProjection).not.toBeNull();
  const depthMeters = 2.4;
  const pixelX = 184;
  const pixelY = 72;
  const point = unprojectViewSample(
    inverseProjection!,
    (pixelX + 0.5) / width,
    (pixelY + 0.5) / height,
    depthMeters
  );

  expect(point[0]).toBeCloseTo((pixelX - cx) * depthMeters / fx, 5);
  expect(point[1]).toBeCloseTo((cy - pixelY) * depthMeters / fy, 5);
  expect(point[2]).toBeCloseTo(-depthMeters, 6);
});

test('transformPoint applies column-major camera-to-world translation', () => {
  const translated = new Float32Array(IDENTITY_4X4);
  translated[12] = 1;
  translated[13] = 2;
  translated[14] = 3;

  expect(transformPoint(translated, [0.25, 0.5, -2])).toEqual([1.25, 2.5, 1]);
});

test('sampleCameraColor reads BGRA camera bytes without channel-swizzling the full frame', () => {
  const camera = makeCameraImage(new Uint8Array([
    10, 20, 30, 255,
    40, 50, 60, 255,
    70, 80, 90, 255,
    100, 110, 120, 255,
  ]), 'bgra8unorm', 2, 2);

  const color = sampleCameraColor(camera, new Uint8Array(camera.data), IDENTITY_4X4, 1, 1);

  expect(color).not.toBeNull();
  expect(color?.[0]).toBeCloseTo(120 / 255, 6);
  expect(color?.[1]).toBeCloseTo(110 / 255, 6);
  expect(color?.[2]).toBeCloseTo(100 / 255, 6);
});

test('sampleCameraColor bilinearly samples WebXR normalized camera coordinates', () => {
  const camera = makeCameraImage(new Uint8Array([
    0, 0, 255, 255,
    0, 255, 0, 255,
    255, 0, 0, 255,
    255, 255, 255, 255,
  ]), 'bgra8unorm', 2, 2);

  const color = sampleCameraColor(camera, new Uint8Array(camera.data), IDENTITY_4X4, 0.5, 0.5);

  expect(color).not.toBeNull();
  expect(color?.[0]).toBeCloseTo(0.5, 6);
  expect(color?.[1]).toBeCloseTo(0.5, 6);
  expect(color?.[2]).toBeCloseTo(0.5, 6);
});

test('sampleCameraColor treats WebXR normalized pixel centers as exact texels', () => {
  const camera = makeCameraImage(new Uint8Array([
    0, 0, 255, 255,
    0, 255, 0, 255,
    255, 0, 0, 255,
    255, 255, 255, 255,
  ]), 'bgra8unorm', 2, 2);

  const color = sampleCameraColor(camera, new Uint8Array(camera.data), IDENTITY_4X4, 0.25, 0.25);

  expect(color).not.toBeNull();
  expect(color?.[0]).toBeCloseTo(1, 6);
  expect(color?.[1]).toBeCloseTo(0, 6);
  expect(color?.[2]).toBeCloseTo(0, 6);
});

test('sampleDepthMeters treats WebXR normalized depth pixel centers as exact samples', () => {
  const depth = {
    data: exactArrayBuffer(new Float32Array([
      1, 2,
      3, 4,
    ])),
    height: 2,
    normDepthBufferFromNormView: { matrix: IDENTITY_4X4 },
    rawValueToMeters: 1,
    width: 2,
  } satisfies PanoramicDepthInformation;

  expect(sampleDepthMeters(new Float32Array(depth.data), depth, IDENTITY_4X4, 0.25, 0.25)).toBe(1);
  expect(sampleDepthMeters(new Float32Array(depth.data), depth, IDENTITY_4X4, 0.75, 0.25)).toBe(2);
  expect(sampleDepthMeters(new Float32Array(depth.data), depth, IDENTITY_4X4, 0.25, 0.75)).toBe(3);
  expect(sampleDepthMeters(new Float32Array(depth.data), depth, IDENTITY_4X4, 0.75, 0.75)).toBe(4);
});

test('sampleCameraColor applies affine WebXR normalized camera transforms', () => {
  const camera = makeCameraImage(new Uint8Array([
    0, 0, 255, 255,
    255, 0, 0, 255,
  ]), 'bgra8unorm', 2, 1);
  const mirroredCameraFromView = new Float32Array([
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    1, 0, 0, 1,
  ]);

  const color = sampleCameraColor(camera, new Uint8Array(camera.data), mirroredCameraFromView, 0, 0);

  expect(color).not.toBeNull();
  expect(color?.[0]).toBeCloseTo(0, 6);
  expect(color?.[1]).toBeCloseTo(0, 6);
  expect(color?.[2]).toBeCloseTo(1, 6);
});

test('sampleDepthMeters maps normalized view points through normDepthBufferFromNormView', () => {
  const depth = {
    data: exactArrayBuffer(new Float32Array([
      1, 2,
      3, 4,
    ])),
    height: 2,
    normDepthBufferFromNormView: { matrix: IDENTITY_4X4 },
    rawValueToMeters: 1,
    width: 2,
  } satisfies PanoramicDepthInformation;
  const mirroredDepthFromView = new Float32Array([
    -1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    1, 0, 0, 1,
  ]);

  expect(sampleDepthMeters(new Float32Array(depth.data), depth, mirroredDepthFromView, 0, 0)).toBe(2);
  expect(sampleDepthMeters(new Float32Array(depth.data), depth, mirroredDepthFromView, 1, 1)).toBe(3);
  expect(Number.isNaN(sampleDepthMeters(new Float32Array(depth.data), depth, IDENTITY_4X4, 0.5, 0.5)))
    .toBe(true);
});

test('sampleDepthMeters interpolates continuous depth and rejects discontinuities', () => {
  const smoothDepth = {
    data: exactArrayBuffer(new Float32Array([
      1, 1.02,
      1.03, 1.04,
    ])),
    height: 2,
    normDepthBufferFromNormView: { matrix: IDENTITY_4X4 },
    rawValueToMeters: 1,
    width: 2,
  } satisfies PanoramicDepthInformation;
  const discontinuousDepth = {
    ...smoothDepth,
    data: exactArrayBuffer(new Float32Array([
      1, 1,
      4, 4,
    ])),
  };
  const invalidDepth = {
    ...smoothDepth,
    data: exactArrayBuffer(new Float32Array([
      1, 1,
      0, 1,
    ])),
  };

  expect(sampleDepthMeters(new Float32Array(smoothDepth.data), smoothDepth, IDENTITY_4X4, 0.25, 0.25))
    .toBeCloseTo(1, 6);
  expect(sampleDepthMeters(new Float32Array(smoothDepth.data), smoothDepth, IDENTITY_4X4, 0.5, 0.5))
    .toBeCloseTo(1.0225, 6);
  expect(Number.isNaN(
    sampleDepthMeters(new Float32Array(discontinuousDepth.data), discontinuousDepth, IDENTITY_4X4, 0.5, 0.5)
  )).toBe(true);
  expect(Number.isNaN(
    sampleDepthMeters(new Float32Array(invalidDepth.data), invalidDepth, IDENTITY_4X4, 0.5, 0.5)
  )).toBe(true);
});

test('buildModel fuses same-voxel surfels and prefers camera colors over fallback colors', () => {
  const points = [
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0, b: 0, weight: 1 }),
    ...surfelSample({ x: 0.01, y: 0.01, z: -1.01, r: 0, g: 0, b: 1, weight: 1 }),
    ...surfelSample({ x: 0.2, y: 0, z: -1, r: 0, g: 1, b: 0, weight: -1 }),
  ];

  const model = buildModel(points, 2);

  expect(model).not.toBeNull();
  expect(model?.rawSampleCount).toBe(3);
  expect(model?.surfelCount).toBe(2);
  expect(model?.cameraColoredSurfels).toBe(1);
  expect(model?.multiObservedSurfels).toBe(1);
  expect(model?.colorSource).toBe('mixed');
  expect(model?.surfels[4]).toBeCloseTo(0.5, 6);
  expect(model?.surfels[5]).toBeCloseTo(0, 6);
  expect(model?.surfels[6]).toBeCloseTo(0.5, 6);
});

test('incremental surfel fusion matches full model rebuild output', () => {
  const first = [
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0, b: 0, weight: 1 }),
    ...surfelSample({ x: 0.2, y: 0, z: -1, r: 0, g: 1, b: 0, weight: 1 }),
  ];
  const second = [
    ...surfelSample({ x: 0.01, y: 0.01, z: -1.01, r: 0, g: 0, b: 1, weight: 1 }),
  ];
  const all = [...first, ...second];
  const fusion = createSurfelFusionAccumulator();

  appendSurfelsToFusion(fusion, first);
  appendSurfelsToFusion(fusion, second);

  const incremental = buildModelFromFusion(fusion, 2);
  const rebuilt = buildModel(all, 2);

  expect(incremental).not.toBeNull();
  expect(rebuilt).not.toBeNull();
  expect(incremental?.rawSampleCount).toBe(rebuilt?.rawSampleCount);
  expect(incremental?.surfelCount).toBe(rebuilt?.surfelCount);
  expect(Array.from(incremental?.surfels ?? [])).toEqual(Array.from(rebuilt?.surfels ?? []));
});

test('same-voxel fusion projects agreeing observations onto the established local plane', () => {
  const fusion = createSurfelFusionAccumulator();

  appendSurfelsToFusion(fusion, [
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0, b: 0, weight: 1 }),
    ...surfelSample({ x: 0.01, y: 0.03, z: -1.01, r: 0, g: 1, b: 0, weight: 1 }),
  ]);
  const model = buildModelFromFusion(fusion, 1);

  expect(model).not.toBeNull();
  expect(model?.surfelCount).toBe(1);
  expect(model?.surfels[0]).toBeCloseTo(0.005, 6);
  expect(model?.surfels[1]).toBeCloseTo(0, 6);
  expect(model?.surfels[2]).toBeCloseTo(-1.005, 6);
});

test('buildModelFromFusion reuses CPU surfel backing while returning exact model views', () => {
  const fusion = createSurfelFusionAccumulator();

  appendSurfelsToFusion(fusion, [
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0, b: 0, weight: 1 }),
  ]);
  const first = buildModelFromFusion(fusion, 1);

  appendSurfelsToFusion(fusion, [
    ...surfelSample({ x: 0.2, y: 0, z: -1, r: 0, g: 1, b: 0, weight: 1 }),
  ]);
  const second = buildModelFromFusion(fusion, 2);

  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(first?.surfels.buffer).toBe(second?.surfels.buffer);
  expect(first?.surfels.byteLength).toBe((first?.surfelCount ?? 0) * SURFEL_STRIDE_BYTES);
  expect(second?.surfels.byteLength).toBe((second?.surfelCount ?? 0) * SURFEL_STRIDE_BYTES);
});

test('canReusePanoramicModelSnapshot accepts only exact fusion snapshots', () => {
  const fusion = createSurfelFusionAccumulator();
  appendSurfelsToFusion(fusion, [
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0, b: 0, weight: 1 }),
  ]);
  const model = buildModelFromFusion(fusion, 1);

  expect(canReusePanoramicModelSnapshot(null, fusion, 1)).toBe(false);
  expect(canReusePanoramicModelSnapshot(model, fusion, 1)).toBe(true);
  expect(canReusePanoramicModelSnapshot(model, fusion, 2)).toBe(false);

  appendSurfelsToFusion(fusion, [
    ...surfelSample({ x: 0.01, y: 0, z: -1, r: 0, g: 1, b: 0, weight: 1 }),
  ]);
  expect(canReusePanoramicModelSnapshot(model, fusion, 1)).toBe(false);
});

test('appendDepthSurfelsToFusion skips the intermediate point array', () => {
  const depth = makeDepthInformation(new Float32Array([1]));
  const camera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const points: number[] = [];
  const directFusion = createSurfelFusionAccumulator();

  const arrayAdded = appendDepthSurfels(depth, camera, IDENTITY_4X4, IDENTITY_4X4, points, 0);
  const directAdded = appendDepthSurfelsToFusion(depth, camera, IDENTITY_4X4, IDENTITY_4X4, directFusion, 0);
  const arrayModel = buildModel(points, 1);
  const directModel = buildModelFromFusion(directFusion, 1);

  expect(directAdded.cameraColoredSurfels).toBe(arrayAdded.cameraColoredSurfels);
  expect(directAdded.surfelCount).toBe(arrayAdded.surfelCount);
  expect(directAdded.newVoxelCount).toBeGreaterThan(0);
  expect(directAdded.updatedVoxelCount).toBe(0);
  expect(directFusion.rawSampleCount).toBe(arrayAdded.surfelCount);
  expect(directModel).not.toBeNull();
  expect(arrayModel).not.toBeNull();
  expect(Array.from(directModel?.surfels ?? [])).toEqual(Array.from(arrayModel?.surfels ?? []));
});

test('appendDepthSurfelsToFusion reuses sparse depth-grid scratch without stale samples', () => {
  const validDepth = makeDepthInformation(new Float32Array([1]));
  const invalidDepth = makeDepthInformation(new Float32Array([0]));
  const fusion = createSurfelFusionAccumulator();
  const firstProfile: AppendDepthSurfelsProfile = {};
  const secondProfile: AppendDepthSurfelsProfile = {};

  const first = appendDepthSurfelsToFusion(validDepth, null, IDENTITY_4X4, IDENTITY_4X4, fusion, 0, {
    profile: firstProfile,
  });
  const scratch = fusion.depthGridScratch;
  const retainedAfterFirst = fusion.rawSampleCount;
  const second = appendDepthSurfelsToFusion(
    invalidDepth,
    null,
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    retainedAfterFirst,
    { profile: secondProfile }
  );

  expect(first.surfelCount).toBeGreaterThan(0);
  expect(second.surfelCount).toBe(0);
  expect(fusion.rawSampleCount).toBe(retainedAfterFirst);
  expect(fusion.depthGridScratch).toBe(scratch);
  expect(firstProfile.cameraPointSamples).toBeGreaterThan(0);
  expect(secondProfile.cameraPointSamples).toBe(0);
  expect(firstProfile.depthCacheReused).toBe(false);
  expect(secondProfile.depthCacheReused).toBe(true);
});

test('appendDepthSurfelsToFusion reports new versus updated voxel contribution', () => {
  const depth = makeDepthInformation(new Float32Array([1]));
  const fusion = createSurfelFusionAccumulator();

  const first = appendDepthSurfelsToFusion(depth, null, IDENTITY_4X4, IDENTITY_4X4, fusion, 0);
  const second = appendDepthSurfelsToFusion(
    depth,
    null,
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    first.surfelCount
  );

  expect(first.surfelCount).toBeGreaterThan(0);
  expect(first.newVoxelCount).toBeGreaterThan(0);
  expect(first.newVoxelCount + first.updatedVoxelCount).toBe(first.surfelCount);
  expect(second.surfelCount).toBe(first.surfelCount);
  expect(second.newVoxelCount).toBe(0);
  expect(second.updatedVoxelCount).toBe(second.surfelCount);
});

test('appendDepthSurfelsToFusion reports same-voxel plane projection', () => {
  const depthWidth = SAMPLE_GRID_X;
  const depthHeight = SAMPLE_GRID_Y;
  const depth = {
    data: exactArrayBuffer(new Float32Array(depthWidth * depthHeight).fill(1)),
    height: depthHeight,
    normDepthBufferFromNormView: { matrix: IDENTITY_4X4 },
    rawValueToMeters: 1,
    width: depthWidth,
  } satisfies PanoramicDepthInformation;
  const projection = projectionFromIntrinsics(
    depthWidth,
    depthHeight,
    300,
    300,
    depthWidth / 2 - 0.5,
    depthHeight / 2 - 0.5
  );
  const profile: AppendDepthSurfelsProfile = {};
  const fusion = createSurfelFusionAccumulator();

  const added = appendDepthSurfelsToFusion(depth, null, projection, IDENTITY_4X4, fusion, 0, {
    profile,
  });

  expect(added.surfelCount).toBeGreaterThan(0);
  expect(added.updatedVoxelCount).toBeGreaterThan(0);
  expect(profile.planeProjectedSamples).toBeGreaterThan(0);
  expect(profile.planeProjectedSamples).toBeLessThanOrEqual(added.updatedVoxelCount);
});

test('appendDepthSurfelsToFusion skips mature overlapping voxels before color and normal work', () => {
  const depth = makeDepthInformation(new Float32Array([1]));
  const camera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const fusion = createSurfelFusionAccumulator();
  let existingSurfels = 0;

  for (let i = 0; i < MATURE_DEPTH_VOXEL_SKIP_MIN_OBSERVATIONS; i += 1) {
    const added = appendDepthSurfelsToFusion(
      depth,
      camera,
      IDENTITY_4X4,
      IDENTITY_4X4,
      fusion,
      existingSurfels,
      { samplePhase: 0 }
    );
    expect(added.surfelCount).toBeGreaterThan(0);
    existingSurfels += added.surfelCount;
  }
  const samplesBeforeOverlap = fusion.rawSampleCount;
  const profile: AppendDepthSurfelsProfile = {};
  let cameraRequests = 0;

  const overlap = appendDepthSurfelsToFusion(
    depth,
    () => {
      cameraRequests += 1;
      return camera;
    },
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    existingSurfels,
    { profile, samplePhase: 0 }
  );

  expect(overlap.surfelCount).toBe(0);
  expect(overlap.newVoxelCount).toBe(0);
  expect(overlap.updatedVoxelCount).toBe(0);
  expect(cameraRequests).toBe(0);
  expect(fusion.rawSampleCount).toBe(samplesBeforeOverlap);
  expect(profile.matureVoxelSkips).toBeGreaterThan(0);
  expect(profile.cameraRequested).toBe(false);
});

test('appendDepthSurfelsToFusion rejects redundant fusion before camera work', () => {
  const depth = makeDepthInformation(new Float32Array([1]));
  const camera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const fusion = createSurfelFusionAccumulator();
  const first = appendDepthSurfelsToFusion(depth, camera, IDENTITY_4X4, IDENTITY_4X4, fusion, 0);
  const preflightCameraPointScratch = fusion.preflightCameraPointScratch;
  const preflightWorldScratch = fusion.preflightWorldScratch;
  const rawSamplesAfterFirst = fusion.rawSampleCount;
  const voxelsAfterFirst = fusion.voxels.size;
  const profile: AppendDepthSurfelsProfile = {};
  let cameraRequests = 0;

  const redundant = appendDepthSurfelsToFusion(
    depth,
    () => {
      cameraRequests += 1;
      return camera;
    },
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    first.surfelCount,
    {
      minNewVoxelsForFusion: 1,
      minSurfelsForCamera: MIN_KEYFRAME_SURFELS,
      profile,
    }
  );

  expect(cameraRequests).toBe(0);
  expect(redundant.surfelCount).toBeGreaterThanOrEqual(MIN_KEYFRAME_SURFELS);
  expect(redundant.newVoxelCount).toBe(0);
  expect(redundant.updatedVoxelCount).toBeGreaterThan(0);
  expect(fusion.rawSampleCount).toBe(rawSamplesAfterFirst);
  expect(fusion.voxels.size).toBe(voxelsAfterFirst);
  expect(fusion.preflightCameraPointScratch).toBe(preflightCameraPointScratch);
  expect(fusion.preflightVoxelKeysScratch.size).toBe(0);
  expect(fusion.preflightWorldScratch).toBe(preflightWorldScratch);
  expect(profile).toMatchObject({
    cameraRequested: false,
    minNewVoxelsForFusion: 1,
    preflightNewVoxels: 0,
  });
  expect(profile.depthPreflightMs).toBeUndefined();
  expect(profile.preflightSurfels).toBeGreaterThanOrEqual(MIN_KEYFRAME_SURFELS);
  expect(profile.newVoxelPreflightMs).toBeGreaterThanOrEqual(0);
});

test('appendDepthSurfelsToFusion counts extra preflight surfels without unprojecting after new voxel gate', () => {
  const depth = makeDepthInformation(new Float32Array([1]));
  const camera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const fusion = createSurfelFusionAccumulator();
  const profile: AppendDepthSurfelsProfile = {};
  let cameraRequests = 0;

  const rejected = appendDepthSurfelsToFusion(
    depth,
    () => {
      cameraRequests += 1;
      return camera;
    },
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    {
      minNewVoxelsForFusion: 1,
      minSurfelsForCamera: Number.POSITIVE_INFINITY,
      profile,
    }
  );

  expect(cameraRequests).toBe(0);
  expect(rejected.surfelCount).toBe(SAMPLE_GRID_X * SAMPLE_GRID_Y);
  expect(rejected.newVoxelCount).toBe(1);
  expect(rejected.updatedVoxelCount).toBe(0);
  expect(fusion.rawSampleCount).toBe(0);
  expect(fusion.voxels.size).toBe(0);
  expect(profile.depthPreflightMs).toBeUndefined();
  expect(profile.cameraPointSamples).toBe(1);
  expect(profile.depthGridSampleCount).toBe(SAMPLE_GRID_X * SAMPLE_GRID_Y);
});

test('appendDepthSurfelsToFusion does not mutate fusion when preflight rejects a sparse frame', () => {
  const depth = makeDepthInformation(new Float32Array([1]));
  const camera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const fusion = createSurfelFusionAccumulator();
  let cameraRequests = 0;

  const added = appendDepthSurfelsToFusion(
    depth,
    () => {
      cameraRequests += 1;
      return camera;
    },
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    { minSurfelsForCamera: Number.POSITIVE_INFINITY }
  );

  expect(cameraRequests).toBe(0);
  expect(added.surfelCount).toBeGreaterThan(0);
  expect(added.cameraColoredSurfels).toBe(0);
  expect(fusion.rawSampleCount).toBe(0);
  expect(fusion.voxels.size).toBe(0);
});

test('appendDepthSurfels converts WebXR-shaped RGB-D frame data into camera-colored samples', () => {
  const depth = makeDepthInformation(new Float32Array([1]));
  const camera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const points: number[] = [];

  const added = appendDepthSurfels(depth, camera, IDENTITY_4X4, IDENTITY_4X4, points, 0);

  expect(added.surfelCount).toBeGreaterThan(0);
  expect(added.cameraColoredSurfels).toBe(added.surfelCount);
  expect(points.length).toBe(added.surfelCount * SURFEL_STRIDE_FLOATS);
  expect(points[4]).toBeCloseTo(1, 6);
  expect(points[5]).toBeCloseTo(128 / 255, 6);
  expect(points[6]).toBeCloseTo(0, 6);
});

test('appendDepthSurfels defers lazy camera image retrieval until the candidate is useful', () => {
  const depth = makeDepthInformation(new Float32Array([1]));
  const camera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const points: number[] = [];
  const profile = {};
  let cameraRequests = 0;

  const added = appendDepthSurfels(
    depth,
    () => {
      cameraRequests += 1;
      return camera;
    },
    IDENTITY_4X4,
    IDENTITY_4X4,
    points,
    0,
    { minSurfelsForCamera: Number.POSITIVE_INFINITY, profile }
  );

  expect(cameraRequests).toBe(0);
  expect(added.surfelCount).toBeGreaterThan(0);
  expect(added.cameraColoredSurfels).toBe(0);
  expect(points).toHaveLength(0);
  expect(profile).toMatchObject({
    cameraRequested: false,
    depthBytes: 4,
    depthHeight: 1,
    depthWidth: 1,
    minSurfelsForCamera: Number.POSITIVE_INFINITY,
    sampleOffsetX: 0.5,
    sampleOffsetY: 0.5,
    samplePhase: 0,
    sampleGridX: SAMPLE_GRID_X,
    sampleGridY: SAMPLE_GRID_Y,
  });
});

test('appendDepthSurfels defers camera image retrieval until a depth surfel needs color', () => {
  const depth = makeDepthInformation(new Float32Array([0]));
  const camera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const points: number[] = [];
  const profile: AppendDepthSurfelsProfile = {};
  let cameraRequests = 0;

  const added = appendDepthSurfels(
    depth,
    () => {
      cameraRequests += 1;
      return camera;
    },
    IDENTITY_4X4,
    IDENTITY_4X4,
    points,
    0,
    { minSurfelsForCamera: 0, profile }
  );

  expect(added.surfelCount).toBe(0);
  expect(added.cameraColoredSurfels).toBe(0);
  expect(cameraRequests).toBe(0);
  expect(points).toHaveLength(0);
  expect(profile).toMatchObject({
    cameraImageMs: 0,
    cameraRequested: false,
    depthBytes: 4,
  });
});

test('appendDepthSurfels phases the sparse sample grid across keyframes', () => {
  const values = new Float32Array(8 * 8).fill(1);
  const depth = {
    data: exactArrayBuffer(values),
    height: 8,
    normDepthBufferFromNormView: { matrix: IDENTITY_4X4 },
    rawValueToMeters: 1,
    width: 8,
  } satisfies PanoramicDepthInformation;
  const first: number[] = [];
  const second: number[] = [];
  const firstProfile = {};
  const secondProfile = {};

  appendDepthSurfels(depth, null, IDENTITY_4X4, IDENTITY_4X4, first, 0, {
    profile: firstProfile,
    samplePhase: 0,
  });
  appendDepthSurfels(depth, null, IDENTITY_4X4, IDENTITY_4X4, second, 0, {
    profile: secondProfile,
    samplePhase: 1,
  });

  expect(first.length).toBe(second.length);
  expect(first[0]).not.toBeCloseTo(second[0] ?? 0, 6);
  expect(first[1]).not.toBeCloseTo(second[1] ?? 0, 6);
  expect(firstProfile).toMatchObject({ sampleOffsetX: 0.5, sampleOffsetY: 0.5, samplePhase: 0 });
  expect(secondProfile).toMatchObject({ samplePhase: 1 });
});

test('appendDepthSurfels uses WebXR projection fast path for ARKit intrinsics geometry', () => {
  const width = 256;
  const height = 192;
  const fx = 210;
  const fy = 208;
  const cx = 119;
  const cy = 101;
  const projection = projectionFromIntrinsics(width, height, fx, fy, cx, cy);
  const depthMeters = 2.4;
  const depth = makeDepthInformation(new Float32Array([depthMeters]));
  const points: number[] = [];
  const profile: AppendDepthSurfelsProfile = {};

  appendDepthSurfels(depth, null, projection, IDENTITY_4X4, points, 0, {
    detailedProfile: true,
    profile,
  });

  const viewX = 0.5 / SAMPLE_GRID_X;
  const viewY = 0.5 / SAMPLE_GRID_Y;
  expect(profile).toMatchObject({
    centerDepthValid: true,
    depthGridSampleCount: SAMPLE_GRID_X * SAMPLE_GRID_Y,
    unprojectionMode: 'intrinsics-projection',
  });
  expect(profile.centerDepthMeters).toBeCloseTo(depthMeters, 6);
  expect(profile.centerCameraMeters?.[0]).toBeCloseTo((0.5 * width - 0.5 - cx) * depthMeters / fx, 5);
  expect(profile.centerCameraMeters?.[1]).toBeCloseTo((cy - (0.5 * height - 0.5)) * depthMeters / fy, 5);
  expect(profile.centerCameraMeters?.[2]).toBeCloseTo(-depthMeters, 6);
  expect(profile.centerWorldMeters?.[0]).toBeCloseTo(profile.centerCameraMeters?.[0] ?? 0, 6);
  expect(points[0]).toBeCloseTo((viewX * width - 0.5 - cx) * depthMeters / fx, 5);
  expect(points[1]).toBeCloseTo((cy - (viewY * height - 0.5)) * depthMeters / fy, 5);
  expect(points[2]).toBeCloseTo(-depthMeters, 6);
});

test('appendMeshSurfelsToFusion consumes WebXR mesh triangles through mesh-space poses', () => {
  const camera = makeCameraImage(new Uint8Array([
    0, 0, 255, 255,
    0, 255, 0, 255,
    255, 0, 0, 255,
    255, 255, 255, 255,
  ]), 'bgra8unorm', 2, 2);
  const mesh = {
    indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    normals: new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]),
    vertices: new Float32Array([
      -0.4, -0.4, -1,
      0.4, -0.4, -1,
      -0.4, 0.4, -1,
      0.4, 0.4, -1,
    ]),
  };
  const fusion = createSurfelFusionAccumulator();
  const profile: AppendMeshSurfelsProfile = {};

  const added = appendMeshSurfelsToFusion(
    [mesh],
    () => ({ matrix: IDENTITY_4X4 }),
    camera,
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    { maxSurfels: 8, profile }
  );
  const model = buildModelFromFusion(fusion, 1);

  expect(added.surfelCount).toBe(2);
  expect(added.cameraColoredSurfels).toBe(2);
  expect(added.newVoxelCount).toBe(2);
  expect(fusion.rawSampleCount).toBe(2);
  expect(model).not.toBeNull();
  expect(model?.cameraColoredSurfels).toBe(2);
  expect(model?.normalEstimatedSurfels).toBe(2);
  expect(model?.surfels[10]).toBeCloseTo(1, 6);
  expect(profile).toMatchObject({
    cameraRequested: true,
    meshCount: 1,
    meshNormalCount: 4,
    meshNormalMode: 'vertex',
    meshSampleStride: 1,
    meshTriangles: 2,
    meshVertices: 4,
    projectedSurfels: 2,
    sampledSurfels: 2,
  });
});

test('appendMeshSurfelsToFusion handles ARKit-style face normals', () => {
  const mesh = {
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    // ARMeshGeometry.normals is documented as outside-facing face normals, so
    // this buffer intentionally has one normal per triangle, not per vertex.
    normals: new Float32Array([
      0, 0, 1,
      1, 0, 0,
    ]),
    vertices: new Float32Array([
      -0.4, -0.3, -1,
      -0.2, 0.3, -1,
      0.0, -0.3, -1,
      0.3, -0.3, -1,
      0.5, 0.3, -1,
      0.7, -0.3, -1,
    ]),
  };
  const fusion = createSurfelFusionAccumulator();
  const profile: AppendMeshSurfelsProfile = {};

  const added = appendMeshSurfelsToFusion(
    [mesh],
    () => ({ matrix: IDENTITY_4X4 }),
    null,
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    { maxSurfels: 8, profile }
  );
  const model = buildModelFromFusion(fusion, 1);

  expect(added.surfelCount).toBe(2);
  expect(model).not.toBeNull();
  expect(model?.normalEstimatedSurfels).toBe(2);
  expect(model?.surfels[8]).toBeCloseTo(0, 6);
  expect(model?.surfels[9]).toBeCloseTo(0, 6);
  expect(model?.surfels[10]).toBeCloseTo(1, 6);
  expect(model?.surfels[20]).toBeCloseTo(-1, 6);
  expect(model?.surfels[21]).toBeCloseTo(0, 6);
  expect(model?.surfels[22]).toBeCloseTo(0, 6);
  expect(profile).toMatchObject({
    meshNormalCount: 2,
    meshNormalMode: 'face',
  });
});

test('appendMeshSurfelsToFusion keeps offscreen WebXR mesh geometry as fallback-colored surfels', () => {
  let cameraRequests = 0;
  const camera = () => {
    cameraRequests += 1;
    return makeCameraImage(new Uint8Array([0, 0, 255, 255]), 'bgra8unorm', 1, 1);
  };
  const mesh = {
    indices: new Uint32Array([0, 1, 2]),
    normals: new Float32Array([0, 0, 1]),
    vertices: new Float32Array([
      2.0, -0.2, -1,
      2.4, -0.2, -1,
      2.2, 0.2, -1,
    ]),
  };
  const fusion = createSurfelFusionAccumulator();
  const profile: AppendMeshSurfelsProfile = {};

  const added = appendMeshSurfelsToFusion(
    [mesh],
    () => ({ matrix: IDENTITY_4X4 }),
    camera,
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    { maxSurfels: 4, profile }
  );
  const model = buildModelFromFusion(fusion, 1);

  expect(added.surfelCount).toBe(1);
  expect(added.cameraColoredSurfels).toBe(0);
  expect(added.newVoxelCount).toBe(1);
  expect(model).not.toBeNull();
  expect(model?.surfels[0]).toBeGreaterThan(2);
  expect(model?.cameraColoredSurfels).toBe(0);
  expect(cameraRequests).toBe(0);
  expect(profile.cameraImageMs).toBe(0);
  expect(profile).toMatchObject({
    cameraRequested: false,
    projectedSurfels: 0,
    sampledSurfels: 1,
  });
});

test('appendMeshSurfelsToFusion caps dense mesh samples before fusion', () => {
  const mesh = {
    indices: new Uint32Array([
      0, 1, 2,
      2, 3, 4,
      4, 5, 6,
      6, 7, 8,
    ]),
    normals: null,
    vertices: new Float32Array([
      -0.8, -0.2, -1,
      -0.6, -0.2, -1,
      -0.7, 0.0, -1,
      -0.4, -0.2, -1,
      -0.5, 0.0, -1,
      -0.2, -0.2, -1,
      -0.3, 0.0, -1,
      0.0, -0.2, -1,
      -0.1, 0.0, -1,
    ]),
  };
  const fusion = createSurfelFusionAccumulator();
  const profile: AppendMeshSurfelsProfile = {};

  const added = appendMeshSurfelsToFusion(
    [mesh],
    () => ({ matrix: IDENTITY_4X4 }),
    null,
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    { maxSurfels: 2, profile }
  );

  expect(added.surfelCount).toBe(2);
  expect(added.cameraColoredSurfels).toBe(0);
  expect(profile.meshSampleStride).toBe(2);
  expect(profile.sampledSurfels).toBe(2);
  expect(profile.strideSkippedCandidates).toBe(1);
  expect(profile.cameraRequested).toBe(false);
});

test('preflightMeshSurfelsForFusion counts mesh contribution without mutating fusion', () => {
  const mesh = {
    indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
    normals: null,
    vertices: new Float32Array([
      -0.4, -0.4, -1,
      0.4, -0.4, -1,
      -0.4, 0.4, -1,
      0.4, 0.4, -1,
    ]),
  };
  const fusion = createSurfelFusionAccumulator();
  appendSurfelsToFusion(fusion, [
    ...surfelSample({ x: -0.13333, y: -0.13333, z: -1, r: 1, g: 0, b: 0, weight: 1 }),
  ]);
  const rawSampleCount = fusion.rawSampleCount;
  const voxelCount = fusion.voxels.size;

  const preflight = preflightMeshSurfelsForFusion(
    [mesh],
    () => ({ matrix: IDENTITY_4X4 }),
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    8
  );

  expect(preflight).toMatchObject({
    meshCount: 1,
    meshSampleStride: 1,
    meshTriangles: 2,
    meshVertices: 4,
    projectedSurfels: 2,
    surfelCount: 2,
  });
  expect(preflight.updatedVoxelCount).toBeGreaterThanOrEqual(1);
  expect(fusion.rawSampleCount).toBe(rawSampleCount);
  expect(fusion.voxels.size).toBe(voxelCount);
  expect(fusion.preflightVoxelKeysScratch.size).toBe(0);
});

test('preflightMeshSurfelsForFusion counts offscreen mesh geometry like append', () => {
  const mesh = {
    indices: new Uint32Array([0, 1, 2]),
    normals: null,
    vertices: new Float32Array([
      2.0, -0.2, -1,
      2.4, -0.2, -1,
      2.2, 0.2, -1,
    ]),
  };
  const fusion = createSurfelFusionAccumulator();

  const preflight = preflightMeshSurfelsForFusion(
    [mesh],
    () => ({ matrix: IDENTITY_4X4 }),
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    { maxSurfels: 4, stopAtNewVoxels: 1, stopAtSurfels: 1 }
  );

  expect(preflight).toMatchObject({
    earlyStopped: true,
    newVoxelCount: 1,
    projectedSurfels: 0,
    skippedSurfels: 0,
    surfelCount: 1,
  });
  expect(fusion.rawSampleCount).toBe(0);
  expect(fusion.voxels.size).toBe(0);
  expect(fusion.preflightVoxelKeysScratch.size).toBe(0);
});

test('preflightMeshSurfelsForFusion jumps over unsampled dense mesh candidates', () => {
  const mesh = {
    indices: new Uint32Array([
      0, 1, 2,
      2, 3, 4,
      4, 5, 6,
      6, 7, 8,
    ]),
    normals: null,
    vertices: new Float32Array([
      -0.8, -0.2, -1,
      -0.6, -0.2, -1,
      -0.7, 0.0, -1,
      -0.4, -0.2, -1,
      -0.5, 0.0, -1,
      -0.2, -0.2, -1,
      -0.3, 0.0, -1,
      0.0, -0.2, -1,
      -0.1, 0.0, -1,
    ]),
  };
  const fusion = createSurfelFusionAccumulator();

  const preflight = preflightMeshSurfelsForFusion(
    [mesh],
    () => ({ matrix: IDENTITY_4X4 }),
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    2
  );

  expect(preflight).toMatchObject({
    meshSampleStride: 2,
    projectedSurfels: 2,
    strideSkippedCandidates: 1,
    surfelCount: 2,
  });
  expect(fusion.rawSampleCount).toBe(0);
  expect(fusion.voxels.size).toBe(0);
  expect(fusion.preflightVoxelKeysScratch.size).toBe(0);
});

test('preflightMeshSurfelsForFusion stops once rescue thresholds are satisfied', () => {
  const mesh = {
    indices: new Uint32Array([
      0, 1, 2,
      1, 3, 2,
      2, 3, 4,
      3, 5, 4,
    ]),
    normals: null,
    vertices: new Float32Array([
      -0.6, -0.4, -1,
      -0.2, -0.4, -1,
      -0.6, 0.0, -1,
      -0.2, 0.0, -1,
      -0.6, 0.4, -1,
      -0.2, 0.4, -1,
    ]),
  };
  const fusion = createSurfelFusionAccumulator();

  const preflight = preflightMeshSurfelsForFusion(
    [mesh],
    () => ({ matrix: IDENTITY_4X4 }),
    IDENTITY_4X4,
    IDENTITY_4X4,
    fusion,
    0,
    { maxSurfels: 4, stopAtNewVoxels: 1, stopAtSurfels: 1 }
  );

  expect(preflight).toMatchObject({
    earlyStopped: true,
    maxSurfels: 4,
    projectedSurfels: 1,
    stopAtNewVoxels: 1,
    stopAtSurfels: 1,
    surfelCount: 1,
  });
  expect(fusion.rawSampleCount).toBe(0);
  expect(fusion.voxels.size).toBe(0);
  expect(fusion.preflightVoxelKeysScratch.size).toBe(0);
});

test('appendDepthSurfels profiles fast normalized-depth transform modes', () => {
  const identityDepth = makeDepthInformation(new Float32Array([1]));
  const affineDepth = {
    ...identityDepth,
    normDepthBufferFromNormView: {
      matrix: new Float32Array([
        -1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        1, 0, 0, 1,
      ]),
    },
  };
  const identityCamera = makeCameraImage(new Uint8Array([0, 128, 255, 255]), 'bgra8unorm', 1, 1);
  const affineCamera = {
    ...identityCamera,
    normCameraImageFromNormView: affineDepth.normDepthBufferFromNormView,
  };
  const identityProfile: AppendDepthSurfelsProfile = {};
  const affineProfile: AppendDepthSurfelsProfile = {};
  const cameraProfile: AppendDepthSurfelsProfile = {};

  appendDepthSurfels(identityDepth, identityCamera, IDENTITY_4X4, IDENTITY_4X4, [], 0, {
    detailedProfile: true,
    profile: identityProfile,
  });
  appendDepthSurfels(affineDepth, null, IDENTITY_4X4, IDENTITY_4X4, [], 0, {
    profile: affineProfile,
  });
  appendDepthSurfels(identityDepth, affineCamera, IDENTITY_4X4, IDENTITY_4X4, [], 0, {
    profile: cameraProfile,
  });

  expect(identityProfile).toMatchObject({
    cameraSampleMode: 'precomputed-axis',
    cameraTransformMode: 'identity',
    depthGridSampleMode: 'precomputed-identity',
    depthTransformMode: 'identity',
    detailedTiming: true,
    profiledSampleCount: SAMPLE_GRID_X * SAMPLE_GRID_Y,
    timingSampleStride: DETAILED_TIMING_SAMPLE_STRIDE,
  });
  expect(identityProfile.timedSampleCount).toBeGreaterThan(0);
  expect(identityProfile.timedSampleCount).toBeLessThan(identityProfile.profiledSampleCount ?? 0);
  expect(identityProfile.cameraPointCacheHits).toBeGreaterThan(0);
  expect(identityProfile.cameraPointSamples).toBeLessThanOrEqual(SAMPLE_GRID_X * SAMPLE_GRID_Y);
  expect(identityProfile.depthLookupMs).toBeGreaterThanOrEqual(0);
  expect(identityProfile.unprojectMs).toBeGreaterThanOrEqual(0);
  expect(identityProfile.normalEstimateMs).toBeGreaterThanOrEqual(0);
  expect(identityProfile.colorSampleMs).toBeGreaterThanOrEqual(0);
  expect(identityProfile.sampleConsumeMs).toBeGreaterThanOrEqual(0);
  expect(affineProfile).toMatchObject({
    depthGridSampleMode: 'normalized-transform',
    depthTransformMode: 'affine',
  });
  expect(affineProfile).not.toHaveProperty('depthLookupMs');
  expect(cameraProfile).toMatchObject({
    cameraSampleMode: 'precomputed-axis',
    cameraTransformMode: 'affine',
  });
});

test('surfelSampleWeight downweights distant, low-confidence, and grazing observations', () => {
  const nearHighConfidence = surfelSampleWeight(1, 1);
  const farHighConfidence = surfelSampleWeight(3, 1);
  const nearLowConfidence = surfelSampleWeight(1, 0.25);
  const nearGrazing = surfelSampleWeight(1, 1, 0.2);
  const nearFacing = surfelSampleWeight(1, 1, 0.85);

  expect(nearHighConfidence).toBeGreaterThan(farHighConfidence);
  expect(nearHighConfidence).toBeCloseTo(1.35, 6);
  expect(nearLowConfidence).toBeCloseTo(1.35 * (0.45 + 0.55 * 0.25), 6);
  expect(nearLowConfidence).toBeLessThan(nearHighConfidence);
  expect(nearGrazing).toBeCloseTo(1.35 * 0.35, 6);
  expect(nearGrazing).toBeLessThan(nearFacing);
  expect(nearFacing).toBeCloseTo(nearHighConfidence, 6);
});

test('shouldAcceptPanoramicKeyframe rejects capped, sparse, and redundant frames', () => {
  const last = snapshot({ time: 1000 });
  const base = {
    candidateSurfels: MIN_KEYFRAME_SURFELS,
    existingSurfels: 0,
    forward: [0, 0, -1] as Vec3,
    keyframes: 1,
    last,
    position: [0, 0, 0] as Vec3,
    time: 1500,
  };

  expect(shouldAcceptPanoramicKeyframe({ ...base, keyframes: MAX_KEYFRAMES }).reason).toBe('max-keyframes');
  expect(shouldAcceptPanoramicKeyframe({ ...base, existingSurfels: MAX_SURFELS }).reason).toBe('max-surfels');
  expect(shouldAcceptPanoramicKeyframe({ ...base, candidateSurfels: MIN_KEYFRAME_SURFELS - 1 }).reason).toBe('too-few-surfels');
  expect(shouldAcceptPanoramicKeyframe({ ...base, position: [0.2, 0, 0], time: 1100 }).reason).toBe('too-soon');
  expect(shouldAcceptPanoramicKeyframe({ ...base, position: [0.02, 0, 0] }).reason).toBe('too-similar');
});

test('pose-only keyframe policy rejects non-sample reasons before CPU depth access', () => {
  const last = snapshot({ time: 1000 });
  const base = {
    existingSurfels: 0,
    forward: [0, 0, -1] as Vec3,
    keyframes: 1,
    last,
    minRotationDeg: 1,
    minTranslationM: 0.01,
    position: [0.2, 0, 0] as Vec3,
    time: 1500,
  };

  expect(shouldAcceptPanoramicKeyframe({ ...base, keyframes: MAX_KEYFRAMES }).reason).toBe('max-keyframes');
  expect(shouldAcceptPanoramicKeyframe({ ...base, existingSurfels: MAX_SURFELS }).reason).toBe('max-surfels');
  expect(shouldAcceptPanoramicKeyframe({ ...base, time: 1100 }).reason).toBe('too-soon');
  expect(shouldAcceptPanoramicKeyframe({
    ...base,
    position: [KEYFRAME_MAX_TRANSLATION_M_PER_SEC, 0, 0],
  }).reason).toBe('too-fast');
  expect(shouldAcceptPanoramicKeyframe({
    ...base,
    minTranslationM: 0.5,
    position: [0.02, 0, 0],
  }).reason).toBe('too-similar');
  expect(shouldAcceptPanoramicKeyframe(base).accepted).toBe(true);
});

test('panoramic keyframe policy is tuned for a deliberate 180 degree scan', () => {
  expect(MAX_KEYFRAMES).toBe(18);
  expect(KEYFRAME_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(350);
  expect(KEYFRAME_MIN_TRANSLATION_M).toBeGreaterThanOrEqual(0.12);
  expect(KEYFRAME_MIN_ROTATION_DEG).toBeGreaterThanOrEqual(12);
  expect(KEYFRAME_MAX_TRANSLATION_M_PER_SEC).toBeLessThanOrEqual(0.65);
  expect(KEYFRAME_MAX_ROTATION_DEG_PER_SEC).toBeGreaterThanOrEqual(120);
  expect(KEYFRAME_MAX_ROTATION_DEG_PER_SEC).toBeLessThanOrEqual(140);
  expect(MAX_KEYFRAMES).toBe(6 * 3);
});

test('panoramic keyframe policy accepts a two second 180 degree rotation sweep', () => {
  const acceptedYaws = acceptedRotationSweepYaws(2000);

  expect(acceptedYaws.length).toBeGreaterThanOrEqual(4);
  expect(acceptedYaws[0]).toBe(0);
  expect(acceptedYaws[acceptedYaws.length - 1]).toBeGreaterThanOrEqual(120);
});

test('shouldAcceptPanoramicKeyframe rejects fast motion before retaining noisy geometry', () => {
  const last = snapshot({ time: 1000 });
  const base = {
    candidateSurfels: MIN_KEYFRAME_SURFELS,
    existingSurfels: 0,
    forward: [0, 0, -1] as Vec3,
    keyframes: 1,
    last,
    minRotationDeg: 1,
    minTranslationM: 0.01,
    position: [0, 0, 0] as Vec3,
    time: 1500,
  };

  const fastTranslation = shouldAcceptPanoramicKeyframe({
    ...base,
    position: [KEYFRAME_MAX_TRANSLATION_M_PER_SEC, 0, 0],
  });
  const fastRotation = shouldAcceptPanoramicKeyframe({
    ...base,
    forward: [1, 0, 0],
  });
  const allowedWhenThresholdRaised = shouldAcceptPanoramicKeyframe({
    ...base,
    forward: [1, 0, 0],
    maxRotationDegPerSecond: KEYFRAME_MAX_ROTATION_DEG_PER_SEC * 3,
  });

  expect(fastTranslation.reason).toBe('too-fast');
  expect(fastTranslation.translationSpeedMPerSec).toBeGreaterThan(KEYFRAME_MAX_TRANSLATION_M_PER_SEC);
  expect(fastRotation.reason).toBe('too-fast');
  expect(fastRotation.rotationSpeedDegPerSec).toBeGreaterThan(KEYFRAME_MAX_ROTATION_DEG_PER_SEC);
  expect(allowedWhenThresholdRaised.accepted).toBe(true);
});

test('shouldAcceptPanoramicKeyframe accepts first, translated, and rotated keyframes', () => {
  const last = snapshot({ time: 1000 });
  const base = {
    candidateSurfels: MIN_KEYFRAME_SURFELS,
    existingSurfels: 0,
    keyframes: 1,
    last,
    time: 1500,
  };

  expect(shouldAcceptPanoramicKeyframe({
    ...base,
    forward: [0, 0, -1],
    keyframes: 0,
    last: null,
    position: [0, 0, 0],
  }).accepted).toBe(true);
  expect(shouldAcceptPanoramicKeyframe({
    ...base,
    forward: [0, 0, -1],
    position: [0.14, 0, 0],
  }).accepted).toBe(true);
  expect(shouldAcceptPanoramicKeyframe({
    ...base,
    forward: [0.22, 0, -0.98],
    position: [0, 0, 0],
  }).accepted).toBe(true);
});

test('panoramic coverage tracks unique horizontal view sectors', () => {
  const options = { pitchBins: 1, yawBins: 4, yawRangeDeg: 360 };
  const sectors = new Set([
    panoramicCoverageKey([0, 0, -1], options),
    panoramicCoverageKey([1, 0, 0], options),
    panoramicCoverageKey([0, 0, 1], options),
    panoramicCoverageKey([-1, 0, 0], options),
  ]);

  expect(sectors.size).toBe(4);
  expect(panoramicCoveragePercent(sectors, options)).toBe(100);
});

test('panoramic coverage defaults to a forward 180 degree sweep', () => {
  const sectors = new Set([
    panoramicCoverageKey([-1, 0, 0]),
    panoramicCoverageKey([-0.5, 0, -0.86]),
    panoramicCoverageKey([0, 0, -1]),
    panoramicCoverageKey([0.5, 0, -0.86]),
    panoramicCoverageKey([1, 0, 0]),
  ]);

  expect(sectors.size).toBeGreaterThanOrEqual(5);
  expect(panoramicCoveragePercent(sectors)).toBeGreaterThan(25);
});

test('panoramic coverage can center a 180 degree scan around accepted directions', () => {
  const forwards: Vec3[] = [
    [1, 0, 0],
    [0.5, 0, -0.86],
    [0, 0, -1],
    [-0.5, 0, -0.86],
    [-1, 0, 0],
  ];
  const sectors = panoramicCoverageSectors(forwards, { pitchBins: 1, yawBins: 6 });

  expect(sectors.size).toBeGreaterThanOrEqual(5);
  expect(panoramicCoveragePercent(sectors, { pitchBins: 1, yawBins: 6 })).toBeGreaterThan(65);
});

test('panoramic coverage treats a zero scan center as the forward 180 degree default', () => {
  const options = { centerForward: [0, 0, 0] as Vec3, pitchBins: 1, yawBins: 6 };

  expect(panoramicCoverageKey([0, 0, -1], options))
    .toBe(panoramicCoverageKey([0, 0, -1], { pitchBins: 1, yawBins: 6 }));
  expect(panoramicCoverageSectors([[1, 0, 0], [-1, 0, 0]], { pitchBins: 1, yawBins: 6 }))
    .toEqual(new Set([
      panoramicCoverageKey([1, 0, 0], { pitchBins: 1, yawBins: 6 }),
      panoramicCoverageKey([-1, 0, 0], { pitchBins: 1, yawBins: 6 }),
    ]));
});

test('panoramic coverage accepts an explicit center direction', () => {
  const options = { centerForward: [1, 0, 0] as Vec3, pitchBins: 1, yawBins: 4 };
  const sectors = new Set([
    panoramicCoverageKey([0, 0, -1], options),
    panoramicCoverageKey([1, 0, 0], options),
    panoramicCoverageKey([0, 0, 1], options),
  ]);

  expect(sectors.size).toBe(3);
});

test('panoramic coverage separates upward and downward scan bands', () => {
  const options = { pitchBins: 3, yawBins: 1 };
  const sectors = new Set([
    panoramicCoverageKey([0, -0.86, -0.5], options),
    panoramicCoverageKey([0, 0, -1], options),
    panoramicCoverageKey([0, 0.86, -0.5], options),
  ]);

  expect(sectors.size).toBe(3);
  expect(panoramicCoveragePercent(sectors, options)).toBe(100);
});

test('panoramic coverage does not double-count repeated directions', () => {
  const options = { pitchBins: 1, yawBins: 4, yawRangeDeg: 360 };
  const sectors = new Set([
    panoramicCoverageKey([0, 0, -1], options),
    panoramicCoverageKey([0.02, 0, -1], options),
  ]);

  expect(sectors.size).toBe(1);
  expect(panoramicCoveragePercent(sectors, options)).toBe(25);
});

test('covered-sector precheck skips rotation-only duplicate 180 scan sectors before depth access', () => {
  const scanForwardSum: Vec3 = [0, 0, -1];
  const coverageSectors = new Set([
    panoramicCoverageKey([0, 0, -1], { centerForward: scanForwardSum }),
  ]);

  expect(shouldSkipCoveredPanoramicSector({
    coverageSectors,
    forward: [0.05, 0, -1],
    keyframes: 1,
    scanForwardSum,
    translationM: KEYFRAME_MIN_TRANSLATION_M * 0.5,
  })).toBe(true);
  expect(shouldSkipCoveredPanoramicSector({
    coverageSectors,
    forward: [0.05, 0, -1],
    keyframes: 1,
    scanForwardSum,
    translationM: KEYFRAME_MIN_TRANSLATION_M * 1.5,
  })).toBe(false);
  expect(shouldSkipCoveredPanoramicSector({
    coverageSectors,
    forward: [1, 0, 0],
    keyframes: 1,
    scanForwardSum,
    translationM: KEYFRAME_MIN_TRANSLATION_M * 0.5,
  })).toBe(false);
  expect(shouldSkipCoveredPanoramicSector({
    coverageSectors,
    forward: [0.05, 0, -1],
    keyframes: 0,
    scanForwardSum,
    translationM: 0,
  })).toBe(false);
});

test('derivePanoramicCaptureControls keeps preview scan-only and save capture-only', () => {
  expect(derivePanoramicCaptureControls({
    acceptedKeyframes: MIN_CAPTURE_KEYFRAMES,
    hasModel: false,
    liveSurfelCount: 128,
    saving: false,
    status: 'scanning',
  })).toMatchObject({
    canCapture: true,
    canPreview: true,
    canSave: false,
    canStart: false,
    capturedModelAvailable: false,
    transitioning: false,
  });

  expect(derivePanoramicCaptureControls({
    acceptedKeyframes: 1,
    hasModel: false,
    liveSurfelCount: 128,
    saving: false,
    status: 'scanning',
  })).toMatchObject({
    canCapture: false,
    canPreview: true,
    canSave: false,
  });

  expect(derivePanoramicCaptureControls({
    acceptedKeyframes: MIN_CAPTURE_KEYFRAMES,
    hasModel: true,
    liveSurfelCount: 128,
    saving: false,
    status: 'captured',
  })).toMatchObject({
    canCapture: false,
    canPreview: false,
    canSave: true,
    canStart: true,
    capturedModelAvailable: true,
  });

  expect(derivePanoramicCaptureControls({
    acceptedKeyframes: MIN_CAPTURE_KEYFRAMES,
    hasModel: true,
    liveSurfelCount: 128,
    saving: true,
    status: 'captured',
  }).canSave).toBe(false);

  expect(derivePanoramicCaptureControls({
    acceptedKeyframes: MIN_CAPTURE_KEYFRAMES,
    hasModel: true,
    liveSurfelCount: 128,
    saving: false,
    status: 'building-model',
  })).toMatchObject({
    canCapture: false,
    canPreview: false,
    canSave: false,
    transitioning: true,
  });
});

test('observedDepthSurfelCount uses preflight surface density when append skips mature overlaps', () => {
  expect(observedDepthSurfelCount(18, 112)).toBe(112);
  expect(observedDepthSurfelCount(96, 48)).toBe(96);
  expect(observedDepthSurfelCount(Number.NaN, 24.9)).toBe(24);
  expect(observedDepthSurfelCount(12.8, null)).toBe(12);
});

test('panoramic profiling query helpers isolate depth and mesh variables', () => {
  expect(panoramicDepthPreferenceFromSearchParam(undefined)).toBe('default');
  expect(panoramicDepthPreferenceFromSearchParam('raw')).toBe('raw');
  expect(panoramicDepthPreferenceFromSearchParam(['smooth'])).toBe('smooth');
  expect(panoramicDepthPreferenceFromSearchParam('smoothed')).toBe('smooth');
  expect(panoramicDepthPreferenceFromSearchParam('unknown')).toBe('default');
  expect(panoramicDepthTypeRequestForPreference('default')).toEqual(['smooth', 'raw']);
  expect(panoramicDepthTypeRequestForPreference('smooth')).toEqual(['smooth', 'raw']);
  expect(panoramicDepthTypeRequestForPreference('raw')).toEqual(['raw', 'smooth']);
  expect(shouldRequestPanoramicMeshDetection(undefined)).toBe(true);
  expect(shouldRequestPanoramicMeshDetection('0')).toBe(false);
  expect(shouldRequestPanoramicMeshDetection('false')).toBe(false);
  expect(shouldRequestPanoramicMeshDetection(['off'])).toBe(false);
  expect(shouldRequestPanoramicMeshDetection('1')).toBe(true);
});

test('live model snapshot publishing favors fresh previews until build cost grows', () => {
  expect(liveModelSnapshotIntervalMs(9999, 0)).toBe(220);
  expect(liveModelSnapshotIntervalMs(10000, 0)).toBe(320);
  expect(liveModelSnapshotIntervalMs(25000, 0)).toBe(650);
  expect(liveModelSnapshotIntervalMs(45000, 0)).toBe(1100);
  expect(liveModelSnapshotIntervalMs(12000, 16)).toBe(320);
  expect(liveModelSnapshotIntervalMs(12000, 260)).toBe(780);

  expect(shouldPublishLiveModelSnapshot({
    hasPublishedModel: false,
    keyframes: 1,
    lastPublishedAtMs: 0,
    lastPublishedKeyframes: 0,
    lastPublishedRawSampleCount: 0,
    nowMs: 1000,
    previousBuildMs: 0,
    rawSampleCount: 1200,
  })).toMatchObject({ publish: true, reason: 'initial' });

  expect(shouldPublishLiveModelSnapshot({
    hasPublishedModel: true,
    keyframes: 4,
    lastPublishedAtMs: 1000,
    lastPublishedKeyframes: 4,
    lastPublishedRawSampleCount: 12000,
    nowMs: 2000,
    previousBuildMs: 0,
    rawSampleCount: 12000,
  })).toMatchObject({ publish: false, reason: 'unchanged' });

  expect(shouldPublishLiveModelSnapshot({
    hasPublishedModel: true,
    keyframes: 2,
    lastPublishedAtMs: 1000,
    lastPublishedKeyframes: 1,
    lastPublishedRawSampleCount: 1200,
    nowMs: 1100,
    previousBuildMs: 900,
    rawSampleCount: 2400,
  })).toMatchObject({ intervalMs: 1800, publish: true, reason: 'new-keyframe' });

  expect(shouldPublishLiveModelSnapshot({
    hasPublishedModel: true,
    keyframes: 5,
    lastPublishedAtMs: 1000,
    lastPublishedKeyframes: 5,
    lastPublishedRawSampleCount: 12000,
    nowMs: 1250,
    previousBuildMs: 0,
    rawSampleCount: 13500,
  })).toMatchObject({ intervalMs: 320, publish: false, reason: 'throttled' });

  expect(shouldPublishLiveModelSnapshot({
    hasPublishedModel: true,
    keyframes: 6,
    lastPublishedAtMs: 1000,
    lastPublishedKeyframes: 5,
    lastPublishedRawSampleCount: 12000,
    nowMs: 1320,
    previousBuildMs: 0,
    rawSampleCount: 13500,
  })).toMatchObject({ intervalMs: 320, publish: true, reason: 'stale' });
});

test('XR scan frame scheduling survives preview work but not capture cancellation', () => {
  const scanning = {
    captureInFlight: false,
    sessionEnded: false,
    sessionMatches: true,
    status: 'scanning',
  } as const;
  const previewBuilding = {
    ...scanning,
    status: 'building-model',
  } as const;
  const captureCancelling = {
    ...previewBuilding,
    captureInFlight: true,
  } as const;
  const ended = {
    ...scanning,
    sessionEnded: true,
  } as const;
  const mismatched = {
    ...scanning,
    sessionMatches: false,
  } as const;
  const idle = {
    ...scanning,
    status: 'idle',
  } as const;

  expect(shouldScheduleNextXRScanFrame(scanning)).toBe(true);
  expect(xrScanFrameStopReason(scanning)).toBeNull();
  expect(shouldScheduleNextXRScanFrame(previewBuilding)).toBe(true);
  expect(xrScanFrameStopReason(previewBuilding)).toBeNull();
  expect(shouldScheduleNextXRScanFrame(captureCancelling)).toBe(false);
  expect(xrScanFrameStopReason(captureCancelling)).toBe('capture-in-flight');
  expect(shouldScheduleNextXRScanFrame(ended)).toBe(false);
  expect(xrScanFrameStopReason(ended)).toBe('session-ended');
  expect(shouldScheduleNextXRScanFrame(mismatched)).toBe(false);
  expect(xrScanFrameStopReason(mismatched)).toBe('session-mismatch');
  expect(shouldScheduleNextXRScanFrame(idle)).toBe(false);
  expect(xrScanFrameStopReason(idle)).toBe('status-idle');
});

test('surfel buffer capacity grows in coarse chunks for WebGPU reuse', () => {
  expect(nextSurfelBufferCapacityBytes(0)).toBe(0);
  expect(nextSurfelBufferCapacityBytes(SURFEL_STRIDE_BYTES)).toBe(256 * 1024);
  expect(nextSurfelBufferCapacityBytes(256 * 1024)).toBe(256 * 1024);
  expect(nextSurfelBufferCapacityBytes(256 * 1024 + 1)).toBe(512 * 1024);
});

test('dense surfel models render with smaller splats', () => {
  expect(modelSurfelPointScalePx(10000)).toBeCloseTo(3.4, 6);
  expect(modelSurfelPointScalePx(40000)).toBeCloseTo(1.7, 6);
  expect(modelSurfelPointScalePx(72000)).toBeCloseTo(1.7, 6);
});

test('summarizeCaptureGeometry reports normal-projected flatness for captured surfels', () => {
  const model = buildModel([
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0, b: 0, weight: 1 }),
    ...surfelSample({ x: 0.1, y: 0, z: -1, r: 0, g: 1, b: 0, weight: 1 }),
    ...surfelSample({ x: 0.2, y: 0.1, z: -1, r: 0, g: 0, b: 1, weight: 1 }),
  ], 1);

  expect(model).not.toBeNull();
  const summary = summarizeCaptureGeometry(model!);

  expect(summary.weightedCentroid[0]).toBeCloseTo(0.1, 6);
  expect(summary.weightedCentroid[1]).toBeCloseTo(1 / 30, 6);
  expect(summary.weightedCentroid[2]).toBeCloseTo(-1, 6);
  expect(summary.normalCoherencePercent).toBeCloseTo(100, 6);
  expect(summary.normalProjectedSpanMeters).toBeCloseTo(0.1, 6);
  expect(summary.normalProjectedRmsMeters).toBeCloseTo(Math.sqrt(1 / 450), 6);
});

test('buildModel records a weighted center for asymmetric partial scans', () => {
  const model = buildModel([
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0, b: 0, weight: 1 }),
    ...surfelSample({ x: 0.1, y: 0, z: -1, r: 0, g: 1, b: 0, weight: 1 }),
    ...surfelSample({ x: 8, y: 0, z: -1, r: 0, g: 0, b: 1, weight: 0.01 }),
  ], 1);

  expect(model).not.toBeNull();
  expect(model!.center[0]).toBeCloseTo((0.1 + 8 * 0.01) / 2.01, 6);
  expect(model!.center[1]).toBeCloseTo(0, 6);
  expect(model!.center[2]).toBeCloseTo(-1, 6);
});

test('serializeModelAsPly emits vertex colors and normals for Files export', () => {
  const model = buildModel([
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0.5, b: 0, weight: 1 }),
  ], 1);

  expect(model).not.toBeNull();
  const ply = serializeModelAsPly(model!);

  expect(ply).toContain('format ascii 1.0\n');
  expect(ply).toContain('comment keyframes 1\n');
  expect(ply).toContain('comment bounds_min 0.00000 0.00000 -1.00000\n');
  expect(ply).toContain('comment bounds_max 0.00000 0.00000 -1.00000\n');
  expect(ply).toContain('comment center 0.00000 0.00000 -1.00000\n');
  expect(ply).toContain('comment multi_observed_surfels 0\n');
  expect(ply).toContain('element vertex 1\n');
  expect(ply).toContain('property float radius\n');
  expect(ply).toContain('property float nx\n');
  expect(ply).toContain('property float weight\n');
  expect(ply).toContain('property float observations\n');
  expect(ply).toContain('property uchar red\n');
  expect(ply).toContain('0.00000 0.00000 -1.00000 1.00000 0.00000 1.00000 0.00000 1.00000 1.00000 255 128 0\n');
  expect(ply.endsWith('\n')).toBe(true);
});

test('serializeModelAsPly keeps vertex header aligned with serialized surfel rows', () => {
  const model = buildModel([
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0.5, b: 0, weight: 1 }),
  ], 1);

  expect(model).not.toBeNull();
  const withExtraBacking = {
    ...model!,
    surfelCount: 1,
    surfels: new Float32Array([
      ...Array.from(model!.surfels),
      ...surfelSample({ x: 1, y: 0, z: -1, r: 0, g: 1, b: 0, weight: 1 }),
    ]),
  };
  const ply = serializeModelAsPly(withExtraBacking);
  const rows = ply.trimEnd().split('\n').slice(ply.split('\n').findIndex((line) => line === 'end_header') + 1);

  expect(ply).toContain('element vertex 1\n');
  expect(rows).toHaveLength(1);
});

test('formatFilesLocation reports the app Documents path shown to the user', () => {
  expect(formatFilesLocation('scan.ply', 1536)).toBe('Files: standard-camera-app/scan.ply (1.5 KB)');
});

test('makeModelViewProjection keeps a recentered model visible in WebGPU clip space', () => {
  const model = buildModel([
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0.5, b: 0, weight: 1 }),
  ], 1);

  expect(model).not.toBeNull();
  const viewProjection = makeModelViewProjection(model!, 0.75, 0, {
    distanceScale: 1,
    panX: 0,
    panY: 0,
    pitch: 0.34,
    yaw: 0,
  });
  const clip = projectPoint(viewProjection, [0, 0, -1]);

  expect(clip.w).toBeGreaterThan(0);
  expect(clip.x / clip.w).toBeGreaterThanOrEqual(-1);
  expect(clip.x / clip.w).toBeLessThanOrEqual(1);
  expect(clip.y / clip.w).toBeGreaterThanOrEqual(-1);
  expect(clip.y / clip.w).toBeLessThanOrEqual(1);
  expect(clip.z / clip.w).toBeGreaterThanOrEqual(0);
  expect(clip.z / clip.w).toBeLessThanOrEqual(1);
});

test('makeModelViewProjection frames partial scans around weighted surfel center', () => {
  const model = buildModel([
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0.5, b: 0, weight: 1 }),
    ...surfelSample({ x: 0.1, y: 0, z: -1, r: 1, g: 0.5, b: 0, weight: 1 }),
    ...surfelSample({ x: 8, y: 0, z: -1, r: 1, g: 0, b: 0.5, weight: 0.01 }),
  ], 1);

  expect(model).not.toBeNull();
  const viewProjection = makeModelViewProjection(model!, 0.75, 0, {
    distanceScale: 1,
    panX: 0,
    panY: 0,
    pitch: 0.34,
    yaw: 0,
  });
  const primarySurfaceClip = projectPoint(viewProjection, [0.05, 0, -1]);

  expect(Math.abs(primarySurfaceClip.x / primarySurfaceClip.w)).toBeLessThan(0.05);
});

test('makeModelViewProjectionInto reuses the caller uniform buffer', () => {
  const model = buildModel([
    ...surfelSample({ x: 0, y: 0, z: -1, r: 1, g: 0.5, b: 0, weight: 1 }),
    ...surfelSample({ x: 0.2, y: 0.1, z: -1.2, r: 0, g: 1, b: 0, weight: 1 }),
  ], 2);

  expect(model).not.toBeNull();
  const viewer = {
    distanceScale: 1.1,
    panX: 0.08,
    panY: -0.04,
    pitch: 0.28,
    yaw: 0.42,
  };
  const allocated = makeModelViewProjection(model!, 0.75, 0, viewer);
  const uniforms = new Float32Array(20);
  uniforms[16] = 123;

  const returned = makeModelViewProjectionInto(uniforms, model!, 0.75, 0, viewer);

  expect(returned).toBe(uniforms);
  expect(Array.from(uniforms.slice(0, 16))).toEqual(Array.from(allocated));
  expect(uniforms[16]).toBe(123);
});

test('viewerYawForForward frames a partial scan from the camera side', () => {
  expect(viewerYawForForward([0, 0, -1])).toBeCloseTo(0, 6);
  expect(viewerYawForForward([1, 0, 0])).toBeCloseTo(-Math.PI / 2, 6);
  expect(viewerYawForForward([0, 1, 0])).toBe(0);
});

test('invertMatrix4 round-trips a simple transform', () => {
  const matrix = new Float32Array(IDENTITY_4X4);
  matrix[12] = 3;
  matrix[13] = -2;
  matrix[14] = 1;
  const inverse = invertMatrix4(matrix);

  expect(inverse).not.toBeNull();
  expect(transformPoint(inverse!, transformPoint(matrix, [0.5, 0.25, -2]))).toEqual([0.5, 0.25, -2]);
});

function makeDepthInformation(values: Float32Array): PanoramicDepthInformation {
  return {
    data: exactArrayBuffer(values),
    height: 1,
    normDepthBufferFromNormView: { matrix: IDENTITY_4X4 },
    rawValueToMeters: 1,
    width: 1,
  };
}

function makeCameraImage(
  bytes: Uint8Array,
  format: PanoramicCameraImage['format'],
  width: number,
  height: number
): PanoramicCameraImage {
  return {
    data: exactArrayBuffer(bytes),
    format,
    height,
    normCameraImageFromNormView: { matrix: IDENTITY_4X4 },
    width,
  };
}

function exactArrayBuffer(view: Uint8Array | Float32Array): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

function projectionFromIntrinsics(
  width: number,
  height: number,
  fx: number,
  fy: number,
  cx: number,
  cy: number,
  near = 0.001,
  far = 100
): Float32Array {
  const zRange = far - near;
  const webXRCx = cx + 0.5;
  const webXRCy = cy + 0.5;
  return new Float32Array([
    2 * fx / width, 0, 0, 0,
    0, 2 * fy / height, 0, 0,
    1 - 2 * webXRCx / width, 2 * webXRCy / height - 1, -(far + near) / zRange, -1,
    0, 0, -(2 * far * near) / zRange, 0,
  ]);
}

function projectPoint(matrix: Float32Array, point: Vec3): { w: number; x: number; y: number; z: number } {
  return {
    x: matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    y: matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    z: matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
    w: matrix[3] * point[0] + matrix[7] * point[1] + matrix[11] * point[2] + matrix[15],
  };
}

function snapshot({ forward = [0, 0, -1], position = [0, 0, 0], time }: {
  forward?: Vec3;
  position?: Vec3;
  time: number;
}): KeyframeSnapshot {
  return { forward, position, time };
}

function acceptedRotationSweepYaws(durationMs: number): number[] {
  const stepMs = 100;
  const acceptedYaws: number[] = [];
  const acceptedForwards: Vec3[] = [];
  let coverageSectors = new Set<string>();
  let keyframes = 0;
  let last: KeyframeSnapshot | null = null;
  let scanForwardSum: Vec3 = [0, 0, 0];
  for (let time = 0; time <= durationMs; time += stepMs) {
    const yawDeg = 180 * time / durationMs;
    const forward = yawForward(yawDeg);
    const decision = shouldAcceptPanoramicKeyframe({
      existingSurfels: keyframes * MIN_KEYFRAME_SURFELS,
      forward,
      keyframes,
      last,
      position: [0, 0, 0],
      time,
    });
    if (!decision.accepted) continue;
    if (shouldSkipCoveredPanoramicSector({
      coverageSectors,
      forward,
      keyframes,
      scanForwardSum,
      translationM: decision.translationM,
    })) {
      continue;
    }
    acceptedYaws.push(Math.round(yawDeg));
    acceptedForwards.push(forward);
    keyframes += 1;
    last = snapshot({ forward, position: [0, 0, 0], time });
    scanForwardSum = [
      scanForwardSum[0] + forward[0],
      scanForwardSum[1] + forward[1],
      scanForwardSum[2] + forward[2],
    ];
    coverageSectors = panoramicCoverageSectors(acceptedForwards);
  }
  return acceptedYaws;
}

function yawForward(yawDeg: number): Vec3 {
  const yawRad = yawDeg * Math.PI / 180;
  return [Math.sin(yawRad), 0, -Math.cos(yawRad)];
}

function surfelSample({
  b,
  g,
  r,
  weight,
  x,
  y,
  z,
}: {
  b: number;
  g: number;
  r: number;
  weight: number;
  x: number;
  y: number;
  z: number;
}): number[] {
  return [
    x,
    y,
    z,
    1,
    r,
    g,
    b,
    weight,
    0,
    1,
    0,
    1,
  ];
}
