import { expect, test } from 'bun:test';

import {
  DEFAULT_VALIDATION_BUDGETS,
  buildDevelopmentClientUrl,
  isComplete,
  isValidMetric,
  metricSetValidationError,
  missingMetrics,
  panoramaBottleneckSummary,
  panoramaProfileReport,
  parseMetricLogText,
  recordMetricLine,
  validateRequiredMetricSet,
  type SeenMetrics,
} from './validate-panorama-ios';

test('panorama validator builds an automation-safe dev-client URL', () => {
  expect(buildDevelopmentClientUrl('http://192.168.1.181:8082')).toBe(
    'standardcameraapp://expo-development-client/?disableOnboarding=1&url=http%3A%2F%2F192.168.1.181%3A8082'
  );
});

test('panorama validator accepts a consistent capture/render/export telemetry set', () => {
  const seen = completeMetricSet();

  expect(isComplete(seen)).toBe(true);
  expect(missingMetrics(seen)).toEqual([]);
  expect(metricSetValidationError(seen)).toBeNull();
  expect(() => validateRequiredMetricSet(seen)).not.toThrow();
});

test('panorama validator rejects mismatched exported model metrics', () => {
  const seen = completeMetricSet({
    PANORAMIC_EXPORT_METRICS: { surfelCount: 41 },
  });

  expect(metricSetValidationError(seen)).toContain('Capture/export telemetry mismatch');
  expect(() => validateRequiredMetricSet(seen)).toThrow('Capture/export telemetry mismatch');
});

test('panorama validator rejects mismatched exported raw sample metrics', () => {
  const seen = completeMetricSet({
    PANORAMIC_EXPORT_METRICS: { rawSampleCount: 99 },
  });

  expect(metricSetValidationError(seen)).toContain('Capture/export telemetry mismatch: raw samples');
  expect(() => validateRequiredMetricSet(seen)).toThrow('Capture/export telemetry mismatch: raw samples');
});

test('panorama validator rejects mismatched uploaded model metrics', () => {
  const seen = completeMetricSet({
    PANORAMIC_MODEL_UPLOAD_PROFILE: { rawSampleCount: 99 },
  });

  expect(metricSetValidationError(seen)).toContain('Render/upload telemetry mismatch: raw samples');
  expect(() => validateRequiredMetricSet(seen)).toThrow('Render/upload telemetry mismatch: raw samples');
});

test('panorama validator rejects impossible uploaded raw sample counts', () => {
  expect(isValidMetric('PANORAMIC_MODEL_UPLOAD_PROFILE', {
    keyframes: 3,
    rawSampleCount: 40,
    surfelBytes: 2048,
    surfelCount: 42,
    uploadMs: 0.1,
  })).toBe(false);
});

test('panorama validator rejects mismatched keyframe fused surfel metrics', () => {
  const seen = completeMetricSet({
    PANORAMIC_KEYFRAME_PROFILE: { fusedSurfelCount: 41 },
  });

  expect(metricSetValidationError(seen)).toContain('Keyframe/capture telemetry mismatch: fused surfels');
  expect(() => validateRequiredMetricSet(seen)).toThrow('Keyframe/capture telemetry mismatch: fused surfels');
});

test('panorama validator rejects telemetry outside performance and quality budgets', () => {
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_KEYFRAME_PROFILE: { appendMs: DEFAULT_VALIDATION_BUDGETS.maxKeyframeAppendMs + 1 },
  }))).toContain('Keyframe append budget exceeded');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_KEYFRAME_PROFILE: {
      depthGridSamples: DEFAULT_VALIDATION_BUDGETS.maxKeyframeDepthGridSamples + 1,
    },
  }))).toContain('Keyframe depth-grid sample budget exceeded');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_KEYFRAME_PROFILE: { unprojectionMode: 'matrix-inverse' },
  }))).toContain('Keyframe unprojection fast path missed');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_KEYFRAME_PROFILE: { depthType: 'raw' },
  }))).toContain('Keyframe depth type was not smooth');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_KEYFRAME_PROFILE: { depthGridSampleMode: 'normalized-transform' },
  }))).toContain('Keyframe depth-grid fast path missed');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_KEYFRAME_PROFILE: { cameraSampleMode: 'normalized-transform' },
  }))).toContain('Keyframe camera-color fast path missed');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_CAPTURE_METRICS: { cameraColorPercent: DEFAULT_VALIDATION_BUDGETS.minCameraColorPercent - 1 },
  }))).toContain('Camera-color quality budget missed');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_CAPTURE_METRICS: { normalPercent: DEFAULT_VALIDATION_BUDGETS.minNormalPercent - 1 },
  }))).toContain('Normal quality budget missed');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_CAPTURE_METRICS: {
      multiObservationPercent: DEFAULT_VALIDATION_BUDGETS.minMultiObservationPercent - 1,
    },
  }))).toContain('Stable-surface quality budget missed');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_CAPTURE_METRICS: { boundsMeters: [0, 0, 0.01] },
  }))).toContain('Scene bounds quality budget missed');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_PREVIEW_METRICS: { buildMs: DEFAULT_VALIDATION_BUDGETS.maxPreviewBuildMs + 1 },
  }))).toContain('Preview build budget exceeded');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_PREVIEW_METRICS: { cameraColorPercent: DEFAULT_VALIDATION_BUDGETS.minCameraColorPercent - 1 },
  }))).toContain('Preview camera-color quality budget missed');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_PREVIEW_METRICS: { normalPercent: DEFAULT_VALIDATION_BUDGETS.minNormalPercent - 1 },
  }))).toContain('Preview normal quality budget missed');
  expect(metricSetValidationError(completeMetricSet({
    PANORAMIC_SCAN_STATS: {
      acceptedKeyframes: 3,
      coveragePercent: DEFAULT_VALIDATION_BUDGETS.minScanCoveragePercent - 1,
      elapsedMs: 1000,
      frameCount: 30,
    },
  }))).toContain('Scan coverage budget missed');
});

test('panorama validator accepts custom performance budgets', () => {
  const seen = completeMetricSet({
    PANORAMIC_KEYFRAME_PROFILE: { appendMs: DEFAULT_VALIDATION_BUDGETS.maxKeyframeAppendMs + 20 },
  });

  expect(metricSetValidationError(seen, {
    ...DEFAULT_VALIDATION_BUDGETS,
    maxKeyframeAppendMs: DEFAULT_VALIDATION_BUDGETS.maxKeyframeAppendMs + 20,
  })).toBeNull();
});

test('panorama validator requires Files-visible PLY export metadata', () => {
  expect(isValidMetric('PANORAMIC_EXPORT_METRICS', {
    bytes: 1024,
    filename: 'scene.ply',
    filesVisiblePath: 'standard-camera-app/scene.ply',
    keyframes: 3,
    rawSampleCount: 100,
    surfelCount: 42,
    uri: 'file:///Documents/scene.ply',
  })).toBe(true);
  expect(isValidMetric('PANORAMIC_EXPORT_METRICS', {
    bytes: 1024,
    filename: 'scene.ply',
    filesVisiblePath: 'standard-camera-app/scene.ply',
    keyframes: 3,
    rawSampleCount: 40,
    surfelCount: 42,
    uri: 'file:///Documents/scene.ply',
  })).toBe(false);
  expect(isValidMetric('PANORAMIC_EXPORT_METRICS', {
    bytes: 1024,
    filename: 'scene.ply',
    filesVisiblePath: 'wrong/scene.ply',
    keyframes: 3,
    surfelCount: 42,
    uri: 'file:///Documents/scene.ply',
  })).toBe(false);
});

