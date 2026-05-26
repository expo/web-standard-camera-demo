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
  stopLiDARDepthAsync(): Promise<void>;
  stopLiDARDepth(): void;
  getLatestLiDARDepthFrame(): NativeLiDARDepthFrame | null;
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

export interface NativeLiDARDepthCapabilities {
  readonly supported: boolean;
  readonly running: boolean;
  readonly state?: NativeLiDARDepthSessionState;
  readonly sessionId?: number;
  readonly frameNumber?: number;
  readonly sceneDepth: boolean;
  readonly smoothedSceneDepth: boolean;
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
  /** Low-resolution ARKit camera preview paired with the depth frame, when available. */
  readonly colorWidth?: number;
  readonly colorHeight?: number;
  readonly colorData?: Uint8Array;
  readonly colorFormat?: 'bgra8unorm';
  readonly frameNumber: number;
  readonly minDepth: number;
  readonly maxDepth: number;
  readonly meanDepth: number;
}

export default requireNativeModule<NativeStandardCameraModule>('StandardCamera');
