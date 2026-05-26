// @ref LLP 0002 — MediaDevices.getUserMedia subset

import { DOMException, rewrapNativeError } from './DOMException';
import { MediaStream } from './MediaStream';
import NativeModule from './native';
import type {
  ConstrainDOMString,
  ConstrainDouble,
  ConstrainULong,
  FlatAudioConstraints,
  FlatVideoConstraints,
  MediaDeviceInfo,
  MediaStreamConstraints,
  MediaTrackConstraints,
} from './types';

// Per spec, `enumerateDevices()` exposes deviceId/label/groupId only after the
// caller has successfully gotten a stream of the matching kind via gUM. These
// flags mirror that — flipped on a successful getUserMedia of the matching kind.
// @ref LLP 0002#gum-pick-device — pre-grant gating
let hasGrantedVideo = false;
let hasGrantedAudio = false;

// Subscribers (PermissionStatus instances) waiting to be notified when a
// permission flips. The shim in `dom-shim.ts` registers callbacks here so the
// `change` event fires on its PermissionStatus objects when gUM succeeds.
const grantSubscribers = new Set<(name: 'camera' | 'microphone') => void>();

// Test-only synthetic denial set. WPT bodies call `setMediaPermission('denied')`
// from the harness; the harness stores the kinds in a set and we consult it
// here so gUM rejects with `NotAllowedError` for the matching kind. In a
// browser this would be wired through test_driver; in our Expo-app context
// we play the UA's role, so a programmatic hook is the natural fit.
// @ref LLP 0008#error-notallowederror
let testDeniedCheck: (() => { camera: boolean; microphone: boolean }) | null = null;

/** @internal Test-only hook: install a function the gUM path calls to check
 *  whether a kind is synthetically denied by `setMediaPermission('denied')`. */
export function __installTestDeniedCheck(
  fn: (() => { camera: boolean; microphone: boolean }) | null
): void {
  testDeniedCheck = fn;
}

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
  hasGrantedAudio = false;
}

/** @internal Test-only hook: surface the current grant state to the
 *  in-app permissions stub so `navigator.permissions.query({name:'camera'})`
 *  / `{name:'microphone'}` flip to `granted` after a successful gUM. */
export function __getCaptureGrantsForTesting(): { camera: boolean; microphone: boolean } {
  return { camera: hasGrantedVideo, microphone: hasGrantedAudio };
}

// @ref LLP 0008#dom-mediadevices — MediaDevices interface
export class MediaDevices extends EventTarget {
  // @ref LLP 0002 — getUserMedia
  async getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    // @ref LLP 0002#gum-validate-constraints — normalize before sending to native
    const { video, audio } = normalizeConstraints(constraints);

    if (!video && !audio) {
      // @ref LLP 0008#error-typeerror — Per spec, "neither audio nor video"
      // is a JS `TypeError`, not a DOMException with name "TypeError". The
      // WPT `GUM-empty-option-param` test asserts `e instanceof TypeError`,
      // which requires a real `TypeError`.
      throw new TypeError('At least one of audio and video must be requested');
    }

    // @ref LLP 0008#error-notallowederror — Synthetic denial set by
    // `setMediaPermission('denied')` (WPT helper). We're the UA in this
    // context, so honoring the test-driver-style denial here is legitimate.
    const denied = testDeniedCheck?.();
    if (denied && ((video && denied.camera) || (audio && denied.microphone))) {
      throw new DOMException('Permission denied', 'NotAllowedError');
    }

