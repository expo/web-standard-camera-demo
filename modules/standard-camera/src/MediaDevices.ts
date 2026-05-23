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

// Per spec, `enumerateDevices()` exposes deviceId/label/groupId only after the
// caller has successfully gotten a stream of the matching kind via gUM. This
// flag mirrors that — false until a successful `getUserMedia({video:…})`.
let hasGrantedVideo = false;

// Subscribers (PermissionStatus instances) waiting to be notified when a
// permission flips. The shim in `dom-shim.ts` registers callbacks here so the
// `change` event fires on its PermissionStatus objects when gUM succeeds.
const grantSubscribers = new Set<(name: 'camera' | 'microphone') => void>();

/** @internal Subscribe to permission-grant flips for the testing permissions
 *  shim. Returns an unsubscribe function. */
export function __subscribeCaptureGrantsForTesting(
  fn: (name: 'camera' | 'microphone') => void
): () => void {
  grantSubscribers.add(fn);
  return () => grantSubscribers.delete(fn);
}

function notifyGrantsChanged(name: 'camera' | 'microphone'): void {
  for (const fn of grantSubscribers) {
    try {
      fn(name);
    } catch {
      // ignore
    }
  }
}

/** @internal Test-only hook: forget that the user has gotten a stream yet so
 *  the next `enumerateDevices()` returns the gated, empty form. Called by the
 *  WPT runner between tests so per-test isolation matches a fresh document. */
export function __resetCaptureGrantsForTesting(): void {
  hasGrantedVideo = false;
}

/** @internal Test-only hook: surface the current grant state to the
 *  in-app permissions stub so `navigator.permissions.query({name:'camera'})`
 *  flips to `granted` after a successful video gUM. */
export function __getCaptureGrantsForTesting(): { camera: boolean; microphone: boolean } {
  return { camera: hasGrantedVideo, microphone: false };
}

export class MediaDevices extends EventTarget {
  // @ref LLP 0002 — getUserMedia
  async getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    // @ref LLP 0002#gum-validate-constraints — normalize before sending to native
    const { video, audioRequested } = normalizeConstraints(constraints);

    if (!video && !audioRequested) {
      // Per spec, this is a JS `TypeError`, not a DOMException with the
      // TypeError name. The WPT `GUM-empty-option-param` test asserts
      // `e instanceof TypeError`, which requires a real `TypeError`.
      throw new TypeError('At least one of audio and video must be requested');
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
    if (video && !hasGrantedVideo) {
      hasGrantedVideo = true;
      notifyGrantsChanged('camera');
    }
    // @ref LLP 0003#stream-construction — internal native-handle path
    return new MediaStream(nativeStream);
  }