test('panorama validator records only valid required metrics from log lines', () => {
  const seen: SeenMetrics = {};

  recordMetricLine('noise PANORAMIC_CAPTURE_METRICS {"keyframes":3,"surfelCount":42,"rawSampleCount":100,"cameraColorPercent":85,"boundsMeters":[1,2,0.2]}', seen);
  recordMetricLine('noise PANORAMIC_EXPORT_METRICS {"keyframes":3,"surfelCount":42,"bytes":1024,"filename":"scene.ply","filesVisiblePath":"wrong/scene.ply","uri":"file:///Documents/scene.ply"}', seen);

  expect(seen.PANORAMIC_CAPTURE_METRICS?.surfelCount).toBe(42);
  expect(seen.PANORAMIC_EXPORT_METRICS).toBeUndefined();
});

test('panorama validator reports scan configuration used for profile-only isolation runs', () => {
  const seen = parseMetricLogText(`
    PANORAMIC_SCAN_CONFIG {"depthPreference":"raw","depthTypeRequest":["raw","smooth"],"meshRequested":false,"sessionDepthType":"raw"}
  `);

  expect(seen.PANORAMIC_SCAN_CONFIG).toMatchObject({
    depthPreference: 'raw',
    meshRequested: false,
    sessionDepthType: 'raw',
  });
  expect(panoramaBottleneckSummary(seen)).toContain(
    'Scan config: depth preference raw, request [raw,smooth], session depth raw, mesh off'
  );
});

test('panorama validator parses copied log text for offline profiling', () => {
  const seen = parseMetricLogText(`
 LOG PANORAMIC_KEYFRAME_PROFILE {"appendMs":31.68,"cameraColorPercent":100,"fusedSurfelCount":9388,"keyframes":23,"rawSampleCount":12866,"retainedSamples":12866,"surfelCount":830}
 noise
 LOG PANORAMIC_LIVE_MODEL_PROFILE {"buildMs":14.95,"intervalMs":1600,"keyframes":23,"reason":"stale","rawSampleCount":12866,"surfelCount":9388}
 LOG PANORAMIC_MODEL_UPLOAD_PROFILE {"allocated":false,"capacityBytes":262144,"keyframes":23,"modelRevision":12,"rawSampleCount":12866,"surfelBytes":450624,"surfelCount":9388,"uploadMs":0.08}
 LOG PANORAMIC_XR_POSE_PROFILE {"frameNumber":42,"returnedPose":false,"trackingState":"limited","worldMappingStatus":"limited"}
  `);

  expect(seen.PANORAMIC_KEYFRAME_PROFILE).toMatchObject({
    appendMs: 31.68,
    cameraColorPercent: 100,
    fusedSurfelCount: 9388,
    keyframes: 23,
    rawSampleCount: 12866,
    retainedSamples: 12866,
  });
  expect(seen.PANORAMIC_LIVE_MODEL_PROFILE).toMatchObject({
    buildMs: 14.95,
    rawSampleCount: 12866,
    surfelCount: 9388,
  });
  expect(seen.PANORAMIC_MODEL_UPLOAD_PROFILE).toMatchObject({
    keyframes: 23,
    modelRevision: 12,
    rawSampleCount: 12866,
    uploadMs: 0.08,
  });
  expect(seen.PANORAMIC_XR_POSE_PROFILE).toMatchObject({
    frameNumber: 42,
    returnedPose: false,
    trackingState: 'limited',
    worldMappingStatus: 'limited',
  });
});

test('panorama validator keeps the latest scan id from copied multi-run logs', () => {
  const seen = parseMetricLogText(`
 LOG PANORAMIC_CAPTURE_METRICS {"boundsMeters":[2,1,1],"cameraColorPercent":85,"keyframes":12,"rawSampleCount":1200,"scanId":1,"surfelCount":900}
 LOG PANORAMIC_SCAN_CONFIG {"depthPreference":"smooth","depthTypeRequest":["smooth","raw"],"meshRequested":true,"scanId":2,"sessionDepthType":"smooth"}
 LOG PANORAMIC_CAPTURE_METRICS {"boundsMeters":[2,1,1],"cameraColorPercent":85,"keyframes":12,"rawSampleCount":1200,"scanId":1,"surfelCount":900}
 LOG PANORAMIC_KEYFRAME_PROFILE {"appendMs":12,"cameraColorPercent":90,"fusedSurfelCount":40,"keyframes":1,"rawSampleCount":40,"retainedSamples":40,"scanId":2,"surfelCount":40}
 LOG PANORAMIC_CAPTURE_METRICS {"boundsMeters":[0.2,0.1,0.1],"cameraColorPercent":90,"keyframes":1,"rawSampleCount":40,"scanId":2,"surfelCount":40}
  `);

  expect(seen.PANORAMIC_SCAN_CONFIG?.scanId).toBe(2);
  expect(seen.PANORAMIC_KEYFRAME_PROFILE?.scanId).toBe(2);
  expect(seen.PANORAMIC_CAPTURE_METRICS).toMatchObject({
    keyframes: 1,
    rawSampleCount: 40,
    scanId: 2,
    surfelCount: 40,
  });
});