    let nativeStream;
    try {
      nativeStream = await NativeModule.getUserMediaAsync({ video, audio });
    } catch (e) {
      rewrapNativeError(e);
    }
    if (video && !hasGrantedVideo) {
      hasGrantedVideo = true;
      notifyGrantsChanged('camera');
    }
    if (audio && !hasGrantedAudio) {
      hasGrantedAudio = true;
      notifyGrantsChanged('microphone');
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
    let raw = await NativeModule.enumerateDevicesAsync();
    // @ref LLP 0008#mediadevices-enumeratedevices — Per spec, if the document
    // does not have permission to use a device of a kind, the UA MUST report
    // at most one device of that kind (and with empty deviceId/label/groupId).
    // Collapse each kind to a single representative pre-grant. WPT's
    // enumerateDevices test asserts audioinput precedes videoinput in the
    // returned list, so emit in that order.
    //
    // The synthetic denial set populated by `setMediaPermission('denied')`
    // models the spec's "blocked by Permissions-Policy" case, where the
    // document permanently can't use the kind: `enumerateDevices` then
    // omits the kind entirely (not the pre-grant "one empty entry"
    // representation). The upstream `MediaDevices-enumerateDevices-not-
    // allowed-{camera,mic}` tests assert exactly this.
    const denied = testDeniedCheck?.() ?? { camera: false, microphone: false };
    const out: typeof raw = [];
    if (!denied.microphone) {
      if (hasGrantedAudio) {
        out.push(...raw.filter((d) => d.kind === 'audioinput'));
      } else {
        const firstAudio = raw.find((d) => d.kind === 'audioinput');
        if (firstAudio) out.push(firstAudio);
      }
    }
    if (!denied.camera) {
      if (hasGrantedVideo) {
        out.push(...raw.filter((d) => d.kind === 'videoinput'));
      } else {
        const firstVideo = raw.find((d) => d.kind === 'videoinput');
        if (firstVideo) out.push(firstVideo);
      }
    }
    raw = out;
    const InputDeviceInfoCls = (globalThis as unknown as {
      InputDeviceInfo?: new () => MediaDeviceInfo & { __capabilities?: Record<string, unknown> };
    }).InputDeviceInfo;
    return raw.map((d) => {
      const granted = d.kind === 'videoinput' ? hasGrantedVideo : hasGrantedAudio;
      // Capabilities for the device itself (independent of whether the caller
      // has captured a stream yet). Mirrors the per-track getCapabilities()
      // shape so InputDeviceInfo.getCapabilities() is non-empty.
      // @ref LLP 0009#audio-track-capabilities — audio device capabilities
      const capabilities: Record<string, unknown> = d.kind === 'videoinput'
        ? {
            width: { min: 0, max: 1920 },
            height: { min: 0, max: 1080 },
            aspectRatio: { min: 0, max: 16 / 9 },
            frameRate: { min: 0, max: 60 },
            facingMode: ['environment'],
            // @ref LLP 0008#video-properties — Both `resizeMode` values are
            // in scope (see LLP 0001). Native track-level capabilities have
            // a matching entry — see `MediaStreamTrack.swift` videoCapabilities.
            resizeMode: ['none', 'crop-and-scale'],
            deviceId: granted ? d.deviceId : '',
            groupId: granted ? d.groupId : '',
          }
        : d.kind === 'audioinput'
          ? {
              sampleRate: { min: 8000, max: 96000 },
              sampleSize: { min: 16, max: 16 },
              echoCancellation: [true, false],
              autoGainControl: [true, false],
              noiseSuppression: [true, false],
              voiceIsolation: [true, false],
              latency: { min: 0, max: 1 },
              channelCount: { min: 1, max: 2 },
              deviceId: granted ? d.deviceId : '',
              groupId: granted ? d.groupId : '',
            }
          : {};

      const info: MediaDeviceInfo = {
        deviceId: granted ? d.deviceId : '',
        label: granted ? d.label : '',
        groupId: granted ? d.groupId : '',
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
  audio: FlatAudioConstraints | undefined;
} {
  if (c == null) {
    return { video: undefined, audio: undefined };
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

  let audio: FlatAudioConstraints | undefined;
  if (c.audio === true) {
    audio = {};
  } else if (c.audio && typeof c.audio === 'object') {
    audio = flattenAudio(c.audio);
  }

  return { video, audio };
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
    // Empty `deviceId` is unmatchable — no `AVCaptureDevice.uniqueID` is the
    // empty string. Without this guard, the native side treats `deviceId: ""`
    // as "no constraint" and silently returns the default device. WPT's
    // `MediaDevices-enumerateDevices` iterates over the pre-grant audio
    // placeholder (groupId === "") and expects `OverconstrainedError`.
    if (v === '') {
      throw new DOMException('Constraint cannot be satisfied: deviceId', 'OverconstrainedError', 'deviceId');
    }
    if (v !== undefined) out.deviceId = v;
  }
  // @ref LLP 0002#gum-pick-device — In v1 each `AVCaptureDevice.uniqueID` is
  // used as both `deviceId` and `groupId`, so a `groupId: {exact}` constraint
  // resolves to the same device as the corresponding `deviceId: {exact}`.
  // Map it across when the caller specified only `groupId`, so the native
  // pickDevice path can honor it without a separate constraint field. We
  // surface unmatchable empty `groupId` here too so the rejected constraint
  // name comes back as `"groupId"` rather than `"deviceId"`.
  if (out.deviceId === undefined && (c as { groupId?: ConstrainDOMString }).groupId !== undefined) {
    const v = pickString((c as { groupId: ConstrainDOMString }).groupId);
    if (v === '') {
      throw new DOMException('Constraint cannot be satisfied: groupId', 'OverconstrainedError', 'groupId');
    }
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
  // @ref LLP 0008#video-properties — `resizeMode` ∈ {"none","crop-and-scale"}.
  // Both values are in scope per LLP 0001. Reject `{exact: <anything else>}`
  // with `OverconstrainedError(resizeMode)` per spec; basic/ideal forms are
  // best-effort, and the actual value we ended up running is what
  // `getSettings().resizeMode` reports.
  if ((c as { resizeMode?: unknown }).resizeMode !== undefined) {
    const rm = (c as { resizeMode?: unknown }).resizeMode;
    const exact =
      rm && typeof rm === 'object' ? (rm as { exact?: unknown }).exact : undefined;
    const basic = typeof rm === 'string' ? rm : undefined;
    if (typeof exact === 'string' && exact !== 'none' && exact !== 'crop-and-scale') {
      throw new DOMException(
        'Constraint cannot be satisfied: resizeMode',
        'OverconstrainedError',
        'resizeMode'
      );
    }
    // Forward the requested value (whether from `exact`, `ideal`, or a bare
    // string) to native so the FrameSink crop+scale stage can opt in.
    // Unrecognized basic / ideal values fall back to `'none'` since the spec
    // treats them as best-effort hints rather than hard rejections.
    const requested = exact ?? basic ?? (rm && typeof rm === 'object' ? (rm as { ideal?: unknown }).ideal : undefined);
    if (typeof requested === 'string') {
      out.resizeMode = requested === 'crop-and-scale' ? 'crop-and-scale' : 'none';
    }
  }
  return out;
}

// @ref LLP 0009#audio-track-capabilities — Ranges supported by AVAudioSession
// for audio capture. Used to reject impossible `min`/`max` constraints before
// the bridge call.
const AUDIO_DEVICE_RANGES: Record<'sampleRate' | 'sampleSize' | 'channelCount' | 'latency', { min: number; max: number }> = {
  sampleRate: { min: 8000, max: 96000 },
  sampleSize: { min: 16, max: 16 },
  channelCount: { min: 1, max: 2 },
  latency: { min: 0, max: 1 },
};

function flattenAudio(c: MediaTrackConstraints): FlatAudioConstraints {
  const out: FlatAudioConstraints = {};
  if (c.deviceId !== undefined) {
    const v = pickString(c.deviceId);
    if (v !== undefined) out.deviceId = v;
  }
  // groupId is forwarded separately so an unsatisfied groupId rejects with
  // `OverconstrainedError(constraint: "groupId")` rather than collapsing
  // into a "deviceId" rejection. The WPT `groupId is correctly supported
  // by getUserMedia() for audio devices` test asserts the constraint name
  // matches.
  if ((c as { groupId?: ConstrainDOMString }).groupId !== undefined) {
    const v = pickString((c as { groupId: ConstrainDOMString }).groupId);
    if (v !== undefined) out.groupId = v;
  }
  if (c.sampleRate !== undefined) {
    validateAudioNumericConstraint('sampleRate', c.sampleRate);
    const v = pickNumber(c.sampleRate);
    if (v !== undefined) out.sampleRate = v;
  }
  if (c.sampleSize !== undefined) {
    validateAudioNumericConstraint('sampleSize', c.sampleSize);
    const v = pickNumber(c.sampleSize);
    if (v !== undefined) out.sampleSize = v;
  }
  if (c.channelCount !== undefined) {
    validateAudioNumericConstraint('channelCount', c.channelCount);
    const v = pickNumber(c.channelCount);
    if (v !== undefined) out.channelCount = v;
  }
  if (c.latency !== undefined) {
    validateAudioNumericConstraint('latency', c.latency);
    const v = pickNumber(c.latency);
    if (v !== undefined) out.latency = v;
  }
  // @ref LLP 0008#echocancellationmode — boolean | "all" | "remote-only"
  // Split into two scalar fields at the bridge: `echoCancellation` carries
  // the boolean form, `echoCancellationMode` carries the enum string. Native
  // sees only one of them set (or neither, if the caller omitted the field).
  if (c.echoCancellation !== undefined) {
    const v = pickBooleanOrEchoCancellationMode(c.echoCancellation);
    if (typeof v === 'boolean') {
      out.echoCancellation = v;
    } else if (v === 'all' || v === 'remote-only') {
      out.echoCancellationMode = v;
    }
  }
  if (c.autoGainControl !== undefined) {
    const v = pickBoolean(c.autoGainControl);
    if (v !== undefined) out.autoGainControl = v;
  }
  if (c.noiseSuppression !== undefined) {
    const v = pickBoolean(c.noiseSuppression);
    if (v !== undefined) out.noiseSuppression = v;
  }
  if (c.voiceIsolation !== undefined) {
    const v = pickBoolean(c.voiceIsolation);
    if (v !== undefined) out.voiceIsolation = v;
  }
  return out;
}

// @ref LLP 0008#error-overconstrainederror — Reject audio `min`/`max` /
// `exact` ranges that can't be satisfied by any AVAudioSession we'd produce.
function validateAudioNumericConstraint(
  name: 'sampleRate' | 'sampleSize' | 'channelCount' | 'latency',
  c: ConstrainULong | ConstrainDouble
): void {
  if (typeof c === 'number') return;
  if (!c || typeof c !== 'object') return;
  const range = AUDIO_DEVICE_RANGES[name];
  const min = (c as { min?: number }).min;
  const max = (c as { min?: number; max?: number }).max;
  const exact = (c as { exact?: number }).exact;
  if (typeof max === 'number' && max < range.min) {
    throw new DOMException(`Constraint cannot be satisfied: ${name}`, 'OverconstrainedError', name);
  }
  if (typeof min === 'number' && min > range.max) {
    throw new DOMException(`Constraint cannot be satisfied: ${name}`, 'OverconstrainedError', name);
  }
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    throw new DOMException(`Constraint cannot be satisfied: ${name}`, 'OverconstrainedError', name);
  }
  if (typeof exact === 'number' && (exact < range.min || exact > range.max)) {
    throw new DOMException(`Constraint cannot be satisfied: ${name}`, 'OverconstrainedError', name);
  }
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

function pickBoolean(c: unknown): boolean | undefined {
  if (typeof c === 'boolean') return c;
  if (c && typeof c === 'object') {
    const v = c as { exact?: unknown; ideal?: unknown };
    if (typeof v.exact === 'boolean') return v.exact;
    if (typeof v.ideal === 'boolean') return v.ideal;
  }
  return undefined;
}

// @ref LLP 0008#echocancellationmode — boolean | "all" | "remote-only"
// The original input shape (including the enum string) is preserved through
// the bridge so getSettings() can report it back verbatim.
function pickBooleanOrEchoCancellationMode(
  c: unknown
): boolean | 'all' | 'remote-only' | undefined {
  if (typeof c === 'boolean') return c;
  if (c === 'all' || c === 'remote-only') return c;
  if (c && typeof c === 'object') {
    const v = c as { exact?: unknown; ideal?: unknown };
    const e = v.exact;
    if (typeof e === 'boolean' || e === 'all' || e === 'remote-only') return e;
    const i = v.ideal;
    if (typeof i === 'boolean' || i === 'all' || i === 'remote-only') return i;
  }
  return undefined;
}