  // @ref LLP 0008#dom-mediadevices-enumeratedevices — Returns a list of
  // `MediaDeviceInfo` (or its subclass `InputDeviceInfo` for input devices)
  // describing each device. Per spec, until the caller has successfully
  // captured a stream of the matching kind, `deviceId` / `label` / `groupId`
  // MUST be empty strings — the rationale is that these fields can fingerprint
  // a user across origins, so they're gated behind explicit user grant.
  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    const raw = await NativeModule.enumerateDevicesAsync();
    const InputDeviceInfoCls = (globalThis as unknown as {
      InputDeviceInfo?: new () => MediaDeviceInfo & { __capabilities?: Record<string, unknown> };
    }).InputDeviceInfo;
    return raw.map((d) => {
      // Capabilities for the device itself (independent of whether the caller
      // has captured a stream yet). Mirrors the per-track getCapabilities()
      // shape so InputDeviceInfo.getCapabilities() is non-empty.
      const capabilities: Record<string, unknown> = d.kind === 'videoinput'
        ? {
            width: { min: 0, max: 1920 },
            height: { min: 0, max: 1080 },
            aspectRatio: { min: 0, max: 16 / 9 },
            frameRate: { min: 0, max: 60 },
            facingMode: ['environment'],
            resizeMode: ['none'],
            deviceId: hasGrantedVideo ? d.deviceId : '',
            groupId: hasGrantedVideo ? d.groupId : '',
          }
        : {};

      const info: MediaDeviceInfo = {
        deviceId: hasGrantedVideo ? d.deviceId : '',
        label: hasGrantedVideo ? d.label : '',
        groupId: hasGrantedVideo ? d.groupId : '',
        kind: d.kind,
      };

      if (InputDeviceInfoCls && (d.kind === 'videoinput' || d.kind === 'audioinput')) {
        const instance = new InputDeviceInfoCls();
        Object.assign(instance, info);
        instance.__capabilities = capabilities;
        return instance as unknown as MediaDeviceInfo;
      }
      return info;
    });
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

// @ref LLP 0002#gum-validate-constraints — Capability ranges for the
// builtInWideAngleCamera devices we target. Used to reject impossible
// `min`/`max` constraints before the bridge call.
const DEVICE_RANGES: Record<'width' | 'height' | 'frameRate' | 'aspectRatio', { min: number; max: number }> = {
  width: { min: 0, max: 4032 },
  height: { min: 0, max: 3024 },
  frameRate: { min: 0, max: 60 },
  aspectRatio: { min: 0, max: 16 / 9 },
};

// @ref LLP 0002#gum-pick-device — We can only deliver `AVCaptureSession.Preset`
// resolutions; any `{exact}` value outside this discrete set is unsatisfiable.
const DELIVERABLE_DIMENSIONS = {
  width: new Set([352, 640, 960, 1280, 1920, 3840]),
  height: new Set([288, 480, 540, 720, 1080, 2160]),
};

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
    validateNumericConstraint('width', c.width);
    const v = pickNumber(c.width);
    if (v !== undefined) out.width = v;
  }
  if (c.height !== undefined) {
    validateNumericConstraint('height', c.height);
    const v = pickNumber(c.height);
    if (v !== undefined) out.height = v;
  }
  if (c.frameRate !== undefined) {
    validateNumericConstraint('frameRate', c.frameRate);
    const v = pickNumber(c.frameRate);
    if (v !== undefined) out.frameRate = v;
  }
  if (c.aspectRatio !== undefined) {
    validateNumericConstraint('aspectRatio', c.aspectRatio);
    const v = pickNumber(c.aspectRatio);
    if (v !== undefined) out.aspectRatio = v;
  }
  // resizeMode is exposed as a constraint but we only support "none". Reject
  // `{exact: <not-none>}` up front; otherwise accept any basic/ideal value
  // (per spec, ideals are best-effort and getSettings reports what we picked).
  if ((c as { resizeMode?: unknown }).resizeMode !== undefined) {
    const rm = (c as { resizeMode?: unknown }).resizeMode;
    const exact =
      rm && typeof rm === 'object' ? (rm as { exact?: unknown }).exact : undefined;
    if (typeof exact === 'string' && exact !== 'none') {
      throw new DOMException(
        'Constraint cannot be satisfied: resizeMode',
        'OverconstrainedError',
        'resizeMode'
      );
    }
  }
  return out;
}

// @ref LLP 0008#error-overconstrainederror — Reject `min`/`max` ranges that
// can't be satisfied by any AVCaptureDevice we'd return.
function validateNumericConstraint(
  name: 'width' | 'height' | 'frameRate' | 'aspectRatio',
  c: ConstrainULong | ConstrainDouble
): void {
  if (typeof c === 'number') return;
  if (!c || typeof c !== 'object') return;
  const range = DEVICE_RANGES[name];
  const min = (c as { min?: number }).min;
  const max = (c as { max?: number }).max;
  const exact = (c as { exact?: number }).exact;
  if (typeof max === 'number' && max <= 0) {
    throw new DOMException(
      `Constraint cannot be satisfied: ${name}`,
      'OverconstrainedError',
      name
    );
  }
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    throw new DOMException(
      `Constraint cannot be satisfied: ${name}`,
      'OverconstrainedError',
      name
    );
  }
  if (typeof min === 'number' && min > range.max) {
    throw new DOMException(
      `Constraint cannot be satisfied: ${name}`,
      'OverconstrainedError',
      name
    );
  }
  if (typeof max === 'number' && max < range.min) {
    throw new DOMException(
      `Constraint cannot be satisfied: ${name}`,
      'OverconstrainedError',
      name
    );
  }
  if (typeof exact === 'number' && (exact < range.min || exact > range.max)) {
    throw new DOMException(
      `Constraint cannot be satisfied: ${name}`,
      'OverconstrainedError',
      name
    );
  }
  // Width/height: even within range we can only deliver `AVCaptureSession`
  // preset dimensions, so reject any `exact` value that isn't one of them.
  if (typeof exact === 'number' && (name === 'width' || name === 'height')) {
    const deliverable = DELIVERABLE_DIMENSIONS[name];
    if (!deliverable.has(exact)) {
      throw new DOMException(
        `Constraint cannot be satisfied: ${name}`,
        'OverconstrainedError',
        name
      );
    }
  }
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
