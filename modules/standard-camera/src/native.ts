// @ref LLP 0005 — native module bridge; JS-side handles to SharedObjects

import { requireNativeModule } from 'expo';
import type { EventSubscription } from 'expo-modules-core';

import type {
  FlatGetUserMediaConstraints,
  MediaDeviceInfo,
  MediaTrackSettings,
  MediaTrackCapabilities,
  MediaStreamTrackKind,
  MediaStreamTrackState,
} from './types';

// @ref LLP 0009#audio-track-events — Audio interruption notifications come
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
  // @ref LLP 0008#dom-mediastreamtrack-clone
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
  // @ref LLP 0008#dom-mediastream-addtrack
  addTrack(track: NativeMediaStreamTrack): void;
  // @ref LLP 0008#dom-mediastream-removetrack
  removeTrack(track: NativeMediaStreamTrack): void;
  // @ref LLP 0008#dom-mediastream-clone
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

interface NativeStandardCameraModule {
  // Constructor handles (no public constructors, but the class object is exposed).
  MediaStream: { new (): never };
  MediaStreamTrack: { new (): never };

  getUserMediaAsync(constraints: FlatGetUserMediaConstraints): Promise<NativeMediaStream>;
  enumerateDevicesAsync(): Promise<MediaDeviceInfo[]>;
  getSupportedConstraints(): Record<string, boolean>;
  // @ref LLP 0008#mediastream-constructor
  createMediaStream(tracks: NativeMediaStreamTrack[]): NativeMediaStream;
  /** @internal Test-only: forward a message to NSLog so it reaches `simctl log stream` regardless of build config. */
  __systemLogForTesting(message: string): void;
  /** Read-only diagnostics. Permission lookups do NOT trigger iOS prompts. */
  getDiagnostics(): NativeDiagnostics;
  /**
   * @internal Demo-only LiDAR extension. This is intentionally not part of the
   * W3C Media Capture surface; see LLP 0012.
   */
  getLiDARDepthCapabilities(): NativeLiDARDepthCapabilities;
  startLiDARDepthAsync(): Promise<NativeLiDARDepthCapabilities>;
  startLiDARDepthWithTypeAsync(depthType: NativeLiDARDepthType): Promise<NativeLiDARDepthCapabilities>;
  stopLiDARDepthAsync(): Promise<void>;
  stopLiDARDepth(): void;
  getLatestLiDARDepthFrame(): NativeLiDARDepthFrame | null;
  getLatestWebXRLiDARDepthFrame(): NativeLiDARDepthFrame | null;
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

export interface NativeLiDARDepthCapabilities {
  readonly supported: boolean;
  readonly running: boolean;
  readonly state?: NativeLiDARDepthSessionState;
  readonly sessionId?: number;
  readonly frameNumber?: number;
  readonly sceneDepth: boolean;
  readonly smoothedSceneDepth: boolean;
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
  /** `width * height * 4` bytes, Float32 depth in meters, no row padding. */
  readonly depthData: Uint8Array;
  readonly depthFormat: 'r32float';
  readonly depthType?: NativeLiDARDepthType;
  /** ARFrame.timestamp, seconds on ARKit's monotonic clock. */
  readonly timestamp?: number;
  /** Column-major 4x4 matrices in WebXR-compatible order. */
  readonly projectionMatrix?: readonly number[];
  readonly viewTransform?: readonly number[];
  readonly normDepthBufferFromNormView?: readonly number[];
  /** ARKit camera preview paired with the depth frame, when available. */
  readonly colorWidth?: number;
  readonly colorHeight?: number;
  readonly colorData?: Uint8Array;
  readonly colorFormat?: 'bgra8unorm';
  readonly normCameraImageFromNormView?: readonly number[];
  readonly frameNumber: number;
  readonly minDepth: number;
  readonly maxDepth: number;
  readonly meanDepth: number;
}

export default requireNativeModule<NativeStandardCameraModule>('StandardCamera');
