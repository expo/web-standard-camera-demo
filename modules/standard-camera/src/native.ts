// @ref LLP 0006 — Platform backend contract for the web-shaped camera API.
// iOS implements this contract in native.ios.ts via the StandardCamera Expo
// module. Web builds should use the browser's own APIs and avoid this backend.

import type { EventSubscription } from 'expo-modules-core';

import type {
  FlatGetUserMediaConstraints,
  MediaDeviceInfo,
  MediaTrackSettings,
  MediaTrackCapabilities,
  MediaStreamTrackKind,
  MediaStreamTrackState,
} from './types';

// @ref LLP 0008#audio-track-events — Audio interruption notifications come
// from AVAudioSession in addition to AVCaptureSession. The native module
// emits the same mute/unmute/ended events for both.

// JS-side handle to native MediaStreamTrack SharedObject.
export interface NativeMediaStreamTrack {
  readonly id: string;
  readonly kind: MediaStreamTrackKind;
  readonly label: string;
  enabled: boolean;
  readonly muted: boolean;
  readonly readyState: MediaStreamTrackState;

  stop(): void;
  // @ref LLP 0001#dom-mediastreamtrack-clone
  clone(): NativeMediaStreamTrack;
  getSettings(): MediaTrackSettings;
  getConstraints(): Record<string, unknown>;
  getCapabilities(): MediaTrackCapabilities;

  /**
   * @internal Used by the JS-side `ImageCapture` polyfill. The W3C Image
   * Capture spec puts grabFrame on `ImageCapture`, not on `MediaStreamTrack`,
   * so this stays underscore-prefixed and out of the public surface. Returns
   * the most recent camera frame as a tight-packed BGRA byte buffer plus
   * dimensions, or null if no frame is available (cold start, simulator
   * without AVCaptureDevice, ended track). LLP 0011 covers the zero-copy
   * follow-up.
   */
  __getLatestFrame(): NativeMediaStreamFrame | null;

  /**
   * @internal Audio analog of `__getLatestFrame()`. Snapshots up to
   * `maxFrames` frames (one frame = one sample per channel) of interleaved
   * Float32 LPCM from the AudioSink's rolling buffer. The same accessor is
   * intended to back MediaRecorder, a future Web Audio bridge, and audio-
   * level meters. Returns null on a video track, an ended track, or before
   * any audio samples have arrived.
   */
  __getLatestAudioBuffer(maxFrames: number): NativeMediaStreamAudioBuffer | null;

  /**
   * @internal Test hook used by the `MediaStreamTrack-disabled-video`
   * project-local test to assert that toggling `track.enabled` propagates
   * to the on-screen preview layer's AVCaptureConnection. Returns null on
   * non-video tracks, ended tracks, or when no `<Video>` is currently
   * rendering this track's stream.
   */
  __getPreviewEnabledForTesting(): boolean | null;

  addListener(
    eventName: 'ended' | 'mute' | 'unmute',
    listener: () => void
  ): EventSubscription;
}

/** Tight-packed BGRA frame returned by `__getLatestFrame()`. */
export interface NativeMediaStreamFrame {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, BGRA, no row padding. */
  readonly data: Uint8Array;
  /** Always `"bgra8unorm"` for now; reserved for future format negotiation. */
  readonly format: 'bgra8unorm';
  /**
   * Monotonic counter of AVCapture sample-buffer deliveries since the source
   * was opened. Lets callers tell whether the camera is actively pushing
   * frames (rising) or stalled (flat) — distinct from whether grabFrame()
   * keeps re-reading the same retained buffer.
   */
  readonly frameNumber: number;
}

/** Interleaved Float32 LPCM audio snapshot returned by
 *  `__getLatestAudioBuffer()`. */
export interface NativeMediaStreamAudioBuffer {
  /**
   * Interleaved Float32 LPCM samples in chronological order. The bridge
   * delivers raw bytes; the polyfill wraps them as a `Float32Array` before
   * surfacing to callers. Length is `frames * channelCount`.
   */
  readonly samples: Uint8Array;
  /** Sample rate the audio session is running at, in Hz. */
  readonly sampleRate: number;
  /** Channel count (typically 1 for the built-in mic). */
  readonly channelCount: number;
  /**
   * Monotonic counter of audio frames written to the sink since the source
   * was opened (one frame = one sample per channel). Lets callers tell
   * whether iOS is actively pushing audio (rising) or stopped (flat) —
   * the audio analog of `NativeMediaStreamFrame.frameNumber`.
   */
  readonly frameNumber: number;
}

