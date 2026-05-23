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

  addListener(
    eventName: 'ended' | 'mute' | 'unmute',
    listener: () => void
  ): EventSubscription;
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
}

export default requireNativeModule<NativeStandardCameraModule>('StandardCamera');
