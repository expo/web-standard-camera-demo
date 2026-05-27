import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import NativeStandardCamera, { type NativeLiDARDepthFrame, type NativeWebXRMeshSummary } from './native';
import {
  WebXRCamera,
  WebXRCPUCameraImage,
  WebXRCPUDepthInformation,
  WebXRDepthInformation,
  WebXRFrame,
  WebXRMesh,
  WebXRReferenceSpace,
  WebXRRigidTransform,
  WebXRSession,
  WebXRViewerPose,
  WebXRView,
  setWebXRDepthCameraLockHandlers,
} from './WebXRDepthProfile';

const PROJECTION = [
  2, 0, 0, 0,
  0, 3, 0, 0,
  0, 0, -1, -1,
  0, 0, -0.2, 0,
];

const VIEW_TRANSFORM = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  1.5, -0.25, 0.75, 1,
];

const DEPTH_TRANSFORM = [
  0.8, 0, 0, 0,
  0, 0.9, 0, 0,
  0, 0, 1, 0,
  0.1, 0.05, 0, 1,
];

const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

test('native WebXR frame cache keeps lazy payload access resilient on slow JS frames', () => {
  const swiftSource = readFileSync(new URL('../ios/LiDARDepthSource.swift', import.meta.url), 'utf8');

  expect(swiftSource).toContain('private let webXRFrameSnapshotRetentionCount: UInt64 = 12');
  expect(swiftSource).toContain('n > webXRFrameSnapshotRetentionCount ? n - webXRFrameSnapshotRetentionCount : 0');
  expect(swiftSource).toContain('XRCPUDepthInformation.data');
  expect(swiftSource).toContain('without widening the app-facing API');
});

test('viewer pose accepts limited startup poses without exposing native tracking fields', () => {
  const { frame, referenceSpace } = makeXRFrame({
    trackingState: 'limited',
    worldMappingStatus: 'notAvailable',
  });
  const pose = frame.getViewerPose(referenceSpace);

  expect(pose).toBeInstanceOf(WebXRViewerPose);
  expect('trackingState' in frame).toBe(false);
  expect('worldMappingStatus' in frame).toBe(false);
  expect('trackingState' in pose!).toBe(false);
  expect('worldMappingStatus' in pose!).toBe(false);
});

test('native WebXR camera preview uses direct YCbCr downsample before CoreImage fallback', () => {
  const swiftSource = readFileSync(new URL('../ios/LiDARDepthSource.swift', import.meta.url), 'utf8');
  const profileSource = readFileSync(new URL('./WebXRDepthProfile.ts', import.meta.url), 'utf8');

  expect(swiftSource).toContain('makeCameraPreviewFrameFromBiPlanarYCbCr');
  expect(swiftSource).toContain('kCVPixelFormatType_420YpCbCr8BiPlanarFullRange');
  expect(swiftSource).toContain('kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange');
  expect(swiftSource).toContain('return (dstWidth, dstHeight, data, "ycbcr-direct")');
  expect(swiftSource).toContain('makeCameraPreviewFrameWithCoreImage');
  expect(swiftSource).toContain('return (dstWidth, dstHeight, data, "core-image")');
  expect(profileSource).toContain("cameraPreviewPath: payload.cameraPreviewPath ?? 'unknown'");
});