// JS-side handle to native MediaStream SharedObject.
export interface NativeMediaStream {
  readonly id: string;
  readonly active: boolean;

  getTracks(): NativeMediaStreamTrack[];
  getVideoTracks(): NativeMediaStreamTrack[];
  getAudioTracks(): NativeMediaStreamTrack[];
  getTrackById(id: string): NativeMediaStreamTrack | null;
  // @ref LLP 0001#dom-mediastream-addtrack
  addTrack(track: NativeMediaStreamTrack): void;
  // @ref LLP 0001#dom-mediastream-removetrack
  removeTrack(track: NativeMediaStreamTrack): void;
  // @ref LLP 0001#dom-mediastream-clone
  clone(): NativeMediaStream;

  /**
   * @internal Demo-only handoff hook. Stops this stream's native tracks and
   * resolves after AVFoundation has reached the serialized capture release
   * point so ARKit can safely take over the camera.
   */
  __stopTracksAndWaitForCaptureReleaseAsync(): Promise<void>;

  /** @internal Test-only hook. Posts a synthetic AVCaptureSession interruption. */
  __simulateInterruptionForTesting(reasonCode: number, ended: boolean): void;
}

export interface NativeStandardCameraModule {
  // Constructor handles (no public constructors, but the class object is exposed).
  MediaStream: { new (): never };
  MediaStreamTrack: { new (): never };

  getUserMediaAsync(constraints: FlatGetUserMediaConstraints): Promise<NativeMediaStream>;
  enumerateDevicesAsync(): Promise<MediaDeviceInfo[]>;
  getSupportedConstraints(): Record<string, boolean>;
  // @ref LLP 0001#mediastream-constructor
  createMediaStream(tracks: NativeMediaStreamTrack[]): NativeMediaStream;
  /** @internal Test-only: forward a message to NSLog so it reaches `simctl log stream` regardless of build config. */
  __systemLogForTesting(message: string): void;
  /** Read-only diagnostics. Permission lookups do NOT trigger iOS prompts. */
  getDiagnostics(): NativeDiagnostics;
  /**
   * @internal Demo-only LiDAR extension. This is intentionally not part of the
   * W3C Media Capture surface; see LLP 0013.
   */
  getLiDARDepthCapabilities(): NativeLiDARDepthCapabilities;
  startLiDARDepthAsync(): Promise<NativeLiDARDepthCapabilities>;
  startLiDARDepthWithTypeAsync(depthType: NativeLiDARDepthType): Promise<NativeLiDARDepthCapabilities>;
  startWebXRLiDARDepthAsync(
    depthType: NativeLiDARDepthType | '',
    enableMeshDetection: boolean
  ): Promise<NativeLiDARDepthCapabilities>;
  stopLiDARDepthAsync(): Promise<void>;
  stopLiDARDepth(): void;
  getLatestWebXRLiDARDepthFrame(): NativeLiDARDepthFrame | null;
  getWebXRLiDARDepthFramePayload(
    frameNumber: number,
    includeDepthData: boolean,
    includeCameraImage: boolean
  ): NativeLiDARDepthFramePayload | null;
  getWebXRLiDARDepthFramePayloadWithOptions(
    frameNumber: number,
    includeDepthData: boolean,
    includeCameraImage: boolean,
    includeLowConfidenceDepthData: boolean
  ): NativeLiDARDepthFramePayload | null;
  getWebXRLiDARDepthFrameMeshes(frameNumber: number): NativeWebXRMesh[] | null;
  addListener(
    eventName: 'onLiDARDepthSessionState',
    listener: (event: NativeLiDARDepthSessionEvent) => void
  ): EventSubscription;
}

export type AuthorizationStatus = 'authorized' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export interface NativeDiagnostics {
  readonly bundleVersion: string;
  readonly bundleShortVersion: string;
  readonly bundleIdentifier: string;
  /** Unix epoch seconds; null if the executable's mtime is unavailable. */
  readonly executableMtime: number | null;
  readonly systemName: string;
  readonly systemVersion: string;
  readonly model: string;
  readonly deviceName: string;
  readonly isSimulator: boolean;
  readonly cameraAuthorization: AuthorizationStatus;
  readonly microphoneAuthorization: AuthorizationStatus;
}