test('panorama validator keeps worst repeated timing while preserving latest counts', () => {
  const seen: SeenMetrics = {};

  recordMetricLine('PANORAMIC_KEYFRAME_PROFILE {"appendMs":180,"cameraColorPercent":90,"cameraPointCacheHits":10,"cameraPointSamples":80,"cameraRequested":true,"cameraSampleMode":"normalized-transform","cameraTransformMode":"projective","centerCameraMeters":[0.1,0.2,-1.5],"centerDepthMeters":1.5,"centerDepthValid":true,"centerWorldMeters":[1.1,0.2,-1.5],"colorSampleMs":2,"depthAppendMs":171,"depthCacheReused":false,"depthGridSampleMode":"normalized-transform","depthGridSamples":3000,"depthInitialAppendMs":171,"depthLookupMs":3,"depthRecoveryAppendMs":0,"depthRecoverySkipped":true,"depthTransformMode":"projective","depthType":"smooth","keyframes":1,"meshAppendMs":9,"meshCameraColoredSurfels":8,"meshCameraColorPercent":80,"meshCameraImageMs":1,"meshCameraRequested":true,"meshCount":1,"meshFetchMs":15,"meshMaxSurfels":400,"meshNewVoxelCount":5,"meshPlaneProjectedSamples":2,"meshPoseMisses":0,"meshPreflightMs":0,"meshPreflightNewVoxelCount":6,"meshPreflightSurfelCount":14,"meshProjectedSurfels":13,"meshRecoveredDepthGate":false,"meshSampleStride":2,"meshSkippedSurfels":1,"meshSurfelCount":12,"meshTriangles":120,"meshUpdatedVoxelCount":7,"meshVertices":160,"newVoxelCount":32,"newVoxelPercent":80,"normalEstimateMs":4,"observedDepthSurfels":48,"planeProjectedSamples":3,"profiledSampleCount":40,"retainedSamples":40,"sampleConsumeMs":5,"sampleLoopMs":30,"surfelCount":40,"timedSampleCount":5,"timingSampleStride":8,"unprojectMs":6,"unprojectionMode":"matrix-inverse","updatedVoxelCount":8}', seen);
  recordMetricLine('PANORAMIC_KEYFRAME_PROFILE {"appendMs":12,"cameraColorPercent":70,"cameraPointCacheHits":120,"cameraPointSamples":1200,"cameraRequested":false,"cameraSampleMode":"precomputed-axis","cameraTransformMode":"identity","colorSampleMs":1,"depthAppendMs":10,"depthCacheReused":true,"depthGridSampleMode":"precomputed-identity","depthGridSamples":1200,"depthInitialAppendMs":6,"depthLookupMs":2,"depthRecoveryAppendMs":3,"depthRecoverySkipped":false,"depthTransformMode":"identity","depthType":"smooth","keyframes":3,"meshAppendMs":12,"meshCameraColoredSurfels":4,"meshCameraColorPercent":57.1,"meshCameraImageMs":2,"meshCameraRequested":false,"meshCount":2,"meshFetchMs":7,"meshMaxSurfels":400,"meshNewVoxelCount":3,"meshPlaneProjectedSamples":5,"meshPoseMisses":1,"meshPreflightMs":1,"meshPreflightNewVoxelCount":4,"meshPreflightSurfelCount":10,"meshProjectedSurfels":9,"meshRecoveredDepthGate":true,"meshSampleStride":3,"meshSkippedSurfels":2,"meshSurfelCount":7,"meshTriangles":240,"meshUpdatedVoxelCount":4,"meshVertices":280,"newVoxelCount":4,"newVoxelPercent":11.8,"normalEstimateMs":3,"observedDepthSurfels":120,"planeProjectedSamples":11,"profiledSampleCount":34,"retainedSamples":100,"sampleConsumeMs":4,"sampleLoopMs":20,"surfelCount":34,"timedSampleCount":6,"timingSampleStride":8,"unprojectMs":5,"unprojectionMode":"intrinsics-projection","updatedVoxelCount":30}', seen);
  recordMetricLine('PANORAMIC_LIVE_MODEL_PROFILE {"buildMs":900,"intervalMs":900,"keyframes":1,"multiObservationPercent":70,"reason":"new-keyframe","rawSampleCount":40,"surfelCount":35}', seen);
  recordMetricLine('PANORAMIC_LIVE_MODEL_PROFILE {"buildMs":40,"intervalMs":1600,"keyframes":3,"multiObservationPercent":55,"reason":"interval","rawSampleCount":100,"surfelCount":42}', seen);
  recordMetricLine('PANORAMIC_MODEL_UPLOAD_PROFILE {"allocated":true,"capacityBytes":262144,"keyframes":1,"modelRevision":1,"rawSampleCount":40,"surfelBytes":1024,"surfelCount":20,"uploadMs":95}', seen);
  recordMetricLine('PANORAMIC_MODEL_UPLOAD_PROFILE {"allocated":false,"capacityBytes":262144,"keyframes":3,"modelRevision":2,"rawSampleCount":100,"surfelBytes":2048,"surfelCount":42,"uploadMs":5}', seen);
  recordMetricLine('PANORAMIC_NATIVE_PAYLOAD_PROFILE {"cameraCapturedSize":[1920,1440],"cameraPreviewMs":12,"cameraPreviewPath":"ycbcr-direct","depthCopyMs":0,"depthSize":[256,192],"depthToCameraScale":[0.1333,0.1333],"frameNumber":1,"includeCameraImage":true,"includeDepthData":false,"payloadMs":13,"projectionCameraImageResolution":[1920,1440],"projectionDepthToCameraScale":[0.1333,0.1333],"requestMs":20}', seen);
  recordMetricLine('PANORAMIC_NATIVE_PAYLOAD_PROFILE {"cameraPreviewMs":2,"confidenceFilteredDepthCount":2000,"confidenceFilteredPercent":4,"confidenceMapUsed":true,"confidenceThreshold":1,"depthCopyMs":8,"depthMaxMeters":3.2,"depthMeanMeters":1.4,"depthMinMeters":0.45,"depthPixelCount":49152,"depthType":"smooth","frameNumber":2,"highConfidenceDepthCount":20000,"includeCameraImage":false,"includeDepthData":true,"invalidDepthPercent":4,"lowConfidencePercent":4,"mediumConfidenceDepthCount":24000,"payloadMs":9,"requestMs":10,"validDepthPercent":96}', seen);
  recordMetricLine('PANORAMIC_NATIVE_PAYLOAD_PROFILE {"cameraPreviewMs":20,"cameraPreviewPath":"ycbcr-direct","cameraCapturedSize":[1920,1440],"depthSize":[256,192],"depthToCameraScale":[0.1333,0.1333],"frameNumber":3,"includeCameraImage":true,"includeDepthData":false,"payloadMs":25,"requestMs":30}', seen);
  recordMetricLine('PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE {"cachedMeshCount":1,"copiedMeshCount":1,"decimatedMeshCount":1,"frameNumber":3,"indexBytes":2880,"indexCount":720,"meshBytes":9120,"meshCount":2,"normalBytes":2880,"normalCount":240,"requestMs":18,"sourceIndexCount":2160,"sourceTriangleCount":720,"sourceVertexCount":840,"triangleCount":240,"vertexBytes":3360,"vertexCount":280}', seen);
  recordMetricLine('PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE {"cachedMeshCount":2,"copiedMeshCount":1,"decimatedMeshCount":2,"frameNumber":4,"indexBytes":5760,"indexCount":1440,"meshBytes":18240,"meshCount":3,"normalBytes":5760,"normalCount":480,"requestMs":9,"sourceIndexCount":4320,"sourceTriangleCount":1440,"sourceVertexCount":1680,"triangleCount":480,"vertexBytes":6720,"vertexCount":560}', seen);
  recordMetricLine('PANORAMIC_PREVIEW_METRICS {"buildMs":240,"cameraColorPercent":92,"keyframes":1,"multiObservationPercent":80,"normalPercent":66,"rawSampleCount":40,"surfelCount":35}', seen);
  recordMetricLine('PANORAMIC_PREVIEW_METRICS {"buildMs":20,"cameraColorPercent":75,"keyframes":3,"multiObservationPercent":52,"normalPercent":61,"rawSampleCount":100,"surfelCount":42}', seen);
  recordMetricLine('PANORAMIC_RENDER_FRAME_PROFILE {"canvasHeight":1280,"canvasWidth":960,"commandEncodeMs":11,"keyframes":1,"modelRevision":1,"presentationFormat":"bgra8unorm","rawSampleCount":40,"reason":"model-change","renderFrameMs":18,"status":"scanning","submitPresentMs":4,"surfelCount":35,"viewMode":"Color"}', seen);
  recordMetricLine('PANORAMIC_RENDER_FRAME_PROFILE {"canvasHeight":1280,"canvasWidth":960,"commandEncodeMs":2,"keyframes":3,"modelRevision":2,"presentationFormat":"bgra8unorm","rawSampleCount":100,"reason":"gesture","renderFrameMs":9,"status":"scanning","submitPresentMs":1,"surfelCount":42,"viewMode":"Color"}', seen);
  recordMetricLine('PANORAMIC_SCAN_STATS {"acceptedKeyframes":3,"elapsedMs":1000,"frameCount":30,"poseMisses":1,"depthMisses":2,"rejectedByReason":{"too-similar":4}}', seen);
  recordMetricLine('PANORAMIC_KEYFRAME_REJECTION_PROFILE {"reason":"too-few-surfels","frameCount":18,"keyframes":1,"retainedSamples":42,"observedDepthSurfels":12,"combinedPreflightSurfels":18,"translationM":0.11,"rotationDeg":7.5}', seen);
  recordMetricLine('PANORAMIC_XR_POSE_PROFILE {"frameNumber":41,"returnedPose":false,"trackingState":"limited","worldMappingStatus":"limited"}', seen);
  recordMetricLine('PANORAMIC_CAPTURE_GEOMETRY {"boundsMeters":[1,2,3],"keyframes":3,"rawSampleCount":100,"surfelCount":42}', seen);

  expect(seen.PANORAMIC_KEYFRAME_PROFILE).toMatchObject({
    appendMs: 180,
    cameraColorPercent: 70,
    cameraPointCacheHits: 120,
    cameraPointSamples: 1200,
    cameraRequested: true,
    cameraSampleMode: 'normalized-transform',
    cameraTransformMode: 'projective',
    centerCameraMeters: [0.1, 0.2, -1.5],
    centerDepthMeters: 1.5,
    centerDepthValid: true,
    centerWorldMeters: [1.1, 0.2, -1.5],
    colorSampleMs: 2,
    depthAppendMs: 171,
    depthCacheReused: true,
    depthGridSampleMode: 'normalized-transform',
    depthGridSamples: 3000,
    depthInitialAppendMs: 171,
    depthLookupMs: 3,
    depthRecoveryAppendMs: 3,
    depthRecoverySkipped: true,
    depthTransformMode: 'projective',
    depthType: 'smooth',
    keyframes: 3,
    meshAppendMs: 12,
    meshCameraColoredSurfels: 8,
    meshCameraColorPercent: 57.1,
    meshCameraImageMs: 2,
    meshCameraRequested: true,
    meshCount: 2,
    meshFetchMs: 15,
    meshMaxSurfels: 400,
    meshNewVoxelCount: 5,
    meshPlaneProjectedSamples: 5,
    meshPoseMisses: 1,
    meshPreflightMs: 1,
    meshPreflightNewVoxelCount: 6,
    meshPreflightSurfelCount: 14,
    meshProjectedSurfels: 13,
    meshRecoveredDepthGate: true,
    meshSampleStride: 3,
    meshSkippedSurfels: 2,
    meshSurfelCount: 12,
    meshTriangles: 240,
    meshUpdatedVoxelCount: 7,
    meshVertices: 280,
    newVoxelCount: 4,
    newVoxelPercent: 11.8,
    normalEstimateMs: 4,
    observedDepthSurfels: 120,
    planeProjectedSamples: 11,
    profiledSampleCount: 40,
    retainedSamples: 100,
    sampleConsumeMs: 5,
    sampleLoopMs: 30,
    surfelCount: 34,
    timedSampleCount: 6,
    timingSampleStride: 8,
    unprojectMs: 6,
    unprojectionMode: 'matrix-inverse',
    updatedVoxelCount: 30,
  });
  expect(seen.PANORAMIC_LIVE_MODEL_PROFILE).toMatchObject({
    buildMs: 900,
    keyframes: 3,
    multiObservationPercent: 55,
    rawSampleCount: 100,
    surfelCount: 42,
  });
  expect(seen.PANORAMIC_MODEL_UPLOAD_PROFILE).toMatchObject({
    keyframes: 3,
    modelRevision: 2,
    rawSampleCount: 100,
    surfelBytes: 2048,
    surfelCount: 42,
    uploadMs: 95,
  });
  expect(seen.PANORAMIC_NATIVE_PAYLOAD_PROFILE).toMatchObject({
    cameraPreviewMs: 20,
    cameraCapturedSize: [1920, 1440],
    confidenceFilteredDepthCount: 2000,
    confidenceFilteredPercent: 4,
    confidenceMapUsed: true,
    confidenceThreshold: 1,
    depthCopyMs: 8,
    depthMaxMeters: 3.2,
    depthMeanMeters: 1.4,
    depthMinMeters: 0.45,
    depthPixelCount: 49152,
    depthSize: [256, 192],
    depthToCameraScale: [0.1333, 0.1333],
    depthType: 'smooth',
    frameNumber: 3,
    highConfidenceDepthCount: 20000,
    includeCameraImage: true,
    includeDepthData: true,
    invalidDepthPercent: 4,
    lowConfidencePercent: 4,
    mediumConfidenceDepthCount: 24000,
    payloadMs: 25,
    requestMs: 30,
    validDepthPercent: 96,
  });
  expect(seen.PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE).toMatchObject({
    cachedMeshCount: 2,
    copiedMeshCount: 1,
    decimatedMeshCount: 2,
    frameNumber: 4,
    indexBytes: 5760,
    indexCount: 1440,
    meshBytes: 18240,
    meshCount: 3,
    normalBytes: 5760,
    normalCount: 480,
    requestMs: 18,
    sourceIndexCount: 4320,
    sourceTriangleCount: 1440,
    sourceVertexCount: 1680,
    triangleCount: 480,
    vertexBytes: 6720,
    vertexCount: 560,
  });
  expect(seen.PANORAMIC_PREVIEW_METRICS).toMatchObject({
    buildMs: 240,
    cameraColorPercent: 75,
    keyframes: 3,
    multiObservationPercent: 52,
    normalPercent: 61,
    rawSampleCount: 100,
    surfelCount: 42,
  });
  expect(seen.PANORAMIC_RENDER_FRAME_PROFILE).toMatchObject({
    commandEncodeMs: 11,
    keyframes: 3,
    modelRevision: 2,
    rawSampleCount: 100,
    reason: 'gesture',
    renderFrameMs: 18,
    status: 'scanning',
    submitPresentMs: 4,
    surfelCount: 42,
  });
  expect(seen.PANORAMIC_SCAN_STATS).toMatchObject({
    acceptedKeyframes: 3,
    frameCount: 30,
  });
  expect(seen.PANORAMIC_KEYFRAME_REJECTION_PROFILE).toMatchObject({
    combinedPreflightSurfels: 18,
    keyframes: 1,
    observedDepthSurfels: 12,
    reason: 'too-few-surfels',
  });
  expect(seen.PANORAMIC_CAPTURE_GEOMETRY).toMatchObject({
    boundsMeters: [1, 2, 3],
    keyframes: 3,
  });
});