test('native ARKit mesh anchors stay behind WebXR mesh-detection objects', () => {
  const swiftSource = readFileSync(new URL('../ios/LiDARDepthSource.swift', import.meta.url), 'utf8');
  const moduleSource = readFileSync(new URL('../ios/StandardCameraModule.swift', import.meta.url), 'utf8');
  const profileSource = readFileSync(new URL('./WebXRDepthProfile.ts', import.meta.url), 'utf8');

  expect(profileSource).toContain("'mesh-detection'");
  expect(profileSource).toContain('get detectedMeshes(): WebXRMeshSet');
  expect(profileSource).toContain('class WebXRMeshSpace');
  expect(profileSource).toContain('getPose(space: WebXRMeshSpace, baseSpace: WebXRReferenceSpace)');
  expect(profileSource).toContain('trackedMeshCacheBySession');
  expect(profileSource).toContain('updateFromNativeFrame');
  expect(profileSource).toContain('SameObject');
  expect(profileSource).toContain('const WEBXR_FRAME_NATIVE = new WeakMap');
  expect(profileSource).not.toContain('readonly nativeFrame: NativeLiDARDepthFrame');
  expect(swiftSource).toContain('ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)');
  expect(swiftSource).toContain('configuration.sceneReconstruction = .mesh');
  expect(swiftSource).toContain('configuration.planeDetection = [.horizontal, .vertical]');
  expect(swiftSource).toContain('without exposing');
  expect(swiftSource).toContain('ARMeshAnchor or ARPlaneAnchor APIs');
  expect(swiftSource).toContain('result["meshAnchorCount"]');
  expect(swiftSource).toContain('result["meshTriangleCount"]');
  expect(swiftSource).toContain('result["meshVertexCount"]');
  expect(swiftSource).toContain('result["detectedMeshes"] = meshSummaries');
  expect(swiftSource).toContain('makeMeshSummary(');
  expect(swiftSource).toContain('meshPayloadCache');
  expect(swiftSource).toContain('meshAnchorGeometrySignatures');
  expect(swiftSource).toContain('XRMesh.lastChangedTime');
  expect(swiftSource).toContain('geometry changes, not current-frame pose changes');
  expect(swiftSource).toContain('private let webXRMeshGeometrySignatureSampleCount = 17');
  expect(swiftSource).toContain('private let webXRMeshPayloadMaxTrianglesPerAnchor = 900');
  expect(swiftSource).toContain('copySampledMeshPayload(');
  expect(swiftSource).toContain('"sourceVertexCount": cachedPayload.sourceVertexCount');
  expect(swiftSource).toContain('"sourceIndexCount": cachedPayload.sourceIndexCount');
  expect(swiftSource).toContain('for sampleIndex in 0..<sampleCount');
  expect(swiftSource).toContain('"cached": cached');
  expect(profileSource).toContain('fromNativeSummaries');
  expect(profileSource).toContain('nativeMeshById');
  expect(swiftSource).not.toContain('if !snapshot.meshAnchors.isEmpty');
  expect(swiftSource).toContain('ARMeshAnchor');
  expect(moduleSource).toContain('getWebXRLiDARDepthFrameMeshes');
  expect(profileSource).not.toContain('getWorldMeshes');
});

test('XRDepthInformation exposes WebXR view geometry without ARKit intrinsics extensions', () => {
  const { frame, referenceSpace } = makeXRFrame({ referenceSpaceType: 'local', trackingState: 'normal' });
  const view = new WebXRView(frame, referenceSpace);
  const pose = new WebXRViewerPose([view]);
  const depth = new WebXRDepthInformation(frame, view);

  expect('nativeFrame' in frame).toBe(false);
  expect(depth.width).toBe(256);
  expect(depth.height).toBe(192);
  expect(pose.views).toHaveLength(1);
  expect(pose.views[0]).toBe(view);
  expectMatrixClose(pose.transform.matrix, VIEW_TRANSFORM);
  expectMatrixClose(depth.projectionMatrix, PROJECTION);
  expectMatrixClose(depth.transform.matrix, VIEW_TRANSFORM);
  expectMatrixClose(depth.normDepthBufferFromNormView.matrix, DEPTH_TRANSFORM);
  expectMatrixClose(view.projectionMatrix, depth.projectionMatrix);
  expectMatrixClose(view.transform.matrix, depth.transform.matrix);
  expect('cameraIntrinsics' in depth).toBe(false);
  expect('cameraIntrinsicsImageResolution' in depth).toBe(false);
  expect('cameraIntrinsicsReference' in depth).toBe(false);
});