export type NativeLiDARDepthSessionState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'interrupted'
  | 'failed'
  | 'stopped';

export type NativeLiDARDepthType = 'raw' | 'smooth';
export type NativeAppLifecycleState = 'active' | 'inactive' | 'background' | 'unknown';
export type NativeLiDARDepthTrackingState = 'normal' | 'limited' | 'notAvailable' | 'unknown';
export type NativeLiDARDepthWorldMappingStatus =
  | 'notAvailable'
  | 'limited'
  | 'extending'
  | 'mapped'
  | 'unknown';

export interface NativeLiDARDepthCapabilities {
  readonly supported: boolean;
  readonly running: boolean;
  readonly state?: NativeLiDARDepthSessionState;
  readonly sessionId?: number;
  readonly frameNumber?: number;
  readonly sceneDepth: boolean;
  readonly smoothedSceneDepth: boolean;
  readonly meshDetection?: boolean;
  readonly depthType?: NativeLiDARDepthType;
  readonly reason?: string;
}

export interface NativeLiDARDepthSessionEvent {
  readonly sessionId: number;
  readonly state: NativeLiDARDepthSessionState;
  readonly frameNumber?: number;
  readonly reason?: string;
}

export interface NativeLiDARDepthFrame {
  readonly width: number;
  readonly height: number;
  /** Lazily fetched from `getWebXRLiDARDepthFramePayload()`. */
  readonly depthData?: Uint8Array;
  readonly depthFormat: 'r32float';
  readonly depthType?: NativeLiDARDepthType;
  /** ARCamera.trackingState, kept inside the WebXR implementation. */
  readonly trackingState?: NativeLiDARDepthTrackingState;
  /** ARFrame.worldMappingStatus, kept inside the WebXR implementation. */
  readonly worldMappingStatus?: NativeLiDARDepthWorldMappingStatus;
  /** ARFrame.timestamp, seconds on ARKit's monotonic clock. */
  readonly timestamp?: number;
  /** Internal ARFrame delivery counters for WebXR frame-pump profiling. */
  readonly appLifecycleState?: NativeAppLifecycleState;
  readonly arFrameNumber?: number;
  readonly arFrameTimestamp?: number;
  readonly consecutiveDepthMisses?: number;
  readonly depthFrameArFrameNumber?: number;
  readonly depthMisses?: number;
  readonly latestDepthMissRawDepthAvailable?: boolean;
  readonly latestDepthMissRequestedType?: NativeLiDARDepthType;
  readonly latestDepthMissSmoothDepthAvailable?: boolean;
  readonly nativeSessionId?: number;
  readonly nativeSessionReason?: string;
  readonly nativeSessionState?: NativeLiDARDepthSessionState;
  readonly rawDepthAvailable?: boolean;
  readonly retainedFrameSnapshots?: number;
  readonly requestedDepthMissesWithAlternateDepth?: number;
  readonly requestedDepthMissingButAlternateAvailable?: boolean;
  readonly requestedDepthType?: NativeLiDARDepthType;
  readonly smoothDepthAvailable?: boolean;
  /** Column-major 4x4 matrices in WebXR-compatible order. */
  readonly projectionMatrix?: readonly number[];
  /** ARCamera.imageResolution used to scale intrinsics into projectionMatrix. */
  readonly projectionCameraImageResolution?: readonly number[];
  readonly viewTransform?: readonly number[];
  readonly normDepthBufferFromNormView?: readonly number[];
  /** ARKit camera preview paired with the depth frame, when available. */
  readonly colorWidth?: number;
  readonly colorHeight?: number;
  /** Lazily fetched from `getWebXRLiDARDepthFramePayload()`. */
  readonly colorData?: Uint8Array;
  readonly colorFormat?: 'bgra8unorm';
  readonly normCameraImageFromNormView?: readonly number[];
  /** Captured AR camera image dimensions before the internal CPU preview crop/scale. */
  readonly capturedImageWidth?: number;
  readonly capturedImageHeight?: number;
  readonly frameNumber: number;
  readonly minDepth: number;
  readonly maxDepth: number;
  readonly meanDepth: number;
  /** Lightweight WebXR mesh objects for `XRFrame.detectedMeshes`; geometry is fetched lazily. */
  readonly detectedMeshes?: readonly NativeWebXRMeshSummary[];
  readonly meshAnchorCount?: number;
  readonly meshTriangleCount?: number;
  readonly meshVertexCount?: number;
}