test('panorama validator summarizes likely bottlenecks and quality context', () => {
  const seen = completeMetricSet({
    PANORAMIC_KEYFRAME_PROFILE: {
      appendMs: 180,
      cameraSampleMode: 'normalized-transform',
      depthAppendMs: 110,
      depthGridSampleMode: 'normalized-transform',
      depthInitialAppendMs: 50,
      depthRecoveryAppendMs: 42,
      depthRecoverySkipped: true,
      depthType: 'smooth',
      meshAppendMs: 70,
      meshFetchMs: 15,
      meshCameraImageMs: 14,
      meshAppendReason: 'unchanged-mesh',
      meshAppendSkipped: true,
      meshNewVoxelCount: 6,
      meshNormalCount: 2,
      meshNormalMode: 'face',
      meshPlaneProjectedSamples: 4,
      meshPreflightEarlyStopped: true,
      meshPreflightMs: 18,
      meshPreflightNewVoxelCount: 6,
      meshPreflightStrideSkippedCandidates: 5,
      meshPreflightSurfelCount: 14,
      meshProjectedSurfels: 14,
      meshRecoveredDepthGate: true,
      meshSkippedSurfels: 2,
      meshStrideSkippedCandidates: 9,
      meshSurfelCount: 12,
      matureVoxelSkips: 18,
      normalEstimateMs: 4,
      newVoxelCount: 6,
      newVoxelPercent: 14.3,
      observedDepthSurfels: 104,
      planeProjectedSamples: 7,
      profiledSampleCount: 40,
      projectionFocalPixels: [210, 208],
      projectionPrincipalPixel: [119, 101],
      sampleLoopMs: 30,
      surfelCount: 34,
      timedSampleCount: 5,
      timingSampleStride: 8,
      updatedVoxelCount: 28,
      unprojectionMode: 'matrix-inverse',
      unprojectMs: 6,
    },
    PANORAMIC_LIVE_MODEL_PROFILE: {
      buildMs: 900,
      intervalMs: 900,
      keyframes: 3,
      rawSampleCount: 100,
      surfelCount: 42,
    },
    PANORAMIC_MODEL_UPLOAD_PROFILE: {
      allocated: true,
      capacityBytes: 262144,
      keyframes: 3,
      modelRevision: 2,
      rawSampleCount: 100,
      surfelBytes: 2048,
      surfelCount: 42,
      uploadMs: 95,
    },
    PANORAMIC_MESH_PROFILE: {
      frameNumber: 12,
      indexCount: 720,
      meshCount: 2,
      normalCount: 240,
      triangleCount: 240,
      vertexCount: 280,
    },
    PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE: {
      cachedMeshCount: 1,
      copiedMeshCount: 1,
      decimatedMeshCount: 1,
      frameNumber: 12,
      indexBytes: 2880,
      indexCount: 720,
      meshBytes: 9120,
      meshCount: 2,
      normalBytes: 2880,
      normalCount: 240,
      requestMs: 12,
      sourceIndexCount: 2160,
      sourceTriangleCount: 720,
      sourceVertexCount: 840,
      triangleCount: 240,
      vertexBytes: 3360,
      vertexCount: 280,
    },
    PANORAMIC_RENDER_FRAME_PROFILE: {
      canvasHeight: 1280,
      canvasWidth: 960,
      commandEncodeMs: 22,
      keyframes: 3,
      modelRevision: 6,
      presentationFormat: 'bgra8unorm',
      rawSampleCount: 100,
      reason: 'gesture',
      renderFrameMs: 125,
      status: 'captured',
      submitPresentMs: 9,
      surfelCount: 42,
      viewMode: 'Color',
    },
    PANORAMIC_NATIVE_PAYLOAD_PROFILE: {
      confidenceMapUsed: true,
      confidenceFilteredPercent: 4,
      confidenceThreshold: 1,
      cameraCapturedSize: [1920, 1440],
      cameraPreviewPath: 'ycbcr-direct',
      depthCopyMs: 8,
      depthMaxMeters: 3.2,
      depthMeanMeters: 1.4,
      depthMinMeters: 0.45,
      depthPixelCount: 49152,
      depthSize: [256, 192],
      depthToCameraScale: [0.1333, 0.1333],
      frameNumber: 2,
      includeDepthData: true,
      invalidDepthPercent: 4,
      lowConfidencePercent: 4,
      payloadMs: 9,
      projectionCameraImageResolution: [1920, 1440],
      projectionDepthToCameraScale: [0.1333, 0.1333],
      requestMs: 20,
      validDepthPercent: 96,
    },
    PANORAMIC_PREVIEW_METRICS: {
      buildMs: 240,
      cameraColorPercent: 75,
      keyframes: 3,
      normalPercent: 61,
      rawSampleCount: 100,
      surfelCount: 42,
    },
    PANORAMIC_CAPTURE_GEOMETRY: {
      boundsMeters: [1, 2, 3],
      keyframes: 3,
      normalCoherencePercent: 92,
      normalProjectedRmsMeters: 0.014,
      normalProjectedSpanMeters: 0.05,
      rawSampleCount: 100,
      surfelCount: 42,
    },
    PANORAMIC_SCAN_STATS: {
      acceptedKeyframes: 3,
      acceptedKeyframeFps: 3,
      avgAppendMs: 60,
      avgDepthInfoMs: 1.2,
      avgLivePublishMs: 12,
      avgPoseMs: 0.4,
      coveragePercent: 44.4,
      depthMisses: 2,
      depthPrecheckSkips: 20,
      elapsedMs: 1000,
      frameCount: 30,
      maxAppendMs: 60,
      newVoxelCount: 48,
      newVoxelPercent: 48,
      poseMisses: 1,
      rejectedByReason: {
        'too-fast': 3,
        'too-similar': 9,
        'too-soon': 15,
      },
      retainedSamples: 100,
      scanFps: 30,
      updatedVoxelCount: 52,
    },
    PANORAMIC_XR_POSE_PROFILE: {
      frameNumber: 88,
      returnedPose: false,
      trackingState: 'limited',
      worldMappingStatus: 'limited',
    },
    PANORAMIC_KEYFRAME_REJECTION_PROFILE: {
      combinedPreflightSurfels: 18,
      frameCount: 18,
      keyframes: 1,
      observedDepthSurfels: 12,
      reason: 'too-few-surfels',
      retainedSamples: 42,
      rotationDeg: 7.5,
      translationM: 0.11,
    },
  });

  const summary = panoramaBottleneckSummary(seen, 9);

  expect(summary[0]).toContain('live model build 900ms');
  expect(summary[0]).toContain('preview build 240ms');
  expect(summary[0]).toContain('keyframe append 180ms');
  expect(summary[0]).toContain('WebGPU render frame 125ms');
  expect(summary[0]).toContain('depth append segment 110ms');
  expect(summary[0]).toContain('WebGPU upload 95ms');
  expect(summary[0]).toContain('mesh append 70ms');
  expect(summary[0]).toContain('max keyframe append 60ms');
  expect(summary[0]).toContain('initial depth append 50ms');
  expect(summary).toContain(
    'Fast paths: unprojection matrix-inverse, depth grid normalized-transform, camera color normalized-transform'
  );
  expect(summary).toContain('Depth mode: smooth');
  expect(summary).toContain('Keyframe sample loop: 30ms of 180ms append, 40 profiled samples, timed 5 at stride 8');
  expect(summary).toContain(
    'Keyframe fusion contribution: 14.3% new voxels, 104 observed depth surfels, 6 new / 28 updated, 7 plane-projected samples, 18 mature overlap skipped'
  );
  expect(summary).toContain(
    'Keyframe mesh supplement: 12 fused surfels, 14 projected, 2 skipped, 9 stride candidates skipped, 4 plane-projected samples, 6 new voxels, normals face (2), preflight 14 surfels / 6 new voxels, 5 preflight stride candidates skipped, early stop yes, depth gate recovered yes'
  );
  expect(summary).toContain(
    'Model chain: capture 3kf/100raw/42surfels; render 3kf/100raw/42surfels; upload 3kf/100raw/42surfels; export 3kf/100raw/42surfels; all present stages match'
  );
  expect(summary).toContain('Keyframe mesh fetch: 15ms');
  expect(summary).toContain('Keyframe mesh append skipped: unchanged-mesh');
  expect(summary).toContain('Keyframe gate recovery: initial depth 50ms, mesh preflight 18ms, depth recovery 42ms');
  expect(summary).toContain('Keyframe depth recovery append skipped because mesh geometry carried the keyframe');
  expect(summary).toContain('Projection pixels: focal 210x208, principal 119,101');
  expect(summary).toContain('Capture quality: camera color 80%, normals 65%, stable 60%, fusion 42%, largest bound 1.1m');
  expect(summary).toContain(
    'Depth payload: valid 96%, invalid 4%, low confidence 4%, confidence-filtered 4%, confidence map yes, fallback no'
  );
  expect(summary).toContain('Depth range: min 0.45m, mean 1.4m, max 3.2m');
  expect(summary).toContain('Native geometry: depth 256x192, captured 1920x1440, depth/camera scale 0.1333x0.1333');
  expect(summary).toContain('Native camera preview path: ycbcr-direct');
  expect(summary).toContain(
    'Native projection basis: camera image 1920x1440, depth/projection scale 0.1333x0.1333'
  );
  expect(summary).toContain('Geometry: normal-projected span 0.05m, rms 0.014m, normal coherence 92%');
  expect(summary).toContain('AR mesh: 2 anchors, 280 vertices, 240 triangles');
  expect(summary).toContain('Native mesh payload: 2 meshes, 280 vertices, 240 triangles from 720 source triangles, 1 decimated, 240 normals, 9120 bytes, 1 cached / 1 copied');
  expect(summary).toContain(
    'Scan loop: 3/30 frames accepted, coverage 44.4%, scan 30 fps, accepted 3 fps, new voxels 48%, retained 100 samples, avg pose 0.4ms, avg depth 1.2ms, avg append 60ms'
  );
  expect(summary).toContain('Scan misses: pose 1, depth 2, precheck skips 20, rejected too-soon 15, too-similar 9, too-fast 3');
  expect(summary).toContain('Viewer pose unavailable: tracking limited, world mapping limited, frame 88');
  expect(summary).toContain(
    'Keyframe rejection: too-few-surfels, 1 keyframes, frame 18, retained 42 samples, translation 0.11m, rotation 7.5deg, observed depth 12, depth+mesh 18'
  );
});

