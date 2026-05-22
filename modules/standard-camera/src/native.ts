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

// JS-side handle to native MediaStreamTrack SharedObject.
export interface NativeMediaStreamTrack {
  readonly id: string;
  readonly kind: MediaStreamTrackKind;
  readonly label: string;
  enabled: boolean;
  readonly muted: boolean;
  readonly readyState: MediaStreamTrackState;

  stop(): void;
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
}

export default requireNativeModule<NativeStandardCameraModule>('StandardCamera');
