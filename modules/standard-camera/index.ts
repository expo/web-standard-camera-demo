// @ref LLP 0000 — standard-camera module entry point

// Hermes V1 (RN 0.85) does not ship globalThis.EventTarget / Event. Load the
// polyfill before any class that extends EventTarget is evaluated by the
// re-exports below.
import 'event-target-polyfill';

export { JS_BUILD_TIME } from './src/build-info';
export { default as NativeStandardCamera } from './src/native';
export type {
  AuthorizationStatus,
  NativeDiagnostics,
  NativeLiDARDepthCapabilities,
  NativeLiDARDepthFrame,
  NativeLiDARDepthSessionEvent,
  NativeLiDARDepthSessionState,
} from './src/native';
export { DOMException } from './src/DOMException';
export { ImageCapture } from './src/ImageCapture';
export type { CameraImageBitmap } from './src/ImageCapture';
export { MediaDevices, mediaDevices } from './src/MediaDevices';
export { MediaStream } from './src/MediaStream';
export { MediaStreamTrack } from './src/MediaStreamTrack';
export { Video } from './src/HTMLVideoElement';
export type { HTMLVideoElement, VideoProps } from './src/HTMLVideoElement';
export {
  WebXRCPUDepthInformation,
  WebXRCPUCameraImage,
  WebXRCamera,
  WebXRFrame,
  WebXRReferenceSpace,
  WebXRRigidTransform,
  WebXRSession,
  WebXRSystem,
  WebXRView,
  WebXRViewerPose,
  installWebXRDepthProfile,
  runWithWebXRUserActivation,
  setWebXRDepthCameraLockHandlers,
} from './src/WebXRDepthProfile';
export type {
  WebXRCameraAccessStateInit,
  WebXRCameraFormat,
  WebXRCameraUsage,
  WebXRDepthDataFormat,
  WebXRDepthStateInit,
  WebXRDepthType,
  WebXRDepthUsage,
  WebXRFeatureDescriptor,
  WebXRFrameRequestCallback,
  WebXRReferenceSpaceType,
  WebXRSessionInit,
  WebXRSessionMode,
} from './src/WebXRDepthProfile';
export type {
  MediaStreamConstraints,
  MediaTrackConstraints,
  MediaTrackSettings,
  MediaTrackCapabilities,
  MediaDeviceInfo,
  MediaStreamTrackKind,
  MediaStreamTrackState,
  ConstrainDOMString,
  ConstrainULong,
  ConstrainDouble,
  ConstrainBoolean,
} from './src/types';
export { installNavigatorMediaDevices } from './src/install';
export * as testing from './src/testing';