test('panorama validator summarizes model chain mismatches for profile-only logs', () => {
  const summary = panoramaBottleneckSummary(completeMetricSet({
    PANORAMIC_MODEL_UPLOAD_PROFILE: {
      keyframes: 1,
      rawSampleCount: 40,
      surfelCount: 20,
    },
  }));

  expect(summary).toContain(
    'Model chain: capture 3kf/100raw/42surfels; render 3kf/100raw/42surfels; upload 1kf/40raw/20surfels; export 3kf/100raw/42surfels; mismatch upload keyframes 1 vs capture 3, upload raw 40 vs capture 100, upload surfels 20 vs capture 42'
  );
});

test('panorama validator builds a durable profiling report payload', () => {
  const seen = completeMetricSet({
    PANORAMIC_LIVE_MODEL_PROFILE: {
      buildMs: 64,
      intervalMs: 320,
      keyframes: 3,
      rawSampleCount: 100,
      surfelCount: 42,
    },
  });

  const report = panoramaProfileReport(seen, {
    generatedAt: '2026-05-27T12:00:00.000Z',
    validated: false,
  });

  expect(report).toMatchObject({
    generatedAt: '2026-05-27T12:00:00.000Z',
    metrics: seen,
    missingRequiredMetrics: [],
    validated: false,
  });
  expect(report.bottleneckSummary.join('\n')).toContain('live model build 64ms');
});

