// Web entry point: expose the browser's own Web APIs. The iOS build uses
// index.ts, whose implementation sits on top of the StandardCamera native
// backend. Web does not implement or emulate that iOS backend.

export { JS_BUILD_TIME } from './src/build-info';
export { Video } from './src/HTMLVideoElement';
export type { HTMLVideoElement, VideoProps } from './src/HTMLVideoElement';

type GlobalWithWebCapture = typeof globalThis & {
  ImageCapture?: new (track: globalThis.MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> };
  MediaDevices?: new () => globalThis.MediaDevices;
};

const g = globalThis as GlobalWithWebCapture;

export const DOMException = globalThis.DOMException;
export const MediaStream = globalThis.MediaStream;
export const MediaStreamTrack = globalThis.MediaStreamTrack;
export const MediaDevices = g.MediaDevices;
export const mediaDevices = globalThis.navigator?.mediaDevices;

export class ImageCapture {
  readonly track: globalThis.MediaStreamTrack;
  #impl: { grabFrame(): Promise<ImageBitmap> };

  constructor(track: globalThis.MediaStreamTrack) {
    if (!g.ImageCapture) {
      throw new DOMException('ImageCapture is not available in this browser', 'NotSupportedError');
    }
    this.track = track;
    this.#impl = new g.ImageCapture(track);
  }

  grabFrame(): Promise<ImageBitmap> {
    return this.#impl.grabFrame();
  }
}

export type CameraImageBitmap = ImageBitmap;

export function installNavigatorMediaDevices(): void {
  // Browsers already own navigator.mediaDevices. Installing the iOS polyfill
  // here would replace the real Web API the project is trying to match.
}

export const testing = {
  getRegisteredTests(): [] {
    return [];
  },
  async runAllTests(): Promise<void> {},
};

export {
  WebXRCPUCameraBinding,
  WebXRCPUDepthInformation,
  WebXRCPUCameraImage,
  WebXRCamera,
  WebXRFrame,
  WebXRMesh,
  WebXRMeshSet,
  WebXRMeshSpace,
  WebXRPose,
  WebXRReferenceSpace,
  WebXRRigidTransform,
  WebXRSession,
  WebXRSystem,
  WebXRView,
  WebXRViewerPose,
  installWebXRDepthProfile,
  runWithWebXRUserActivation,
  setWebXRDepthCameraLockHandlers,
} from './src/WebXRDepthProfile.web';
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
} from './src/WebXRDepthProfile.web';

export type {
  ConstrainBoolean,
  ConstrainDOMString,
  ConstrainDouble,
  ConstrainULong,
  MediaDeviceInfo,
  MediaStreamConstraints,
  MediaStreamTrackKind,
  MediaStreamTrackState,
  MediaTrackCapabilities,
  MediaTrackConstraints,
  MediaTrackSettings,
} from './src/types';
