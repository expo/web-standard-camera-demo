// @ref LLP 0000 — standard-camera module entry point

// Hermes V1 (RN 0.85) does not ship globalThis.EventTarget / Event. Load the
// polyfill before any class that extends EventTarget is evaluated by the
// re-exports below.
import 'event-target-polyfill';

export { DOMException } from './src/DOMException';
export { MediaDevices, mediaDevices } from './src/MediaDevices';
export { MediaStream } from './src/MediaStream';
export { MediaStreamTrack } from './src/MediaStreamTrack';
export { Video } from './src/HTMLVideoElement';
export type { HTMLVideoElement, VideoProps } from './src/HTMLVideoElement';
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