test('panorama validator surfaces scan loop callback errors', () => {
  const seen = {
    PANORAMIC_KEYFRAME_REJECTION_PROFILE: {
      errorMessage: 'undefined is not a function',
      errorName: 'TypeError',
      frameCount: 2,
      keyframes: 1,
      reason: 'scan-loop-error',
      retainedSamples: 781,
      rotationDeg: 0,
      translationM: 0,
    },
  } satisfies SeenMetrics;

  const summary = panoramaBottleneckSummary(seen);

  expect(summary).toContain(
    'Keyframe rejection: scan-loop-error, 1 keyframes, frame 2, retained 781 samples, translation 0m, rotation 0deg, error TypeError: undefined is not a function'
  );
  expect(summary).toContain(
    'First-frame diagnosis: scan loop callback threw after 1 keyframe(s): TypeError: undefined is not a function'
  );
});

test('panorama validator identifies optional WebXR mesh bridge failures behind one-frame scans', () => {
  const seen = parseMetricLogText(`
    LOG PANORAMIC_SCAN_CONFIG {"depthPreference":"smooth","depthTypeRequest":["smooth","raw"],"meshRequested":true,"scanId":4,"sessionDepthType":"smooth"}
    LOG PANORAMIC_KEYFRAME_PROFILE {"keyframes":1,"rawSampleCount":781,"retainedSamples":781,"scanId":4,"surfelCount":781}
    LOG PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE {"fallbackReason":"missing-native-mesh-payload-getter","frameNumber":2,"meshBytes":0,"meshCount":0,"meshPayloadUnavailable":true,"requestMs":0.2,"scanId":4}
    LOG PANORAMIC_KEYFRAME_REJECTION_PROFILE {"errorMessage":"undefined is not a function","errorName":"TypeError","frameCount":2,"keyframes":1,"reason":"scan-loop-error","retainedSamples":781,"scanId":4}
  `);

  const summary = panoramaBottleneckSummary(seen);

  expect(summary).toContain(
    'Native mesh payload unavailable: missing-native-mesh-payload-getter'
  );
  expect(summary).toContain(
    'First-frame diagnosis: scan loop callback threw after 1 keyframe(s): TypeError: undefined is not a function; optional WebXR mesh payload was unavailable (missing-native-mesh-payload-getter), so mesh profiling/supplement access could have stopped post-first surfel capture on older builds'
  );

  const oldBuildSummary = panoramaBottleneckSummary({
    PANORAMIC_SCAN_CONFIG: {
      depthPreference: 'smooth',
      depthTypeRequest: ['smooth', 'raw'],
      meshRequested: true,
      sessionDepthType: 'smooth',
    },
    PANORAMIC_KEYFRAME_REJECTION_PROFILE: {
      errorMessage: 'undefined is not a function',
      errorName: 'TypeError',
      frameCount: 2,
      keyframes: 1,
      reason: 'scan-loop-error',
      retainedSamples: 781,
    },
  } satisfies SeenMetrics);

  expect(oldBuildSummary).toContain(
    'First-frame diagnosis: scan loop callback threw after 1 keyframe(s): TypeError: undefined is not a function; mesh detection was requested and the error shape matches a missing optional WebXR mesh bridge, which can throw before the post-first depth keyframe path'
  );
});

test('panorama validator diagnoses scan loop scheduling stops', () => {
  const seen = {
    PANORAMIC_KEYFRAME_PROFILE: {
      keyframes: 1,
      retainedSamples: 781,
      surfelCount: 781,
    },
    PANORAMIC_XR_SCAN_LOOP_STOP_PROFILE: {
      acceptedKeyframes: 1,
      captureInFlight: false,
      frameCount: 1,
      keyframes: 1,
      rawSampleCount: 781,
      reason: 'status-idle',
      retainedSamples: 781,
      sessionEnded: false,
      sessionMatches: true,
      status: 'idle',
    },
  } satisfies SeenMetrics;

  const summary = panoramaBottleneckSummary(seen);

  expect(summary).toContain(
    'XR scan loop stopped: status-idle, status idle, 1/1 frames accepted, retained 781 samples, captureInFlight no, sessionEnded no, sessionMatches yes'
  );
  expect(summary).toContain(
    'First-frame diagnosis: XR scan loop stopped after 1 frame(s) and 1 keyframe(s) because capture status became idle; status idle, captureInFlight no, sessionEnded no, sessionMatches yes'
  );
});

test('panorama validator diagnoses one-keyframe capture attempts', () => {
  const seen = {
    PANORAMIC_CAPTURE_METRICS: {
      keyframes: 1,
      rawSampleCount: 781,
      surfelCount: 749,
    },
    PANORAMIC_SCAN_STATS: {
      acceptedKeyframes: 1,
      elapsedMs: 140,
      frameCount: 1,
      rejectedByReason: {},
    },
  } satisfies SeenMetrics;

  expect(panoramaBottleneckSummary(seen)).toContain(
    'First-frame diagnosis: Capture sealed a model after only 1 accepted keyframe(s); capture was triggered before the scan accumulated enough keyframes'
  );
});

test('panorama validator diagnoses blocked early capture attempts', () => {
  const seen = {
    PANORAMIC_CAPTURE_BLOCKED_PROFILE: {
      acceptedKeyframes: 1,
      captureInFlight: false,
      frameCount: 1,
      fusedSurfelCount: 749,
      keyframes: 1,
      previewBuildInFlight: false,
      rawSampleCount: 781,
      reason: 'too-few-keyframes',
      requiredKeyframes: 2,
      retainedSamples: 781,
      status: 'scanning',
    },
  } satisfies SeenMetrics;

  const summary = panoramaBottleneckSummary(seen);

  expect(summary).toContain(
    'Capture blocked: too-few-keyframes, status scanning, 1/2 keyframes, 1 frames, retained 781 samples, fused 749 surfels, captureInFlight no, previewBuildInFlight no'
  );
  expect(summary).toContain(
    'First-frame diagnosis: Capture was blocked after only 1/2 accepted keyframes; the scan was left running instead of sealing a one-frame model'
  );
});

