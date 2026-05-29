// @ref LLP 0002 — TypeScript types mirroring the spec subset

export type ConstrainDOMString = string | string[] | { exact?: string | string[]; ideal?: string | string[] };
export type ConstrainULong = number | { exact?: number; ideal?: number; min?: number; max?: number };
export type ConstrainDouble = number | { exact?: number; ideal?: number; min?: number; max?: number };
export type ConstrainBoolean = boolean | { exact?: boolean; ideal?: boolean };
// @ref LLP 0001#echocancellationmode — boolean | "all" | "remote-only"
export type ConstrainBooleanOrEchoCancellationMode =
  | boolean
  | 'all'
  | 'remote-only'
  | {
      exact?: boolean | 'all' | 'remote-only';
      ideal?: boolean | 'all' | 'remote-only';
    };

export interface MediaTrackConstraints {
  // Shared between video and audio
  deviceId?: ConstrainDOMString;
  groupId?: ConstrainDOMString;
  // Video
  facingMode?: ConstrainDOMString;
  width?: ConstrainULong;
  height?: ConstrainULong;
  frameRate?: ConstrainDouble;
  aspectRatio?: ConstrainDouble;
  // Audio — @ref LLP 0001#audio-properties
  sampleRate?: ConstrainULong;
  sampleSize?: ConstrainULong;
  channelCount?: ConstrainULong;
  latency?: ConstrainDouble;
  echoCancellation?: ConstrainBooleanOrEchoCancellationMode;
  autoGainControl?: ConstrainBoolean;
  noiseSuppression?: ConstrainBoolean;
  voiceIsolation?: ConstrainBoolean;
}

export interface MediaStreamConstraints {
  video?: boolean | MediaTrackConstraints;
  audio?: boolean | MediaTrackConstraints;
}

// @ref LLP 0001#video-properties — Constrainable video track settings.
// @ref LLP 0001#audio-properties — Constrainable audio track settings (below).
export interface MediaTrackSettings {
  // Shared
  deviceId?: string;
  groupId?: string;
  // Video
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
  frameRate?: number;
  aspectRatio?: number;
  resizeMode?: 'none' | 'crop-and-scale';
  // Audio — @ref LLP 0001#audio-properties
  sampleRate?: number;
  sampleSize?: number;
  channelCount?: number;
  latency?: number;
  echoCancellation?: boolean | 'all' | 'remote-only';
  autoGainControl?: boolean;
  noiseSuppression?: boolean;
  voiceIsolation?: boolean;
}

export interface MediaTrackCapabilities {
  // Video and audio capability shape — see LLP 0008#audio-track-capabilities for audio,
  // LLP 0004#track-getCapabilities for video.
  [key: string]: unknown;
}

export type MediaStreamTrackKind = 'video' | 'audio';
export type MediaStreamTrackState = 'live' | 'ended';

export interface MediaDeviceInfo {
  deviceId: string;
  groupId: string;
  kind: 'videoinput' | 'audioinput' | 'audiooutput';
  label: string;
}

// Flat constraints sent to native — JS normalizes web shape to this.
// @ref LLP 0001#video-properties — resizeMode is one of the constrainable
// video properties. `'none'` means deliver frames at the device's native
// dimensions; `'crop-and-scale'` opts into the source-side crop+scale stage
// in FrameSink that satisfies `width` / `height` constraints that no native
// AVCaptureDevice format would otherwise hit. See LLP 0002's
// "`resizeMode: \"crop-and-scale\"` is in scope" callout for the scope
// decision and where the implementation lives.
export interface FlatVideoConstraints {
  deviceId?: string;
  facingMode?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  aspectRatio?: number;
  resizeMode?: 'none' | 'crop-and-scale';
}

// @ref LLP 0003#surface-accepted-from-js — Flat audio constraints. We split
// `echoCancellation`'s `boolean | "all" | "remote-only"` shape into two
// scalar fields so the native Record can stay strongly typed; the original
// caller-supplied value is recovered on `getSettings()`.
// `groupId` is passed separately from `deviceId` so unsatisfied groupId
// requests reject with `OverconstrainedError(constraint: "groupId")` rather
// than collapsing into a "deviceId" rejection.
export interface FlatAudioConstraints {
  deviceId?: string;
  groupId?: string;
  sampleRate?: number;
  sampleSize?: number;
  channelCount?: number;
  latency?: number;
  echoCancellation?: boolean;
  echoCancellationMode?: 'all' | 'remote-only';
  autoGainControl?: boolean;
  noiseSuppression?: boolean;
  voiceIsolation?: boolean;
}

export interface FlatGetUserMediaConstraints {
  video?: FlatVideoConstraints;
  audio?: FlatAudioConstraints;
}