test('viewer and local reference spaces expose WebXR-shaped pose transforms', () => {
  const { frame, session } = makeXRFrame({ referenceSpaceType: 'local', trackingState: 'normal' });
  const viewerPose = frame.getViewerPose(new WebXRReferenceSpace(session, 'viewer'));
  const localPose = frame.getViewerPose(new WebXRReferenceSpace(session, 'local'));

  expect(viewerPose).not.toBeNull();
  expect(localPose).not.toBeNull();
  expectMatrixClose(viewerPose!.transform.matrix, IDENTITY);
  expectMatrixClose(viewerPose!.views[0]!.transform.matrix, IDENTITY);
  expectMatrixClose(localPose!.transform.matrix, VIEW_TRANSFORM);
  expectMatrixClose(localPose!.views[0]!.transform.matrix, VIEW_TRANSFORM);
});

test('XRFrame.getViewerPose returns null when native tracking has no camera pose', () => {
  const originalConsoleLog = console.log;
  const profileLogs: unknown[] = [];

  try {
    console.log = (name: unknown, payload?: unknown): void => {
      if (name === 'PANORAMIC_XR_POSE_PROFILE') profileLogs.push(payload);
    };
    const limited = makeXRFrame({ trackingState: 'limited', worldMappingStatus: 'notAvailable' });
    expect(limited.frame.getViewerPose(limited.referenceSpace)).toBeInstanceOf(WebXRViewerPose);

    for (const trackingState of ['notAvailable', 'unknown'] as const) {
      const { frame, referenceSpace } = makeXRFrame({ trackingState });

      expect(frame.getViewerPose(referenceSpace)).toBeNull();
    }

    const { frame, referenceSpace } = makeXRFrame({ trackingState: 'normal' });
    const pose = frame.getViewerPose(referenceSpace);

    expect(pose).toBeInstanceOf(WebXRViewerPose);
    expect(pose?.views).toHaveLength(1);
    const nullPoseLog = profileLogs
      .map((payload) => JSON.parse(String(payload)))
      .find((payload) => payload.returnedPose === false);
    expect(nullPoseLog).toMatchObject({
      frameNumber: 1,
      returnedPose: false,
      trackingState: 'notAvailable',
      worldMappingStatus: 'mapped',
    });
  } finally {
    console.log = originalConsoleLog;
  }
});

test('XRFrame.getViewerPose does not withhold startup poses for native world mapping buckets', () => {
  for (const worldMappingStatus of ['notAvailable', 'limited', 'unknown'] as const) {
    const { frame, referenceSpace } = makeXRFrame({
      trackingState: 'normal',
      worldMappingStatus,
    });

    expect(frame.getViewerPose(referenceSpace)).toBeInstanceOf(WebXRViewerPose);
  }

  for (const worldMappingStatus of ['extending', 'mapped'] as const) {
    const { frame, referenceSpace } = makeXRFrame({
      trackingState: 'normal',
      worldMappingStatus,
    });

    expect(frame.getViewerPose(referenceSpace)).toBeInstanceOf(WebXRViewerPose);
  }
});