test('panorama validator diagnoses a previous multi-keyframe scan reset before a one-frame scan', () => {
  const seen = parseMetricLogText(`
 LOG PANORAMIC_SCAN_RESET_PROFILE {"nextScanId":2,"previousAcceptedKeyframes":24,"previousFrameCount":120,"previousFusedSurfelCount":9744,"previousKeyframes":24,"previousRawSampleCount":13496,"previousRetainedSamples":13496,"previousScanId":1,"reason":"start-session","scanId":2,"sessionActive":false,"status":"idle"}
 LOG PANORAMIC_KEYFRAME_PROFILE {"appendMs":31.48,"cameraColorPercent":100,"fusedSurfelCount":749,"keyframes":1,"rawSampleCount":781,"retainedSamples":781,"scanId":2,"surfelCount":781}
  `);

  const summary = panoramaBottleneckSummary(seen);

  expect(seen.PANORAMIC_SCAN_RESET_PROFILE).toMatchObject({
    nextScanId: 2,
    previousKeyframes: 24,
    scanId: 2,
  });
  expect(summary).toContain(
    'Scan reset: start-session discarded 24 keyframes, 13496 raw samples, 9744 fused surfels; previous scan 1 -> 2, status idle'
  );
  expect(summary).toContain(
    'First-frame diagnosis: current scan has only 1 keyframe(s) after a start-session reset discarded 24 previous keyframes and 13496 raw samples'
  );
});

test('panorama validator prefers current scan starvation evidence over reset context', () => {
  const seen = parseMetricLogText(`
 LOG PANORAMIC_SCAN_RESET_PROFILE {"nextScanId":2,"previousAcceptedKeyframes":24,"previousFrameCount":120,"previousFusedSurfelCount":9744,"previousKeyframes":24,"previousRawSampleCount":13496,"previousRetainedSamples":13496,"previousScanId":1,"reason":"start-session","scanId":2,"sessionActive":false,"status":"idle"}
 LOG PANORAMIC_KEYFRAME_PROFILE {"appendMs":31.48,"cameraColorPercent":100,"fusedSurfelCount":749,"keyframes":1,"rawSampleCount":781,"retainedSamples":781,"scanId":2,"surfelCount":781}
 LOG PANORAMIC_XR_FRAME_PUMP_PROFILE {"arFrameDelta":72,"arFrameNumber":76,"consecutiveDepthMisses":70,"deliveredFramePolls":1,"depthFrameArFrameNumber":4,"depthFrameDelta":1,"depthMisses":70,"lastDeliveredFrameNumber":1,"latestFrameNumber":1,"nativeFrameErrorPolls":0,"noFramePolls":0,"reason":"stale-frame","staleFramePolls":70,"scanId":2}
  `);

  const summary = panoramaBottleneckSummary(seen);

  expect(summary).toContain(
    'Scan reset: start-session discarded 24 keyframes, 13496 raw samples, 9744 fused surfels; previous scan 1 -> 2, status idle'
  );
  expect(summary).toContain(
    'First-frame diagnosis: ARKit camera frames are still arriving (+72), but WebXR scene-depth snapshots are stuck on depth frame 1; last depth came from AR frame 4, lag 72, depth misses 70 consecutive 70; this points to native scene-depth starvation rather than JS keyframe rejection'
  );
});

test('panorama validator diagnoses accepted raw samples that do not grow displayed surfels', () => {
  const seen = {
    PANORAMIC_KEYFRAME_PROFILE: {
      fusedSurfelCount: 780,
      keyframes: 4,
      rawSampleCount: 3200,
      retainedSamples: 3200,
      surfelCount: 780,
    },
    PANORAMIC_LIVE_MODEL_PROFILE: {
      buildMs: 12,
      keyframes: 4,
      rawSampleCount: 3200,
      surfelCount: 780,
    },
  } satisfies SeenMetrics;

  expect(panoramaBottleneckSummary(seen)).toContain(
    'Displayed-surfels diagnosis: 4 keyframes accepted and 3200 raw samples observed, but only 780 fused/displayed surfels remain; this points to voxel fusion collapsing later samples or stale model publication rather than frame delivery'
  );
});

test('panorama validator diagnoses stale displayed model publication', () => {
  const seen = {
    PANORAMIC_KEYFRAME_PROFILE: {
      fusedSurfelCount: 2100,
      keyframes: 4,
      rawSampleCount: 3200,
      retainedSamples: 3200,
      surfelCount: 780,
    },
    PANORAMIC_RENDER_FRAME_PROFILE: {
      canvasHeight: 1280,
      canvasWidth: 960,
      keyframes: 1,
      rawSampleCount: 780,
      renderFrameMs: 12,
      surfelCount: 760,
    },
  } satisfies SeenMetrics;

  expect(panoramaBottleneckSummary(seen)).toContain(
    'Displayed-surfels diagnosis: 4 keyframes accepted and 3200 raw samples observed, but the render-frame model is stale at 1 keyframe(s) and 780 raw samples; this points to live publish/render upload staleness rather than frame delivery'
  );
});

test('panorama validator diagnoses post-first fusion growth without keyframe publication', () => {
  const seen = {
    PANORAMIC_KEYFRAME_PROFILE: {
      fusedSurfelCount: 749,
      keyframes: 1,
      rawSampleCount: 781,
      retainedSamples: 781,
      surfelCount: 781,
    },
    PANORAMIC_RENDER_FRAME_PROFILE: {
      canvasHeight: 1280,
      canvasWidth: 960,
      keyframes: 1,
      rawSampleCount: 781,
      renderFrameMs: 12,
      surfelCount: 749,
    },
    PANORAMIC_SCAN_STATS: {
      acceptedKeyframes: 1,
      frameCount: 24,
      fusedSurfelCount: 1480,
      rawSampleCount: 2600,
      rejectedByReason: {
        'too-few-new-voxels': 12,
        'too-few-surfels': 3,
      },
      retainedSamples: 2600,
    },
  } satisfies SeenMetrics;

  expect(panoramaBottleneckSummary(seen)).toContain(
    'First-frame diagnosis: post-first depth reached fusion (2600 raw samples, 1480 fused surfels) but only 1 keyframe(s) were accepted; render-frame model remains at 1kf/781raw/749surfels; rejected too-few-new-voxels 12, too-few-surfels 3; this points to post-depth keyframe acceptance/publication rather than native frame starvation'
  );
});

test('panorama validator diagnoses native WebXR frame fetch errors', () => {
  const seen = {
    PANORAMIC_KEYFRAME_PROFILE: {
      keyframes: 1,
      retainedSamples: 781,
      surfelCount: 781,
    },
    PANORAMIC_XR_FRAME_PUMP_PROFILE: {
      deliveredFramePolls: 0,
      errorMessage: 'undefined is not a function',
      errorName: 'TypeError',
      lastDeliveredFrameNumber: 1,
      latestFrameNumber: 0,
      nativeFrameErrorPolls: 3,
      noFramePolls: 0,
      reason: 'native-frame-error',
      staleFramePolls: 0,
    },
  } satisfies SeenMetrics;

  const summary = panoramaBottleneckSummary(seen);

  expect(summary).toContain(
    'XR frame pump: native-frame-error, depth frame 0 delivered 1, AR frame 0 (+0), depth misses 0 consecutive 0, error TypeError: undefined is not a function, delivered polls 0, native errors 3, stale polls 0'
  );
  expect(summary).toContain(
    'First-frame diagnosis: WebXR native frame fetch threw after 1 keyframe(s): TypeError: undefined is not a function'
  );
});

