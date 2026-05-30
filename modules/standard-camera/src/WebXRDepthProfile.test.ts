import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import NativeStandardCamera, {
  type NativeLiDARDepthCapabilities,
  type NativeLiDARDepthFrame,
  type NativeWebXRMeshSummary,
} from './native';
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
  WebXRSystem,
  WebXRViewerPose,
  WebXRView,
  runWithWebXRUserActivation,
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
  const originalPerformance = globalThis.performance;
  const callbacks: FrameRequestCallback[] = [];
  let nextHandle = 1;
  let nowMs = 2000;
  let nativeFrame: NativeLiDARDepthFrame = {
    ...makeNativeFrame(1),
    appLifecycleState: 'active',
    arFrameNumber: 10,
    nativeSessionId: 1,
    nativeSessionState: 'running',
  };
  let delivered = 0;

  try {
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = () => ({ remove() {} });
    (NativeStandardCamera as typeof NativeStandardCamera).getLatestWebXRLiDARDepthFrame = () => nativeFrame;
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

    session.requestAnimationFrame(onFrame);
    nowMs = 2500;
    flushNextRaf(callbacks);
    expect(delivered).toBe(1);

    nativeFrame = {
      ...makeNativeFrame(2),
      appLifecycleState: 'active',
      arFrameNumber: 12,
      nativeSessionId: 1,
      nativeSessionState: 'running',
    };
    nowMs = 3600;
    flushNextRaf(callbacks);
    expect(delivered).toBe(2);
  } finally {
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = originalAddListener;
    (NativeStandardCamera as typeof NativeStandardCamera).getLatestWebXRLiDARDepthFrame = originalLatestFrame;
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

test('XRSystem.requestSession waits for camera lock handlers before starting native ARKit', async () => {
  const originalAddListener = NativeStandardCamera.addListener;
  const originalCapabilities = NativeStandardCamera.getLiDARDepthCapabilities;
  const originalStart = NativeStandardCamera.startWebXRLiDARDepthAsync;
  const originalStop = NativeStandardCamera.stopLiDARDepthAsync;
  let lockCalls = 0;
  let nativeStarts = 0;
  let nativeStartedBeforeLock = false;
  let unlocks = 0;
  let session: WebXRSession | null = null;

  try {
    setWebXRDepthCameraLockHandlers(null);
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = () => ({ remove() {} });
    (NativeStandardCamera as typeof NativeStandardCamera).getLiDARDepthCapabilities = () => ({
      frameNumber: 0,
      meshDetection: false,
      running: false,
      sceneDepth: true,
      sessionId: 0,
      smoothedSceneDepth: true,
      state: 'idle',
      supported: true,
    });
    (NativeStandardCamera as typeof NativeStandardCamera).startWebXRLiDARDepthAsync = async (depthType) => {
      nativeStarts += 1;
      nativeStartedBeforeLock = lockCalls <= 0;
      return {
        depthType: depthType === 'raw' ? 'raw' : 'smooth',
        frameNumber: 1,
        meshDetection: false,
        running: true,
        sceneDepth: true,
        sessionId: 42,
        smoothedSceneDepth: true,
        state: 'running',
        supported: true,
      };
    };
    (NativeStandardCamera as typeof NativeStandardCamera).stopLiDARDepthAsync = async () => {};

    const system = new WebXRSystem();
    const sessionPromise = runWithWebXRUserActivation(() =>
      system.requestSession('immersive-ar', {
        requiredFeatures: ['depth-sensing'],
        depthSensing: {
          dataFormatPreference: ['float32'],
          depthTypeRequest: ['smooth', 'raw'],
          matchDepthView: true,
          usagePreference: ['cpu-optimized'],
        },
      })
    );

    await Promise.resolve();

    expect(nativeStarts).toBe(0);

    setWebXRDepthCameraLockHandlers({
      lockExternal: async () => {
        lockCalls += 1;
      },
      unlockExternal: () => {
        unlocks += 1;
      },
    });
    session = await sessionPromise;

    expect(lockCalls).toBe(1);
    expect(nativeStarts).toBe(1);
    expect(nativeStartedBeforeLock).toBe(false);
    expect(session.depthType).toBe('smooth');

    setWebXRDepthCameraLockHandlers(null);
    await session.end();
    session = null;

    expect(unlocks).toBe(1);
  } finally {
    if (session && !session.ended) {
      await session.end();
    }
    setWebXRDepthCameraLockHandlers(null);
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = originalAddListener;
    (NativeStandardCamera as typeof NativeStandardCamera).getLiDARDepthCapabilities = originalCapabilities;
    (NativeStandardCamera as typeof NativeStandardCamera).startWebXRLiDARDepthAsync = originalStart;
    (NativeStandardCamera as typeof NativeStandardCamera).stopLiDARDepthAsync = originalStop;
  }
});

test('XRSystem.requestSession honors raw-first depth type preference', async () => {
  const originalAddListener = NativeStandardCamera.addListener;
  const originalCapabilities = NativeStandardCamera.getLiDARDepthCapabilities;
  const originalStart = NativeStandardCamera.startWebXRLiDARDepthAsync;
  const originalStop = NativeStandardCamera.stopLiDARDepthAsync;
  let requestedDepthType = '';
  let session: WebXRSession | null = null;

  try {
    setWebXRDepthCameraLockHandlers({
      lockExternal: async () => {},
      unlockExternal: () => {},
    });
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = () => ({ remove() {} });
    (NativeStandardCamera as typeof NativeStandardCamera).getLiDARDepthCapabilities = () => ({
      frameNumber: 0,
      meshDetection: false,
      running: false,
      sceneDepth: true,
      sessionId: 0,
      smoothedSceneDepth: true,
      state: 'idle',
      supported: true,
    });
    (NativeStandardCamera as typeof NativeStandardCamera).startWebXRLiDARDepthAsync = async (depthType) => {
      requestedDepthType = depthType;
      return {
        depthType: depthType === 'raw' ? 'raw' : 'smooth',
        frameNumber: 1,
        meshDetection: false,
        running: true,
        sceneDepth: true,
        sessionId: 17,
        smoothedSceneDepth: true,
        state: 'running',
        supported: true,
      };
    };
    (NativeStandardCamera as typeof NativeStandardCamera).stopLiDARDepthAsync = async () => {};

    const system = new WebXRSystem();
    session = await runWithWebXRUserActivation(() =>
      system.requestSession('immersive-ar', {
        requiredFeatures: ['depth-sensing'],
        depthSensing: {
          dataFormatPreference: ['float32'],
          depthTypeRequest: ['raw', 'smooth'],
          matchDepthView: true,
          usagePreference: ['cpu-optimized'],
        },
      })
    );

    expect(requestedDepthType).toBe('raw');
    expect(session.depthType).toBe('raw');
  } finally {
    if (session && !session.ended) {
      await session.end();
    }
    setWebXRDepthCameraLockHandlers(null);
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = originalAddListener;
    (NativeStandardCamera as typeof NativeStandardCamera).getLiDARDepthCapabilities = originalCapabilities;
    (NativeStandardCamera as typeof NativeStandardCamera).startWebXRLiDARDepthAsync = originalStart;
    (NativeStandardCamera as typeof NativeStandardCamera).stopLiDARDepthAsync = originalStop;
  }
});

test('XRSystem.requestSession rejects overlapping starts before taking or releasing the camera lock', async () => {
  const originalAddListener = NativeStandardCamera.addListener;
  const originalCapabilities = NativeStandardCamera.getLiDARDepthCapabilities;
  const originalStart = NativeStandardCamera.startWebXRLiDARDepthAsync;
  const originalStop = NativeStandardCamera.stopLiDARDepthAsync;
  let lockCalls = 0;
  let nativeStarts = 0;
  let resolveNativeStart!: (capabilities: NativeLiDARDepthCapabilities) => void;
  let unlocks = 0;
  let session: WebXRSession | null = null;

  try {
    setWebXRDepthCameraLockHandlers({
      lockExternal: async () => {
        lockCalls += 1;
      },
      unlockExternal: () => {
        unlocks += 1;
      },
    });
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = () => ({ remove() {} });
    (NativeStandardCamera as typeof NativeStandardCamera).getLiDARDepthCapabilities = () => ({
      frameNumber: 0,
      meshDetection: false,
      running: false,
      sceneDepth: true,
      sessionId: 0,
      smoothedSceneDepth: true,
      state: 'idle',
      supported: true,
    });
    (NativeStandardCamera as typeof NativeStandardCamera).startWebXRLiDARDepthAsync = async (depthType) => {
      nativeStarts += 1;
      return new Promise<NativeLiDARDepthCapabilities>((resolve) => {
        resolveNativeStart = resolve;
      }).then((capabilities) => ({
        ...capabilities,
        depthType: depthType === 'raw' ? 'raw' : 'smooth',
      }));
    };
    (NativeStandardCamera as typeof NativeStandardCamera).stopLiDARDepthAsync = async () => {};

    const system = new WebXRSystem();
    const firstStart = runWithWebXRUserActivation(() =>
      system.requestSession('immersive-ar', {
        requiredFeatures: ['depth-sensing'],
        depthSensing: {
          dataFormatPreference: ['float32'],
          depthTypeRequest: ['smooth', 'raw'],
          matchDepthView: true,
          usagePreference: ['cpu-optimized'],
        },
      })
    );

    await Promise.resolve();

    let rejection: unknown;
    try {
      await runWithWebXRUserActivation(() =>
        system.requestSession('immersive-ar', {
          requiredFeatures: ['depth-sensing'],
          depthSensing: {
            dataFormatPreference: ['float32'],
            depthTypeRequest: ['smooth', 'raw'],
            matchDepthView: true,
            usagePreference: ['cpu-optimized'],
          },
        })
      );
    } catch (e) {
      rejection = e;
    }

    expect((rejection as Error | undefined)?.name).toBe('InvalidStateError');
    expect(lockCalls).toBe(1);
    expect(nativeStarts).toBe(1);
    expect(unlocks).toBe(0);

    resolveNativeStart({
      depthType: 'smooth',
      frameNumber: 1,
      meshDetection: false,
      running: true,
      sceneDepth: true,
      sessionId: 43,
      smoothedSceneDepth: true,
      state: 'running',
      supported: true,
    });
    session = await firstStart;
    await session.end();
    session = null;

    expect(unlocks).toBe(1);
  } finally {
    if (session && !session.ended) {
      await session.end();
    }
    setWebXRDepthCameraLockHandlers(null);
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = originalAddListener;
    (NativeStandardCamera as typeof NativeStandardCamera).getLiDARDepthCapabilities = originalCapabilities;
    (NativeStandardCamera as typeof NativeStandardCamera).startWebXRLiDARDepthAsync = originalStart;
    (NativeStandardCamera as typeof NativeStandardCamera).stopLiDARDepthAsync = originalStop;
  }
});

test('XRFrame.detectedMeshes exposes ARKit meshes through WebXR mesh spaces', () => {
  const originalMeshGetter = NativeStandardCamera.getWebXRLiDARDepthFrameMeshes;
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
    expect(mesh?.vertices.buffer).toBe(vertexBuffer);
    expect(mesh?.indices.buffer).toBe(indexBuffer);
    expect(mesh?.vertices).toEqual(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    expect(mesh?.indices).toEqual(new Uint32Array([0, 1, 2]));
    expect(fullMeshRequests).toBe(1);
  } finally {
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFrameMeshes = originalMeshGetter;
  }
});

test('XRFrame.detectedMeshes treats a missing optional native mesh bridge as no meshes', () => {
  const originalMeshGetter = NativeStandardCamera.getWebXRLiDARDepthFrameMeshes;

  try {
    (NativeStandardCamera as unknown as Record<string, unknown>).getWebXRLiDARDepthFrameMeshes = undefined;

    const { frame } = makeXRFrame({
      meshDetection: true,
      trackingState: 'normal',
    });
    const meshes = frame.detectedMeshes;

    expect(meshes.size).toBe(0);
    expect([...meshes]).toEqual([]);
    expect(frame.detectedMeshes).toBe(meshes);
  } finally {
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
      colorHeight: 1080,
      colorWidth: 1920,
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
  const { frame, referenceSpace } = makeXRFrame({ trackingState: 'normal' });
  const view = new WebXRView(frame, referenceSpace);
  const depth = new WebXRCPUDepthInformation(frame, view);
  const nativeBuffer = new ArrayBuffer(8);
  const nativeBytes = new Uint8Array(nativeBuffer);
  nativeBytes.set(new Uint8Array(new Float32Array([1, 2]).buffer));

  try {
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = () => ({
      confidenceMapUsed: true,
      confidenceFilteredDepthCount: 2,
      confidenceFallbackReason: 'sparse-medium-confidence',
      confidenceFallbackUsed: true,
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
  } finally {
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = originalPayloadGetter;
  }
});

test('XRCPUDepthInformation requests low-confidence native depth when the session opts in', () => {
  const originalAddListener = NativeStandardCamera.addListener;
  const originalPayloadGetter = NativeStandardCamera.getWebXRLiDARDepthFramePayload;
  const originalPayloadWithOptionsGetter = NativeStandardCamera.getWebXRLiDARDepthFramePayloadWithOptions;
  const nativeBuffer = new ArrayBuffer(4);
  const nativeBytes = new Uint8Array(nativeBuffer);
  nativeBytes.set(new Uint8Array(new Float32Array([1.25]).buffer));
  let requestedLowConfidence: boolean | null = null;
  let requestedDepthData: boolean | null = null;
  let requestedCameraImage: boolean | null = null;

  try {
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = () => ({ remove() {} });
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = () => {
      throw new Error('old payload bridge should not be used');
    };
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayloadWithOptions = (
      _frameNumber,
      includeDepthData,
      includeCameraImage,
      includeLowConfidenceDepthData
    ) => {
      requestedDepthData = includeDepthData;
      requestedCameraImage = includeCameraImage;
      requestedLowConfidence = includeLowConfidenceDepthData;
      return {
        confidenceMapUsed: true,
        confidenceFilteredDepthCount: 0,
        confidenceThreshold: 0,
        depthData: nativeBytes,
        frameNumber: 2,
        highConfidenceDepthCount: 0,
        invalidDepthCount: 0,
        lowConfidenceDepthCount: 1,
        maxDepth: 1.25,
        mediumConfidenceDepthCount: 0,
        meanDepth: 1.25,
        minDepth: 1.25,
        validDepthCount: 1,
      };
    };

    const session = new WebXRSession({
      cameraAccessEnabled: false,
      cameraFormat: 'bgra8unorm',
      depthEnabled: true,
      lowConfidenceDepthEnabled: true,
      depthType: 'raw',
      meshDetectionEnabled: false,
      sessionId: 2,
    });
    const frame = new WebXRFrame(session, makeNativeFrame(2), 123);
    const referenceSpace = new WebXRReferenceSpace(session, 'viewer');
    const view = new WebXRView(frame, referenceSpace);
    const depth = new WebXRCPUDepthInformation(frame, view);

    expect(depth.data).toBe(nativeBuffer);
    expect(requestedDepthData === true).toBe(true);
    expect(requestedCameraImage === false).toBe(true);
    expect(requestedLowConfidence === true).toBe(true);
  } finally {
    (NativeStandardCamera as typeof NativeStandardCamera).addListener = originalAddListener;
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = originalPayloadGetter;
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayloadWithOptions =
      originalPayloadWithOptionsGetter;
  }
});

test('XRCPUDepthInformation indexes normalized coordinates using WebXR width and height scaling', () => {
  const originalPayloadGetter = NativeStandardCamera.getWebXRLiDARDepthFramePayload;
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
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = originalPayloadGetter;
  }
});

test('XRCPUCameraImage treats native payload bridge failures as unavailable camera image', () => {
  const originalPayloadGetter = NativeStandardCamera.getWebXRLiDARDepthFramePayload;
  const { frame } = makeXRFrame({ trackingState: 'normal' });
  const camera = new WebXRCamera(
    frame,
    2,
    1,
    'bgra8unorm',
    new WebXRRigidTransform(new Float32Array(IDENTITY))
  );

  try {
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = () => {
      throw new TypeError('camera payload failed');
    };

    expect(WebXRCPUCameraImage.fromCamera(camera)).toBeNull();
  } finally {
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = originalPayloadGetter;
  }
});

test('XRCPUCameraImage reuses exact native ArrayBuffers without an extra JS copy', () => {
  const originalPayloadGetter = NativeStandardCamera.getWebXRLiDARDepthFramePayload;
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
    (NativeStandardCamera as typeof NativeStandardCamera).getWebXRLiDARDepthFramePayload = () => ({
      colorData: nativeBytes,
      colorFormat: 'bgra8unorm',
      frameNumber: 1,
    });

    const image = WebXRCPUCameraImage.fromCamera(camera);

    expect(image).not.toBeNull();
    expect(image?.data).toBe(nativeBuffer);
    expect(image?.data).toBe(image?.data);
  } finally {
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
    colorHeight: 1080,
    colorWidth: 1920,
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
  colorHeight = 1080,
  colorWidth = 1920,
  depthTransform = DEPTH_TRANSFORM,
  height = 192,
  meshDetection = false,
  meshSummaries,
  referenceSpaceType = 'local',
  trackingState,
  width = 256,
  worldMappingStatus = 'mapped',
}: {
  colorHeight?: number;
  colorWidth?: number;
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
      colorHeight,
      colorWidth,
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
