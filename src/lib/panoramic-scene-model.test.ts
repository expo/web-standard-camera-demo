import { expect, test } from 'bun:test';

import {
  appendDepthSurfels,
  appendSurfelsToFusion,
  buildModel,
  buildModelFromFusion,
  createSurfelFusionAccumulator,
  derivePanoramicCaptureControls,
  formatFilesLocation,
  invertMatrix4,
  makeModelViewProjection,
  MAX_KEYFRAMES,
  MAX_SURFELS,
  MIN_KEYFRAME_SURFELS,
  panoramicCoverageKey,
  panoramicCoveragePercent,
  sampleCameraColor,
  serializeModelAsPly,
  shouldAcceptPanoramicKeyframe,
  SURFEL_STRIDE_FLOATS,
  transformPoint,
  unprojectCameraIntrinsicsSample,
  unprojectViewSample,
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

test('unprojectCameraIntrinsicsSample maps ARKit captured-image pixels into WebXR camera axes', () => {
  const intrinsics = new Float32Array([
    100, 0, 0,
    0, 200, 0,
    320, 240, 1,
  ]);

  const center = unprojectCameraIntrinsicsSample(intrinsics, { width: 640, height: 480 }, 0.5, 0.5, 2);
  const upperLeft = unprojectCameraIntrinsicsSample(intrinsics, { width: 640, height: 480 }, 0, 0, 2);

  expect(center?.[0]).toBeCloseTo(0, 6);
  expect(center?.[1]).toBeCloseTo(0, 6);
  expect(center?.[2]).toBeCloseTo(-2, 6);
  expect(upperLeft?.[0]).toBeCloseTo(-6.4, 6);
  expect(upperLeft?.[1]).toBeCloseTo(2.4, 6);
  expect(upperLeft?.[2]).toBeCloseTo(-2, 6);
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
  const options = { pitchBins: 1, yawBins: 4 };
  const sectors = new Set([
    panoramicCoverageKey([0, 0, -1], options),
    panoramicCoverageKey([1, 0, 0], options),
    panoramicCoverageKey([0, 0, 1], options),
    panoramicCoverageKey([-1, 0, 0], options),
  ]);

  expect(sectors.size).toBe(4);
  expect(panoramicCoveragePercent(sectors, options)).toBe(100);
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
  const options = { pitchBins: 1, yawBins: 4 };
  const sectors = new Set([
    panoramicCoverageKey([0, 0, -1], options),
    panoramicCoverageKey([0.02, 0, -1], options),
  ]);

  expect(sectors.size).toBe(1);
  expect(panoramicCoveragePercent(sectors, options)).toBe(25);
});

test('derivePanoramicCaptureControls keeps preview scan-only and save capture-only', () => {
  expect(derivePanoramicCaptureControls({
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
    hasModel: true,
    liveSurfelCount: 128,
    saving: true,
    status: 'captured',
  }).canSave).toBe(false);

  expect(derivePanoramicCaptureControls({
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