test('panorama validator distinguishes delivered WebXR frames from stale polling', () => {
  const seen = {
    PANORAMIC_SCAN_STATS: {
      acceptedKeyframes: 1,
      elapsedMs: 1200,
      frameCount: 44,
      rejectedByReason: {
        'too-fast': 9,
        'too-similar': 12,
      },
    },
    PANORAMIC_XR_FRAME_PUMP_PROFILE: {
      arFrameDelta: 24,
      arFrameNumber: 48,
      consecutiveDepthMisses: 0,
      deliveredFramePolls: 22,
      depthFrameDelta: 22,
      depthMisses: 0,
      lastDeliveredFrameNumber: 44,
      latestFrameNumber: 44,
      reason: 'delivered-frame',
      staleFramePolls: 1,
    },
  } satisfies SeenMetrics;

  const summary = panoramaBottleneckSummary(seen);

  expect(summary).toContain(
    'XR frame pump: delivered-frame, depth frame 44 delivered 44, AR frame 48 (+24), depth misses 0 consecutive 0, delivered polls 22, native errors 0, stale polls 1'
  );
  expect(summary).toContain(
    'First-frame diagnosis: WebXR frames are still being delivered (22 polls), but post-first frames are not accepted by the panorama keyframe gates; rejected too-similar 12, too-fast 9'
  );
});

test('panorama validator identifies too-fast keyframe gate dominance', () => {
  const seen = {
    PANORAMIC_SCAN_STATS: {
      acceptedKeyframes: 1,
      elapsedMs: 1200,
      frameCount: 44,
      rejectedByReason: {
        'too-fast': 18,
        'too-similar': 2,
      },
    },
    PANORAMIC_XR_FRAME_PUMP_PROFILE: {
      deliveredFramePolls: 22,
      lastDeliveredFrameNumber: 44,
      latestFrameNumber: 44,
      reason: 'delivered-frame',
    },
  } satisfies SeenMetrics;

  expect(panoramaBottleneckSummary(seen)).toContain(
    'First-frame diagnosis: WebXR frames are still being delivered (22 polls), but post-first frames are not accepted by the panorama keyframe gates; rejected too-fast 18, too-similar 2; dominant gate too-fast means delivered frames exceeded the pose-speed limit before depth/camera sampling'
  );
});

test('panorama validator distinguishes ARKit frame delivery from stale scene-depth snapshots', () => {
  const seen = {
    PANORAMIC_KEYFRAME_PROFILE: {
      keyframes: 1,
      retainedSamples: 781,
      surfelCount: 781,
    },
    PANORAMIC_XR_FRAME_PUMP_PROFILE: {
      arFrameDelta: 72,
      arFrameNumber: 76,
      consecutiveDepthMisses: 70,
      deliveredFramePolls: 1,
      depthFrameArFrameNumber: 4,
      depthFrameDelta: 1,
      depthMisses: 70,
      lastDeliveredFrameNumber: 1,
      latestFrameNumber: 1,
      noFramePolls: 0,
      reason: 'stale-frame',
      staleFramePolls: 89,
    },
  } satisfies SeenMetrics;

  const summary = panoramaBottleneckSummary(seen);

  expect(summary).toContain(
    'XR frame pump: stale-frame, depth frame 1 delivered 1, AR frame 76 (+72), depth AR frame 4 lag 72, depth misses 70 consecutive 70, delivered polls 1, native errors 0, stale polls 89'
  );
  expect(summary).toContain(
    'First-frame diagnosis: ARKit camera frames are still arriving (+72), but WebXR scene-depth snapshots are stuck on depth frame 1; last depth came from AR frame 4, lag 72, depth misses 70 consecutive 70; this points to native scene-depth starvation rather than JS keyframe rejection'
  );
});

test('panorama validator diagnoses ARKit frames with no scene-depth snapshot', () => {
  const seen = {
    PANORAMIC_SCAN_STATS: {
      acceptedKeyframes: 0,
      elapsedMs: 1000,
      frameCount: 0,
      rejectedByReason: {},
    },
    PANORAMIC_XR_FRAME_PUMP_PROFILE: {
      arFrameDelta: 18,
      arFrameNumber: 18,
      consecutiveDepthMisses: 18,
      deliveredFramePolls: 0,
      depthFrameDelta: 0,
      depthMisses: 18,
      lastDeliveredFrameNumber: 0,
      latestFrameNumber: 0,
      noFramePolls: 0,
      reason: 'stale-frame',
      staleFramePolls: 18,
    },
  } satisfies SeenMetrics;

  expect(panoramaBottleneckSummary(seen)).toContain(
    'First-frame diagnosis: ARKit camera frames are arriving (+18), but WebXR scene-depth snapshots have not been produced yet, depth misses 18 consecutive 18; this points to native scene-depth starvation before JS can add surfels'
  );
});

test('panorama validator diagnoses native frame starvation after the first surfel batch', () => {
  const seen = {
    PANORAMIC_KEYFRAME_PROFILE: {
      keyframes: 1,
      retainedSamples: 781,
      surfelCount: 781,
    },
    PANORAMIC_XR_FRAME_PUMP_PROFILE: {
      deliveredFramePolls: 0,
      lastDeliveredFrameNumber: 1,
      latestFrameNumber: 1,
      noFramePolls: 0,
      reason: 'stale-frame',
      staleFramePolls: 89,
    },
  } satisfies SeenMetrics;

  expect(panoramaBottleneckSummary(seen)).toContain(
    'First-frame diagnosis: WebXR native frame delivery stalled (stale-frame; no-frame 0, stale 89) before the app could add more surfels'
  );
});

function completeMetricSet(
  overrides: Partial<Record<keyof SeenMetrics, Record<string, unknown>>> = {}
): SeenMetrics {
  const base = {
    PANORAMIC_KEYFRAME_PROFILE: {
      appendMs: 12,
      cameraColorPercent: 80,
      depthGridSamples: DEFAULT_VALIDATION_BUDGETS.maxKeyframeDepthGridSamples,
      cameraSampleMode: 'precomputed-axis',
      depthGridSampleMode: 'precomputed-identity',
      depthType: 'smooth',
      fusedSurfelCount: 42,
      keyframes: 3,
      newVoxelCount: 24,
      newVoxelPercent: 70.6,
      observedDepthSurfels: 34,
      rawSampleCount: 100,
      retainedSamples: 100,
      surfelCount: 34,
      updatedVoxelCount: 10,
      unprojectionMode: 'intrinsics-projection',
    },
    PANORAMIC_CAPTURE_METRICS: {
      boundsMeters: [1.1, 0.8, 0.3],
      buildMs: 25,
      cameraColorPercent: 80,
      colorSource: 'camera',
      fusionPercent: 42,
      keyframes: 3,
      multiObservationPercent: 60,
      multiObservedSurfels: 25,
      normalPercent: 65,
      rawSampleCount: 100,
      surfelCount: 42,
      voxelSizeMeters: 0.045,
    },
    PANORAMIC_RENDER_METRICS: {
      buildMs: 25,
      cameraColorPercent: 80,
      canvasHeight: 1280,
      canvasWidth: 960,
      keyframes: 3,
      modelRevision: 4,
      multiObservationPercent: 60,
      multiObservedSurfels: 25,
      normalPercent: 65,
      presentationFormat: 'bgra8unorm',
      rawSampleCount: 100,
      surfelCount: 42,
      viewMode: 'Color',
    },
    PANORAMIC_EXPORT_METRICS: {
      bytes: 4096,
      filename: 'scene.ply',
      filesVisiblePath: 'standard-camera-app/scene.ply',
      keyframes: 3,
      rawSampleCount: 100,
      surfelCount: 42,
      uri: 'file:///Documents/scene.ply',
    },
    PANORAMIC_PREVIEW_METRICS: {
      buildMs: 25,
      cameraColorPercent: 80,
      colorSource: 'camera',
      fusionPercent: 42,
      keyframes: 3,
      multiObservationPercent: 60,
      multiObservedSurfels: 25,
      normalPercent: 65,
      rawSampleCount: 100,
      surfelCount: 42,
    },
  } satisfies SeenMetrics;
  const merged: SeenMetrics = { ...base };
  for (const [name, metric] of Object.entries(overrides)) {
    const key = name as keyof SeenMetrics;
    merged[key] = { ...(merged[key] ?? {}), ...metric };
  }
  return merged;
}