export interface NativeLiDARDepthFramePayload {
  readonly frameNumber: number;
  /** `width * height * 4` bytes, Float32 depth in meters, no row padding. */
  readonly depthData?: Uint8Array;
  readonly colorData?: Uint8Array;
  readonly colorFormat?: 'bgra8unorm';
  readonly cameraPreviewMs?: number;
  readonly cameraPreviewPath?: 'core-image' | 'ycbcr-direct';
  readonly confidenceFilteredDepthCount?: number;
  readonly confidenceMapUsed?: boolean;
  readonly confidenceFallbackReason?:
    | 'empty-high-confidence'
    | 'empty-medium-confidence'
    | 'sparse-high-confidence'
    | 'sparse-medium-confidence';
  readonly confidenceFallbackUsed?: boolean;
  readonly confidenceThreshold?: number;
  readonly depthCopyMs?: number;
  readonly highConfidenceDepthCount?: number;
  readonly invalidDepthCount?: number;
  readonly lowConfidenceDepthCount?: number;
  readonly minDepth?: number;
  readonly maxDepth?: number;
  readonly mediumConfidenceDepthCount?: number;
  readonly meanDepth?: number;
  readonly payloadMs?: number;
  readonly validDepthCount?: number;
}

export interface NativeWebXRMeshSummary {
  readonly id: string;
  /** ARKit mesh-anchor transform in the WebXR local reference space. */
  readonly transform: readonly number[];
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly lastChangedTime: number;
  readonly semanticLabel?: string | null;
}

export interface NativeWebXRMesh extends NativeWebXRMeshSummary {
  readonly cached?: boolean;
  readonly sourceVertexCount?: number;
  readonly sourceIndexCount?: number;
  /** Tight-packed Float32 xyz triplets in mesh-local coordinates. */
  readonly vertices: Uint8Array;
  /** Tight-packed Float32 xyz triplets in mesh-local coordinates. */
  readonly normals?: Uint8Array;
  /** Tight-packed Uint32 triangle indices. */
  readonly indices: Uint8Array;
}

function unavailable(method: string): never {
  throw new Error(`${method} requires the iOS StandardCamera native backend`);
}

const unavailableConstructor = function UnavailableNativeConstructor(): never {
  return unavailable('StandardCamera constructor');
} as unknown as { new (): never };

const unavailableBackend: NativeStandardCameraModule = {
  MediaStream: unavailableConstructor,
  MediaStreamTrack: unavailableConstructor,
  getUserMediaAsync: () => unavailable('StandardCamera.getUserMediaAsync'),
  enumerateDevicesAsync: () => unavailable('StandardCamera.enumerateDevicesAsync'),
  getSupportedConstraints: () => unavailable('StandardCamera.getSupportedConstraints'),
  createMediaStream: () => unavailable('StandardCamera.createMediaStream'),
  __systemLogForTesting: () => unavailable('StandardCamera.__systemLogForTesting'),
  getDiagnostics: () => unavailable('StandardCamera.getDiagnostics'),
  getLiDARDepthCapabilities: () => unavailable('StandardCamera.getLiDARDepthCapabilities'),
  startLiDARDepthAsync: () => unavailable('StandardCamera.startLiDARDepthAsync'),
  startLiDARDepthWithTypeAsync: () => unavailable('StandardCamera.startLiDARDepthWithTypeAsync'),
  startWebXRLiDARDepthAsync: () => unavailable('StandardCamera.startWebXRLiDARDepthAsync'),
  stopLiDARDepthAsync: () => unavailable('StandardCamera.stopLiDARDepthAsync'),
  stopLiDARDepth: () => unavailable('StandardCamera.stopLiDARDepth'),
  getLatestWebXRLiDARDepthFrame: () => unavailable('StandardCamera.getLatestWebXRLiDARDepthFrame'),
  getWebXRLiDARDepthFramePayload: () => unavailable('StandardCamera.getWebXRLiDARDepthFramePayload'),
  getWebXRLiDARDepthFramePayloadWithOptions: () =>
    unavailable('StandardCamera.getWebXRLiDARDepthFramePayloadWithOptions'),
  getWebXRLiDARDepthFrameMeshes: () => unavailable('StandardCamera.getWebXRLiDARDepthFrameMeshes'),
  addListener: () => unavailable('StandardCamera.addListener'),
};

export default unavailableBackend;
