// @ref LLP 0002 — MediaDevices.getUserMedia subset

import { DOMException, rewrapNativeError } from './DOMException';
import { MediaStream } from './MediaStream';
import NativeModule from './native';
import type {
  ConstrainDOMString,
  ConstrainDouble,
  ConstrainULong,
  FlatVideoConstraints,
  MediaDeviceInfo,
  MediaStreamConstraints,
  MediaTrackConstraints,
} from './types';

export class MediaDevices extends EventTarget {
  // @ref LLP 0002 — getUserMedia
  async getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    // @ref LLP 0002#gum-validate-constraints — normalize before sending to native
    const { video, audioRequested } = normalizeConstraints(constraints);

    if (!video && !audioRequested) {
      throw new DOMException(
        'At least one of audio and video must be requested',
        'TypeError'
      );
    }
    if (!video && audioRequested) {
      // We have no audio support; per LLP 0001 this throws OverconstrainedError.
      throw new DOMException(
        'Constraint cannot be satisfied: audio',
        'OverconstrainedError',
        'audio'
      );
    }

    let nativeStream;
    try {
      nativeStream = await NativeModule.getUserMediaAsync({ video, audioRequested });
    } catch (e) {
      rewrapNativeError(e);
    }
    return new MediaStream(nativeStream);
  }

  // @ref LLP 0001#mediadevices-enumeratedevices — stub
  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return NativeModule.enumerateDevicesAsync();
  }

  // @ref LLP 0001#mediadevices-getsupportedconstraints — stub
  getSupportedConstraints(): Record<string, boolean> {
    return NativeModule.getSupportedConstraints();
  }

  // @ref LLP 0001#mediadevices-getdisplaymedia — out of scope
  async getDisplayMedia(_constraints?: MediaStreamConstraints): Promise<MediaStream> {
    throw new DOMException('getDisplayMedia is not supported', 'NotSupportedError');
  }

  private __ondevicechange: ((ev: Event) => void) | null = null;
  get ondevicechange(): ((ev: Event) => void) | null { return this.__ondevicechange; }
  set ondevicechange(handler: ((ev: Event) => void) | null) {
    if (this.__ondevicechange) this.removeEventListener('devicechange', this.__ondevicechange);
    this.__ondevicechange = handler;
    if (handler) this.addEventListener('devicechange', handler);
  }
}

// Singleton (the spec's `navigator.mediaDevices`).
export const mediaDevices = new MediaDevices();

// @ref LLP 0002#gum-validate-constraints — flatten spec constraints to native shape
function normalizeConstraints(c: MediaStreamConstraints | undefined): {
  video: FlatVideoConstraints | undefined;
  audioRequested: boolean;
} {
  if (c == null) {
    return { video: undefined, audioRequested: false };
  }
  if (typeof c !== 'object') {
    throw new DOMException('constraints must be an object', 'TypeError');
  }

  let video: FlatVideoConstraints | undefined;
  if (c.video === true) {
    video = {};
  } else if (c.video && typeof c.video === 'object') {
    video = flattenVideo(c.video);
  }

  return {
    video,
    audioRequested: !!c.audio,
  };
}

function flattenVideo(c: MediaTrackConstraints): FlatVideoConstraints {
  const out: FlatVideoConstraints = {};
  if (c.deviceId !== undefined) {
    const v = pickString(c.deviceId);
    if (v !== undefined) out.deviceId = v;
  }
  if (c.facingMode !== undefined) {
    const v = pickString(c.facingMode);
    if (v !== undefined) out.facingMode = v;
  }
  if (c.width !== undefined) {
    const v = pickNumber(c.width);
    if (v !== undefined) out.width = v;
  }
  if (c.height !== undefined) {
    const v = pickNumber(c.height);
    if (v !== undefined) out.height = v;
  }
  if (c.frameRate !== undefined) {
    const v = pickNumber(c.frameRate);
    if (v !== undefined) out.frameRate = v;
  }
  if (c.aspectRatio !== undefined) {
    const v = pickNumber(c.aspectRatio);
    if (v !== undefined) out.aspectRatio = v;
  }
  return out;
}

function pickString(c: ConstrainDOMString): string | undefined {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c[0];
  if (c && typeof c === 'object') {
    const exact = c.exact;
    if (typeof exact === 'string') return exact;
    if (Array.isArray(exact)) return exact[0];
    const ideal = c.ideal;
    if (typeof ideal === 'string') return ideal;
    if (Array.isArray(ideal)) return ideal[0];
  }
  return undefined;
}

function pickNumber(c: ConstrainULong | ConstrainDouble): number | undefined {
  if (typeof c === 'number') return c;
  if (c && typeof c === 'object') {
    if (typeof c.exact === 'number') return c.exact;
    if (typeof c.ideal === 'number') return c.ideal;
  }
  return undefined;
}