test('XRSession.requestAnimationFrame skips duplicate native frame snapshots across callbacks', () => {
  const originalAddListener = NativeStandardCamera.addListener;
  const originalLatestFrame = NativeStandardCamera.getLatestWebXRLiDARDepthFrame;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalConsoleLog = console.log;
  const originalPerformance = globalThis.performance;
  const callbacks: FrameRequestCallback[] = [];
  const profileLogs: unknown[] = [];
  let nextHandle = 1;
  let nowMs = 2000;
  let nativeFrame: NativeLiDARDepthFrame = { ...makeNativeFrame(1), arFrameNumber: 10 };
  let delivered = 0;

  try {
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = () => ({ remove() {} });
    (NativeStandardCamera as typeof NativeStandardCamera).getLatestWebXRLiDARDepthFrame = () => nativeFrame;
    console.log = (name: unknown, payload?: unknown): void => {
      if (name === 'PANORAMIC_XR_FRAME_PUMP_PROFILE') profileLogs.push(payload);
    };
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { ...originalPerformance, now: () => nowMs },
    });
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      callbacks.push(callback);
      return nextHandle++;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;

    const session = new WebXRSession({
      cameraAccessEnabled: false,
      cameraFormat: 'bgra8unorm',
      depthEnabled: true,
      depthType: 'raw',
      meshDetectionEnabled: false,
      sessionId: 1,
    });
    const onFrame = (): void => {
      delivered += 1;
    };

    session.requestAnimationFrame(onFrame);
    flushNextRaf(callbacks);
    expect(delivered).toBe(1);
    expect(JSON.parse(String(profileLogs[0]))).toMatchObject({
      deliveredFramePolls: 1,
      latestFrameNumber: 1,
      reason: 'delivered-frame',
    });

    session.requestAnimationFrame(onFrame);
    nowMs = 2500;
    flushNextRaf(callbacks);
    expect(delivered).toBe(1);

    nativeFrame = { ...makeNativeFrame(2), arFrameNumber: 12 };
    nowMs = 3600;
    flushNextRaf(callbacks);
    expect(delivered).toBe(2);
    expect(JSON.parse(String(profileLogs[1]))).toMatchObject({
      deliveredFramePolls: 1,
      latestFrameNumber: 2,
      reason: 'delivered-frame',
      staleFramePolls: 1,
    });
  } finally {
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = originalAddListener;
    (NativeStandardCamera as typeof NativeStandardCamera).getLatestWebXRLiDARDepthFrame = originalLatestFrame;
    console.log = originalConsoleLog;
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: originalPerformance,
    });
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('XRSession.end releases the external camera lock only after native ARKit stop resolves', async () => {
  const originalAddListener = NativeStandardCamera.addListener;
  const originalStop = NativeStandardCamera.stopLiDARDepthAsync;
  let stopStarted = false;
  let resolveStop!: () => void;
  let unlocks = 0;
  let endEvents = 0;

  try {
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = () => ({ remove() {} });
    (NativeStandardCamera as typeof NativeStandardCamera).stopLiDARDepthAsync = () => {
      stopStarted = true;
      return new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
    };
    setWebXRDepthCameraLockHandlers({
      lockExternal: async () => {},
      unlockExternal: () => {
        unlocks += 1;
      },
    });
    const session = new WebXRSession({
      cameraAccessEnabled: false,
      cameraFormat: 'bgra8unorm',
      depthEnabled: true,
      depthType: 'raw',
      meshDetectionEnabled: false,
      sessionId: 1,
    });
    session.addEventListener('end', () => {
      endEvents += 1;
    });

    const endPromise = session.end();

    expect(session.ended).toBe(true);
    expect(stopStarted).toBe(true);
    expect(unlocks).toBe(0);
    expect(endEvents).toBe(0);

    resolveStop();
    await endPromise;

    expect(unlocks).toBe(1);
    expect(endEvents).toBe(1);
  } finally {
    setWebXRDepthCameraLockHandlers(null);
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = originalAddListener;
    (NativeStandardCamera as typeof NativeStandardCamera).stopLiDARDepthAsync = originalStop;
  }
});

