// @ref LLP 0006 — iOS backend for the web-shaped camera API.

import { requireNativeModule } from 'expo';

import type { NativeStandardCameraModule } from './native';

export type {
  AuthorizationStatus,
  NativeDiagnostics,
  NativeLiDARDepthCapabilities,
  NativeLiDARDepthFrame,
  NativeLiDARDepthFramePayload,
  NativeLiDARDepthSessionEvent,
  NativeLiDARDepthSessionState,
  NativeLiDARDepthType,
  NativeWebXRMesh,
  NativeMediaStream,
  NativeMediaStreamAudioBuffer,
  NativeMediaStreamFrame,
  NativeMediaStreamTrack,
  NativeStandardCameraModule,
} from './native';

export default requireNativeModule<NativeStandardCameraModule>('StandardCamera');
