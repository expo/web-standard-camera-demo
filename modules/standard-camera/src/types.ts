// @ref LLP 0001 — TypeScript types mirroring the spec subset

export type ConstrainDOMString = string | string[] | { exact?: string | string[]; ideal?: string | string[] };
export type ConstrainULong = number | { exact?: number; ideal?: number; min?: number; max?: number };
export type ConstrainDouble = number | { exact?: number; ideal?: number; min?: number; max?: number };
export type ConstrainBoolean = boolean | { exact?: boolean; ideal?: boolean };

export interface MediaTrackConstraints {
  deviceId?: ConstrainDOMString;
  groupId?: ConstrainDOMString;
  facingMode?: ConstrainDOMString;
  width?: ConstrainULong;
  height?: ConstrainULong;
  frameRate?: ConstrainDouble;
  aspectRatio?: ConstrainDouble;
}

export interface MediaStreamConstraints {
  video?: boolean | MediaTrackConstraints;
  audio?: boolean | MediaTrackConstraints;
}

export interface MediaTrackSettings {
  deviceId?: string;
  groupId?: string;
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
  frameRate?: number;
  aspectRatio?: number;
}

export interface MediaTrackCapabilities {
  // Empty in v1 per LLP 0001.
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
export interface FlatVideoConstraints {
  deviceId?: string;
  facingMode?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  aspectRatio?: number;
}

export interface FlatGetUserMediaConstraints {
  video?: FlatVideoConstraints;
  audioRequested?: boolean;
}