test('XRFrame.detectedMeshes exposes ARKit meshes through WebXR mesh spaces', () => {
  const originalMeshGetter = NativeStandardCamera.getWebXRLiDARDepthFrameMeshes;
  const originalConsoleLog = console.log;
  const profileLogs: unknown[] = [];
  const vertexBuffer = new ArrayBuffer(9 * Float32Array.BYTES_PER_ELEMENT);
  new Float32Array(vertexBuffer).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indexBuffer = new ArrayBuffer(3 * Uint32Array.BYTES_PER_ELEMENT);
  new Uint32Array(indexBuffer).set([0, 1, 2]);
  const normalBuffer = new ArrayBuffer(3 * Float32Array.BYTES_PER_ELEMENT);
  new Float32Array(normalBuffer).set([0, 0, 1]);
  const meshSummary = {
    id: 'mesh-1',
    indexCount: 3,
    lastChangedTime: 456,
    transform: VIEW_TRANSFORM,
    vertexCount: 3,
  };
  const { frame, referenceSpace } = makeXRFrame({
    meshDetection: true,
    meshSummaries: [meshSummary],
    trackingState: 'normal',
  });
  let fullMeshRequests = 0;

  try {
    console.log = (name: unknown, payload?: unknown): void => {
      if (name === 'PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE') profileLogs.push(payload);
    };
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFrameMeshes = () => {
      fullMeshRequests += 1;
      return [{
        cached: true,
        ...meshSummary,
        indices: new Uint8Array(indexBuffer),
        normals: new Uint8Array(normalBuffer),
        vertices: new Uint8Array(vertexBuffer),
      }];
    };

    const meshes = frame.detectedMeshes;
    const mesh = [...meshes][0];
    const pose = mesh ? frame.getPose(mesh.meshSpace, referenceSpace) : null;

    expect(meshes.size).toBe(1);
    expect(mesh).toBeInstanceOf(WebXRMesh);
    expect(mesh?.lastChangedTime).toBe(456);
    expect(frame.detectedMeshes).toBe(meshes);
    expect(pose).not.toBeNull();
    expectMatrixClose(pose!.transform.matrix, VIEW_TRANSFORM);
    expect(fullMeshRequests).toBe(0);
    expect(profileLogs).toHaveLength(0);
    expect(mesh?.vertices.buffer).toBe(vertexBuffer);
    expect(mesh?.indices.buffer).toBe(indexBuffer);
    expect(mesh?.vertices).toEqual(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    expect(mesh?.indices).toEqual(new Uint32Array([0, 1, 2]));
    expect(fullMeshRequests).toBe(1);
    expect(profileLogs).toHaveLength(1);
    expect(JSON.parse(String(profileLogs[0]))).toMatchObject({
      cachedMeshCount: 1,
      copiedMeshCount: 0,
      decimatedMeshCount: 0,
      frameNumber: 1,
      indexBytes: 12,
      indexCount: 3,
      meshBytes: 60,
      meshCount: 1,
      normalBytes: 12,
      normalCount: 1,
      triangleCount: 1,
      sourceIndexCount: 3,
      sourceTriangleCount: 1,
      sourceVertexCount: 3,
      vertexBytes: 36,
      vertexCount: 3,
    });
  } finally {
    console.log = originalConsoleLog;
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFrameMeshes = originalMeshGetter;
  }
});

test('XRFrame.detectedMeshes preserves XRMesh identity across native anchor updates', () => {
  const initialSummary = {
    id: 'mesh-identity',
    indexCount: 3,
    lastChangedTime: 456,
    transform: VIEW_TRANSFORM,
    vertexCount: 3,
  };
  const { frame, referenceSpace, session } = makeXRFrame({
    meshDetection: true,
    meshSummaries: [initialSummary],
    trackingState: 'normal',
  });
  const mesh = [...frame.detectedMeshes][0];
  expect(mesh).toBeInstanceOf(WebXRMesh);

  const movedTransform = [...VIEW_TRANSFORM];
  movedTransform[12] = 2.25;
  const nextFrame = new WebXRFrame(
    session,
    {
      depthFormat: 'r32float',
      depthType: 'raw',
      frameNumber: 2,
      capturedImageHeight: 1440,
      capturedImageWidth: 1920,
      colorHeight: 192,
      colorWidth: 256,
      height: 192,
      maxDepth: 0,
      meanDepth: 0,
      minDepth: 0,
      detectedMeshes: [{
        ...initialSummary,
        lastChangedTime: 789,
        transform: movedTransform,
      }],
      normDepthBufferFromNormView: DEPTH_TRANSFORM,
      projectionMatrix: PROJECTION,
      projectionCameraImageResolution: [1920, 1440],
      trackingState: 'normal',
      viewTransform: VIEW_TRANSFORM,
      width: 256,
      worldMappingStatus: 'mapped',
    },
    124
  );
  const nextMesh = [...nextFrame.detectedMeshes][0];
  const pose = nextMesh ? nextFrame.getPose(nextMesh.meshSpace, referenceSpace) : null;

  expect(nextMesh).toBe(mesh);
  expect(nextMesh?.meshSpace).toBe(mesh?.meshSpace);
  expect(nextMesh?.lastChangedTime).toBe(789);
  expect(pose).not.toBeNull();
  expectMatrixClose(pose!.transform.matrix, movedTransform);
});

test('XRCPUDepthInformation reuses exact native ArrayBuffers without an extra JS copy', () => {
  const originalPayloadGetter = NativeStandardCamera.getWebXRLiDARDepthFramePayload;
  const originalConsoleLog = console.log;
  const profileLogs: unknown[] = [];
  const { frame, referenceSpace } = makeXRFrame({ trackingState: 'normal' });
  const view = new WebXRView(frame, referenceSpace);
  const depth = new WebXRCPUDepthInformation(frame, view);
  const nativeBuffer = new ArrayBuffer(8);
  const nativeBytes = new Uint8Array(nativeBuffer);
  nativeBytes.set(new Uint8Array(new Float32Array([1, 2]).buffer));

  try {
    console.log = (name: unknown, payload?: unknown): void => {
      if (name === 'PANORAMIC_NATIVE_PAYLOAD_PROFILE') profileLogs.push(payload);
    };
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = () => ({
      confidenceMapUsed: true,
      confidenceFilteredDepthCount: 2,
      confidenceThreshold: 1,
      depthData: nativeBytes,
      frameNumber: 1,
      highConfidenceDepthCount: 30000,
      invalidDepthCount: 1,
      lowConfidenceDepthCount: 1,
      maxDepth: 3.2,
      mediumConfidenceDepthCount: 19151,
      meanDepth: 1.5,
      minDepth: 0.45,
      validDepthCount: 49151,
    });

    expect(depth.data).toBe(nativeBuffer);
    expect(depth.data).toBe(depth.data);
    expect(JSON.parse(String(profileLogs[0]))).toMatchObject({
      depthBytes: 8,
      depthMeanMeters: 1.5,
      depthPixelCount: 49152,
      depthSize: [256, 192],
      depthType: 'raw',
      confidenceMapUsed: true,
      confidenceFilteredDepthCount: 2,
      confidenceFilteredPercent: 0,
      confidenceThreshold: 1,
      highConfidenceDepthCount: 30000,
      depthMaxMeters: 3.2,
      invalidDepthPercent: 0,
      lowConfidencePercent: 0,
      mediumConfidenceDepthCount: 19151,
      depthMinMeters: 0.45,
      validDepthPercent: 100,
    });
  } finally {
    console.log = originalConsoleLog;
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = originalPayloadGetter;
  }
});

test('XRCPUDepthInformation indexes normalized coordinates using WebXR width and height scaling', () => {
  const originalPayloadGetter = NativeStandardCamera.getWebXRLiDARDepthFramePayload;
  const originalConsoleLog = console.log;
  const { frame, referenceSpace } = makeXRFrame({
    depthTransform: IDENTITY,
    height: 2,
    trackingState: 'normal',
    width: 2,
  });
  const view = new WebXRView(frame, referenceSpace);
  const depth = new WebXRCPUDepthInformation(frame, view);
  const nativeBytes = new Uint8Array(new Float32Array([
    1, 2,
    3, 4,
  ]).buffer);

  try {
    console.log = () => {};
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = () => ({
      depthData: nativeBytes,
      frameNumber: 1,
    });

    expect(depth.getDepthInMeters(0, 0)).toBe(1);
    expect(depth.getDepthInMeters(0.5, 0.5)).toBe(4);
    expect(depth.getDepthInMeters(1, 1)).toBe(4);
    expect(() => depth.getDepthInMeters(-0.01, 0)).toThrow(RangeError);
    expect(() => depth.getDepthInMeters(0, 1.01)).toThrow(RangeError);
  } finally {
    console.log = originalConsoleLog;
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = originalPayloadGetter;
  }
});

test('XRCPUCameraImage reuses exact native ArrayBuffers without an extra JS copy', () => {
  const originalPayloadGetter = NativeStandardCamera.getWebXRLiDARDepthFramePayload;
  const originalConsoleLog = console.log;
  const profileLogs: unknown[] = [];
  const { frame } = makeXRFrame({ trackingState: 'normal' });
  const nativeBuffer = new ArrayBuffer(8);
  const nativeBytes = new Uint8Array(nativeBuffer);
  nativeBytes.set([0, 64, 128, 255, 255, 128, 64, 0]);
  const camera = new WebXRCamera(
    frame,
    2,
    1,
    'bgra8unorm',
    new WebXRRigidTransform(new Float32Array(IDENTITY))
  );

  try {
    console.log = (name: unknown, payload?: unknown): void => {
      if (name === 'PANORAMIC_NATIVE_PAYLOAD_PROFILE') profileLogs.push(payload);
    };
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = () => ({
      colorData: nativeBytes,
      colorFormat: 'bgra8unorm',
      frameNumber: 1,
    });

    const image = WebXRCPUCameraImage.fromCamera(camera);

    expect(image).not.toBeNull();
    expect(image?.data).toBe(nativeBuffer);
    expect(image?.data).toBe(image?.data);
	    expect(JSON.parse(String(profileLogs[0]))).toMatchObject({
	      cameraBytes: 8,
	      cameraCapturedSize: [1920, 1440],
	      colorSize: [256, 192],
	      depthToCameraScale: [0.1333, 0.1333],
	      projectionCameraImageResolution: [1920, 1440],
	      projectionDepthToCameraScale: [0.1333, 0.1333],
	    });
  } finally {
    console.log = originalConsoleLog;
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = originalPayloadGetter;
  }
});

function expectMatrixClose(actual: ArrayLike<number>, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i] ?? 0, 6);
  }
}

