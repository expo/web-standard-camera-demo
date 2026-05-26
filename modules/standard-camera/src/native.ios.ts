// @ref LLP 0005 — iOS backend for the web-shaped camera API.

import { requireNativeModule } from 'expo';

import type { NativeStandardCameraModule } from './native';

export type {
  AuthorizationStatus,
  NativeDiagnostics,
  NativeLiDARDepthCapabilities,
  NativeLiDARDepthFrame,
  NativeLiDARDepthSessionEvent,
  NativeLiDARDepthSessionState,
  NativeLiDARDepthType,
  NativeMediaStream,
  NativeMediaStreamAudioBuffer,
  NativeMediaStreamFrame,
  NativeMediaStreamTrack,
  NativeStandardCameraModule,
} from './native';

export default requireNativeModule<NativeStandardCameraModule>('StandardCamera');