function flushNextRaf(callbacks: Array<(time: DOMHighResTimeStamp) => void>): void {
  const callback = callbacks.shift();
  expect(callback).toBeDefined();
  callback?.(123);
}

function makeNativeFrame(frameNumber: number): NativeLiDARDepthFrame {
  return {
    depthFormat: 'r32float',
    depthType: 'raw',
    frameNumber,
    capturedImageHeight: 1440,
    capturedImageWidth: 1920,
    colorHeight: 192,
    colorWidth: 256,
    height: 192,
    maxDepth: 0,
    meanDepth: 0,
    minDepth: 0,
    normDepthBufferFromNormView: DEPTH_TRANSFORM,
    projectionMatrix: PROJECTION,
    projectionCameraImageResolution: [1920, 1440],
    timestamp: frameNumber,
    trackingState: 'normal',
    viewTransform: VIEW_TRANSFORM,
    width: 256,
    worldMappingStatus: 'mapped',
  };
}

function makeXRFrame({
  depthTransform = DEPTH_TRANSFORM,
  height = 192,
  meshDetection = false,
  meshSummaries,
  referenceSpaceType = 'local',
  trackingState,
  width = 256,
  worldMappingStatus = 'mapped',
}: {
  depthTransform?: readonly number[];
  height?: number;
  meshDetection?: boolean;
  meshSummaries?: readonly NativeWebXRMeshSummary[];
  referenceSpaceType?: 'viewer' | 'local';
  trackingState: 'normal' | 'limited' | 'notAvailable' | 'unknown';
  width?: number;
  worldMappingStatus?: 'notAvailable' | 'limited' | 'extending' | 'mapped' | 'unknown';
}): { frame: WebXRFrame; referenceSpace: WebXRReferenceSpace; session: WebXRSession } {
  const session = {
    ended: false,
    hasMeshDetection: () => meshDetection,
  } as WebXRSession;
  const referenceSpace = new WebXRReferenceSpace(session, referenceSpaceType);
  const frame = new WebXRFrame(
    session,
    {
      depthFormat: 'r32float',
      depthType: 'raw',
      frameNumber: 1,
      capturedImageHeight: 1440,
      capturedImageWidth: 1920,
      colorHeight: height,
      colorWidth: width,
      height,
      maxDepth: 0,
      meanDepth: 0,
      minDepth: 0,
      detectedMeshes: meshSummaries,
	      normDepthBufferFromNormView: depthTransform,
	      projectionMatrix: PROJECTION,
	      projectionCameraImageResolution: [1920, 1440],
	      trackingState,
      viewTransform: VIEW_TRANSFORM,
      width,
      worldMappingStatus,
    },
    123
  );
  return { frame, referenceSpace, session };
}
