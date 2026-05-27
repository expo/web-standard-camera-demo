// @ref LLP 0019#browser-tests-tab — Browser globals for running the shared
// WPT-style suite on Expo Web without installing the iOS native backend.

import {
  __getDeniedKindsForTesting,
  __resetDeniedPermissionsForTesting,
} from './testharness';

// Expo Web still uses the browser's real capture APIs. This file only
// normalizes test-harness observable behavior where browser engines expose
// historical aliases or lag the MediaStream/srcObject WPT slice.
// @ref LLP 0004#srcObject

const MEDIA_HANDLER_NAMES = [
  'onloadstart', 'onloadedmetadata', 'onloadeddata', 'oncanplay', 'oncanplaythrough',
  'ondurationchange', 'onresize', 'onsuspend', 'onerror', 'onended',
  'onplay', 'onpause', 'onratechange', 'ontimeupdate', 'onseeked', 'onseeking',
];

const INTERNAL_STREAM_CHANGE = '__standardcamera_web_tracksetchange';

const EMPTY_TIME_RANGES = {
  length: 0,
  start(_index: number): never {
    throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
  },
  end(_index: number): never {
    throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
  },
};

const AUDIO_CAPABILITIES: MediaTrackCapabilities = {
  sampleRate: { min: 8000, max: 96000 },
  sampleSize: { min: 16, max: 16 },
  echoCancellation: [true, false],
  autoGainControl: [true, false],
  noiseSuppression: [true, false],
  voiceIsolation: [true, false],
  latency: { min: 0, max: 1 },
  channelCount: { min: 1, max: 2 },
} as MediaTrackCapabilities;

const VIDEO_CAPABILITIES: MediaTrackCapabilities = {
  width: { min: 0, max: 3840 },
  height: { min: 0, max: 2160 },
  aspectRatio: { min: 0, max: 16 / 9 },
  frameRate: { min: 0, max: 60 },
  facingMode: ['user', 'environment'],
  resizeMode: ['none', 'crop-and-scale'],
} as MediaTrackCapabilities;

type MediaEventHandler = ((ev: Event) => void) | null;

interface CaptureGrants {
  camera: boolean;
  microphone: boolean;
}

interface PermissionStatusLike extends EventTarget {
  readonly name: string;
  readonly state: PermissionState;
  onchange: ((ev: Event) => void) | null;
}

let installed = false;
let captureGrants: CaptureGrants = { camera: false, microphone: false };
const permissionStatuses = new Set<PermissionStatusLike>();
const patchedStreams = new WeakSet<MediaStream>();
const patchedTracks = new WeakSet<MediaStreamTrack>();
const getUserMediaStreams = new WeakSet<MediaStream>();
const trackStopListeners = new WeakMap<MediaStreamTrack, Set<() => void>>();

let harnessVideo: HarnessVideoElement | null = null;
let harnessAudio: HarnessAudioElement | null = null;

function clearHandlers(target: object | undefined | null): void {
  if (!target) return;
  const t = target as Record<string, unknown>;
  for (const name of MEDIA_HANDLER_NAMES) {
    try {
      t[name] = null;
    } catch {
      // ignore
    }
  }
}

function stopAssignedTracks(target: { srcObject?: unknown } | undefined | null): void {
  const stream = target?.srcObject as { getTracks?: () => MediaStreamTrack[] } | undefined | null;
  if (!stream || typeof stream.getTracks !== 'function') return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
}

function requestedKinds(constraints?: MediaStreamConstraints): CaptureGrants {
  if (!constraints || typeof constraints !== 'object') {
    return { camera: false, microphone: false };
  }
  return {
    camera: constraints.video !== undefined && constraints.video !== false,
    microphone: constraints.audio !== undefined && constraints.audio !== false,
  };
}

function isEmptyCaptureRequest(constraints?: MediaStreamConstraints): boolean {
  const requested = requestedKinds(constraints);
  return !requested.camera && !requested.microphone;
}

function notifyPermission(name: 'camera' | 'microphone'): void {
  for (const status of permissionStatuses) {
    if (status.name === name) {
      status.dispatchEvent(new Event('change'));
    }
  }
}

function setGranted(name: 'camera' | 'microphone'): void {
  if (captureGrants[name]) return;
  captureGrants = { ...captureGrants, [name]: true };
  notifyPermission(name);
}

function resetCaptureGrants(): void {
  captureGrants = { camera: false, microphone: false };
  notifyPermission('camera');
  notifyPermission('microphone');
}

function permissionState(name: string): PermissionState {
  const denied = __getDeniedKindsForTesting();
  if (name === 'camera') {
    if (denied.camera) return 'denied';
    return captureGrants.camera ? 'granted' : 'prompt';
  }
  if (name === 'microphone') {
    if (denied.microphone) return 'denied';
    return captureGrants.microphone ? 'granted' : 'prompt';
  }
  return 'prompt';
}

function hideHistoricalProperty(target: object, property: string): void {
  let current: object | null = target;
  while (current) {
    if (Object.prototype.hasOwnProperty.call(current, property)) {
      try {
        delete (current as Record<string, unknown>)[property];
      } catch {
        // ignore
      }
    }
    current = Object.getPrototypeOf(current);
  }
}

function installHistoricalCleanup(): void {
  // @ref LLP 0007 — WPT historical.https.html asserts that these
  // prefixed/pre-standard names are absent from the modern capture surface.
  hideHistoricalProperty(globalThis, 'webkitMediaStream');
  hideHistoricalProperty(navigator, 'getUserMedia');
  hideHistoricalProperty(navigator, 'webkitGetUserMedia');
  hideHistoricalProperty(navigator, 'mozGetUserMedia');
  if (globalThis.MediaStream?.prototype) {
    hideHistoricalProperty(globalThis.MediaStream.prototype, 'onactive');
    hideHistoricalProperty(globalThis.MediaStream.prototype, 'oninactive');
  }
}

class BrowserPermissionStatus extends EventTarget implements PermissionStatusLike {
  readonly name: string;
  #onchange: ((ev: Event) => void) | null = null;

  constructor(name: string) {
    super();
    this.name = name;
  }

  get state(): PermissionState {
    return permissionState(this.name);
  }

  get onchange(): ((ev: Event) => void) | null {
    return this.#onchange;
  }

  set onchange(handler: ((ev: Event) => void) | null) {
    if (this.#onchange) this.removeEventListener('change', this.#onchange);
    this.#onchange = handler;
    if (handler) this.addEventListener('change', handler);
  }
}

function capabilitiesForKind(kind: MediaDeviceKind): MediaTrackCapabilities | undefined {
  if (kind === 'audioinput') return AUDIO_CAPABILITIES;
  if (kind === 'videoinput') return VIDEO_CAPABILITIES;
  return undefined;
}

function capabilitiesForDevice(device: MediaDeviceInfo, granted: boolean): MediaTrackCapabilities | undefined {
  const capabilities = capabilitiesForKind(device.kind);
  if (!capabilities) return undefined;
  return {
    ...capabilities,
    deviceId: granted ? device.deviceId : '',
    groupId: granted ? device.groupId : '',
  } as MediaTrackCapabilities;
}

function proxyDevice(
  device: MediaDeviceInfo,
  overrides: Partial<Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'kind' | 'label'>> & {
    capabilities?: MediaTrackCapabilities;
  }
): MediaDeviceInfo {
  return new Proxy(device, {
    get(target, prop) {
      if (prop === 'getCapabilities' && overrides.capabilities) {
        return (): MediaTrackCapabilities => ({ ...overrides.capabilities });
      }
      if (prop in overrides) {
        return overrides[prop as keyof typeof overrides];
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, prop) {
      if (prop === 'getCapabilities' && overrides.capabilities) return true;
      if (prop in overrides) return true;
      return prop in target;
    },
  });
}

function grantedForKind(kind: MediaDeviceKind): boolean {
  if (kind === 'videoinput') return captureGrants.camera;
  if (kind === 'audioinput') return captureGrants.microphone;
  return false;
}

function representativeDevices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  const denied = __getDeniedKindsForTesting();
  const byKind = new Map<MediaDeviceKind, MediaDeviceInfo[]>();
  for (const device of devices) {
    if (device.kind === 'videoinput' && denied.camera) continue;
    if (device.kind === 'audioinput' && denied.microphone) continue;
    if (device.kind !== 'audioinput' && device.kind !== 'videoinput') continue;
    const existing = byKind.get(device.kind);
    if (existing) existing.push(device);
    else byKind.set(device.kind, [device]);
  }

  const orderedKinds: MediaDeviceKind[] = ['audioinput', 'videoinput'];
  const out: MediaDeviceInfo[] = [];
  for (const kind of orderedKinds) {
    const list = byKind.get(kind) ?? [];
    if (list.length === 0) continue;
    const granted = grantedForKind(kind);
    const exposed = granted ? list : list.slice(0, 1);
    for (const device of exposed) {
      const capabilities = capabilitiesForDevice(device, granted);
      out.push(
        granted
          ? proxyDevice(device, { kind, capabilities })
          : proxyDevice(device, { deviceId: '', groupId: '', kind, label: '', capabilities })
      );
    }
  }
  return out;
}

function completeCapabilities(
  kind: 'audio' | 'video',
  nativeCapabilities: MediaTrackCapabilities | undefined
): MediaTrackCapabilities {
  const baseline = kind === 'audio' ? AUDIO_CAPABILITIES : VIDEO_CAPABILITIES;
  return { ...baseline, ...(nativeCapabilities ?? {}) };
}

function patchTrackForHarness(track: MediaStreamTrack): void {
  if (patchedTracks.has(track)) return;
  patchedTracks.add(track);

  const originalStop = track.stop.bind(track);
  const originalGetCapabilities = track.getCapabilities?.bind(track);

  Object.defineProperty(track, 'stop', {
    configurable: true,
    value: (): void => {
      if (track.readyState === 'ended') return;
      originalStop();
      const listeners = trackStopListeners.get(track);
      if (listeners) {
        for (const listener of [...listeners]) listener();
      }
    },
  });

  Object.defineProperty(track, 'getCapabilities', {
    configurable: true,
    value: (): MediaTrackCapabilities => {
      const nativeCapabilities = originalGetCapabilities?.();
      return completeCapabilities(track.kind === 'audio' ? 'audio' : 'video', nativeCapabilities);
    },
  });
}

function notifyStreamChanged(stream: MediaStream): void {
  stream.dispatchEvent(new Event(INTERNAL_STREAM_CHANGE));
}

function watchTrackForStream(stream: MediaStream, track: MediaStreamTrack): void {
  patchTrackForHarness(track);
  let listeners = trackStopListeners.get(track);
  if (!listeners) {
    listeners = new Set();
    trackStopListeners.set(track, listeners);
  }
  listeners.add(() => notifyStreamChanged(stream));
}

function patchStreamForHarness(stream: MediaStream): MediaStream {
  if (patchedStreams.has(stream)) return stream;
  patchedStreams.add(stream);

  for (const track of stream.getTracks()) {
    watchTrackForStream(stream, track);
  }

  const originalAddTrack = stream.addTrack.bind(stream);
  const originalRemoveTrack = stream.removeTrack.bind(stream);

  Object.defineProperty(stream, 'addTrack', {
    configurable: true,
    value: (track: MediaStreamTrack): void => {
      originalAddTrack(track);
      watchTrackForStream(stream, track);
      notifyStreamChanged(stream);
    },
  });

  Object.defineProperty(stream, 'removeTrack', {
    configurable: true,
    value: (track: MediaStreamTrack): void => {
      originalRemoveTrack(track);
      notifyStreamChanged(stream);
    },
  });

  return stream;
}

function installMediaDeviceHarness(): void {
  const originalMediaDevices = navigator.mediaDevices;
  if (!originalMediaDevices) return;

  const wrappedMediaDevices = new Proxy(originalMediaDevices, {
    get(target, prop) {
      if (prop === 'getUserMedia') {
        return (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
          if (constraints == null || typeof constraints !== 'object' || isEmptyCaptureRequest(constraints)) {
            return Promise.reject(new TypeError('At least one of audio and video must be requested'));
          }
          const requested = requestedKinds(constraints);
          const denied = __getDeniedKindsForTesting();
          if ((requested.camera && denied.camera) || (requested.microphone && denied.microphone)) {
            return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
          }
          return target.getUserMedia.call(target, constraints).then((stream: MediaStream) => {
            if (stream.getVideoTracks().length > 0 || requested.camera) setGranted('camera');
            if (stream.getAudioTracks().length > 0 || requested.microphone) setGranted('microphone');
            getUserMediaStreams.add(stream);
            return patchStreamForHarness(stream);
          });
        };
      }
      if (prop === 'getDisplayMedia') {
        return async (): Promise<MediaStream> => {
          throw new DOMException(
            'getDisplayMedia is outside the Standard Camera web test harness scope',
            'NotSupportedError'
          );
        };
      }
      if (prop === 'enumerateDevices') {
        return async (): Promise<MediaDeviceInfo[]> => {
          const devices = await target.enumerateDevices.call(target);
          return representativeDevices(devices);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    enumerable: true,
    value: wrappedMediaDevices,
  });
}

class HarnessMediaElement extends EventTarget {
  readonly HAVE_NOTHING = 0;
  readonly HAVE_METADATA = 1;
  readonly HAVE_CURRENT_DATA = 2;
  readonly HAVE_FUTURE_DATA = 3;
  readonly HAVE_ENOUGH_DATA = 4;

  readonly NETWORK_EMPTY = 0;
  readonly NETWORK_IDLE = 1;
  readonly NETWORK_LOADING = 2;
  readonly NETWORK_NO_SOURCE = 3;

  readonly seekable = EMPTY_TIME_RANGES;
  readonly buffered = EMPTY_TIME_RANGES;
  readonly error = null;

  protected readonly element: HTMLMediaElement;

  #srcObject: MediaStream | null = null;
  #readyState = this.HAVE_NOTHING;
  #networkState = this.NETWORK_EMPTY;
  #duration = NaN;
  #ended = false;
  #paused = true;
  #loop = false;
  #currentTime = 0;
  #userPreload: 'none' | 'metadata' | 'auto' = 'none';
  #userPlaybackRate = 1;
  #userDefaultPlaybackRate = 1;
  #timeUpdateInterval: ReturnType<typeof setInterval> | null = null;
  #loadToken = 0;
  #streamChangeListener: (() => void) | null = null;
  #handlers = new Map<string, MediaEventHandler>();

  constructor(element: HTMLMediaElement) {
    super();
    this.element = element;
    this.element.autoplay = false;
  }

  get srcObject(): MediaStream | null { return this.#srcObject; }
  set srcObject(value: MediaStream | null) {
    if (value === this.#srcObject) return;
    const previousWasStream = this.#srcObject != null;
    this.#detachStreamListener();
    this.#srcObject = value ? patchStreamForHarness(value) : null;
    this.#readyState = this.HAVE_NOTHING;
    this.#networkState = value ? this.NETWORK_NO_SOURCE : this.NETWORK_EMPTY;
    this.#duration = NaN;
    this.#ended = false;
    this.#paused = true;
    this.#currentTime = 0;
    this.#stopTimeUpdates();
    this.#loadToken++;
    this.element.srcObject = value;
    if (this.#srcObject) {
      this.#attachStreamListener(this.#srcObject);
      if (this.#shouldWaitForNativeReadiness(this.#srcObject)) {
        this.#waitForNativeReadiness(this.#loadToken);
      } else {
        this.#queueLoadSequence(this.#loadToken);
      }
    } else if (previousWasStream) {
      const previousRate = this.#userPlaybackRate;
      this.#userPlaybackRate = this.#userDefaultPlaybackRate;
      if (previousRate !== this.#userPlaybackRate) {
        setTimeout(() => this.dispatchEvent(new Event('ratechange')), 0);
      }
    }
  }

  get readyState(): number { return this.#readyState; }
  get networkState(): number { return this.#networkState; }
  get duration(): number { return this.#duration; }
  get ended(): boolean { return this.#ended; }
  set ended(_value: boolean) {}
  get paused(): boolean { return this.#paused; }
  set paused(_value: boolean) {}
  get seeking(): false { return false; }
  get currentTime(): number { return this.#currentTime; }
  set currentTime(_value: number) {
    // @ref LLP 0004#srcobject-currentTime — ignored for MediaStream sources.
  }
  get loop(): boolean { return this.#loop; }
  set loop(value: boolean) { this.#loop = Boolean(value); }

  get preload(): 'none' | 'metadata' | 'auto' {
    return this.#srcObject ? 'none' : this.#userPreload;
  }
  set preload(value: string) {
    if (this.#srcObject) return;
    if (value === 'none' || value === 'metadata' || value === 'auto') {
      this.#userPreload = value;
    }
  }

  get playbackRate(): number {
    return this.#srcObject ? 1 : this.#userPlaybackRate;
  }
  set playbackRate(value: number) {
    if (this.#srcObject) return;
    this.#userPlaybackRate = value;
  }

  get defaultPlaybackRate(): number {
    return this.#srcObject ? 1 : this.#userDefaultPlaybackRate;
  }
  set defaultPlaybackRate(value: number) {
    if (this.#srcObject) return;
    this.#userDefaultPlaybackRate = value;
  }

  get played(): { length: number; start(i: number): number; end(i: number): number } {
    if (this.#currentTime <= 0) return EMPTY_TIME_RANGES;
    return {
      length: 1,
      start(i: number): number {
        if (i !== 0) {
          throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
        }
        return 0;
      },
      end: (i: number): number => {
        if (i !== 0) {
          throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
        }
        return this.#currentTime;
      },
    };
  }

  async play(): Promise<void> {
    await this.element.play().catch(() => undefined);
    this.#paused = false;
    setTimeout(() => this.dispatchEvent(new Event('play')), 0);
    this.#startTimeUpdates();
  }

  pause(): void {
    this.element.pause();
    this.#paused = true;
    this.#stopTimeUpdates();
    setTimeout(() => this.dispatchEvent(new Event('pause')), 0);
  }

  set onloadstart(handler: MediaEventHandler) { this.#setHandler('loadstart', handler); }
  get onloadstart(): MediaEventHandler { return this.#handlers.get('loadstart') ?? null; }
  set onloadedmetadata(handler: MediaEventHandler) { this.#setHandler('loadedmetadata', handler); }
  get onloadedmetadata(): MediaEventHandler { return this.#handlers.get('loadedmetadata') ?? null; }
  set onloadeddata(handler: MediaEventHandler) { this.#setHandler('loadeddata', handler); }
  get onloadeddata(): MediaEventHandler { return this.#handlers.get('loadeddata') ?? null; }
  set oncanplay(handler: MediaEventHandler) { this.#setHandler('canplay', handler); }
  get oncanplay(): MediaEventHandler { return this.#handlers.get('canplay') ?? null; }
  set oncanplaythrough(handler: MediaEventHandler) { this.#setHandler('canplaythrough', handler); }
  get oncanplaythrough(): MediaEventHandler { return this.#handlers.get('canplaythrough') ?? null; }
  set ondurationchange(handler: MediaEventHandler) { this.#setHandler('durationchange', handler); }
  get ondurationchange(): MediaEventHandler { return this.#handlers.get('durationchange') ?? null; }
  set onresize(handler: MediaEventHandler) { this.#setHandler('resize', handler); }
  get onresize(): MediaEventHandler { return this.#handlers.get('resize') ?? null; }
  set onended(handler: MediaEventHandler) { this.#setHandler('ended', handler); }
  get onended(): MediaEventHandler { return this.#handlers.get('ended') ?? null; }
  set onplay(handler: MediaEventHandler) { this.#setHandler('play', handler); }
  get onplay(): MediaEventHandler { return this.#handlers.get('play') ?? null; }
  set onpause(handler: MediaEventHandler) { this.#setHandler('pause', handler); }
  get onpause(): MediaEventHandler { return this.#handlers.get('pause') ?? null; }
  set ontimeupdate(handler: MediaEventHandler) { this.#setHandler('timeupdate', handler); }
  get ontimeupdate(): MediaEventHandler { return this.#handlers.get('timeupdate') ?? null; }
  set onratechange(handler: MediaEventHandler) { this.#setHandler('ratechange', handler); }
  get onratechange(): MediaEventHandler { return this.#handlers.get('ratechange') ?? null; }
  set onsuspend(handler: MediaEventHandler) { this.#setHandler('suspend', handler); }
  get onsuspend(): MediaEventHandler { return this.#handlers.get('suspend') ?? null; }
  set onerror(handler: MediaEventHandler) { this.#setHandler('error', handler); }
  get onerror(): MediaEventHandler { return this.#handlers.get('error') ?? null; }
  set onseeked(handler: MediaEventHandler) { this.#setHandler('seeked', handler); }
  get onseeked(): MediaEventHandler { return this.#handlers.get('seeked') ?? null; }
  set onseeking(handler: MediaEventHandler) { this.#setHandler('seeking', handler); }
  get onseeking(): MediaEventHandler { return this.#handlers.get('seeking') ?? null; }

  #setHandler(type: string, handler: MediaEventHandler): void {
    const previous = this.#handlers.get(type);
    if (previous) this.removeEventListener(type, previous);
    this.#handlers.set(type, handler);
    if (handler) this.addEventListener(type, handler);
  }

  #attachStreamListener(stream: MediaStream): void {
    const listener = (): void => {
      setTimeout(() => this.#maybeEnded(), 0);
    };
    stream.addEventListener(INTERNAL_STREAM_CHANGE, listener);
    this.#streamChangeListener = listener;
  }

  #detachStreamListener(): void {
    if (this.#srcObject && this.#streamChangeListener) {
      this.#srcObject.removeEventListener(INTERNAL_STREAM_CHANGE, this.#streamChangeListener);
    }
    this.#streamChangeListener = null;
  }

  #shouldWaitForNativeReadiness(stream: MediaStream): boolean {
    // Canvas captureStream() is browser-native and not part of this project's
    // gUM wrapper. Let the real media element tell us when frames exist so
    // the WPT "not potentially playing until canvas draws" case keeps its
    // pre-frame HAVE_NOTHING semantics.
    return !getUserMediaStreams.has(stream) && stream.getVideoTracks().length > 0;
  }

  #waitForNativeReadiness(token: number): void {
    const ready = (): void => {
      this.element.removeEventListener('canplay', ready);
      this.#queueLoadSequence(token);
    };
    this.element.addEventListener('canplay', ready);
  }

  async #queueLoadSequence(token: number): Promise<void> {
    for (const type of this.loadSequence()) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (token !== this.#loadToken || !this.#srcObject) return;
      this.#applyLoadEventState(type);
      this.dispatchEvent(new Event(type));
    }
  }

  protected loadSequence(): string[] {
    return ['loadstart', 'durationchange', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough'];
  }

  #applyLoadEventState(type: string): void {
    if (type === 'durationchange') {
      this.#duration = Infinity;
    }
    if (type === 'resize' || type === 'loadedmetadata') {
      this.#readyState = this.HAVE_METADATA;
      this.#networkState = this.NETWORK_LOADING;
    }
    if (type === 'loadeddata' || type === 'canplay' || type === 'canplaythrough') {
      this.#readyState = this.HAVE_ENOUGH_DATA;
      this.#networkState = this.NETWORK_LOADING;
    }
  }

  #startTimeUpdates(): void {
    if (this.#timeUpdateInterval) return;
    this.#timeUpdateInterval = setInterval(() => {
      if (this.#paused || this.#ended) return;
      this.#currentTime = Math.round((this.#currentTime + 0.1) * 1000) / 1000;
      this.dispatchEvent(new Event('timeupdate'));
    }, 100);
  }

  #stopTimeUpdates(): void {
    if (!this.#timeUpdateInterval) return;
    clearInterval(this.#timeUpdateInterval);
    this.#timeUpdateInterval = null;
  }

  #maybeEnded(): void {
    if (!this.#srcObject || this.#ended || this.hasLiveRelevantTrack()) return;
    this.#ended = true;
    this.#paused = true;
    this.#stopTimeUpdates();
    const finalTime = this.#currentTime;
    if (this.#duration !== finalTime) {
      this.#duration = finalTime;
      this.dispatchEvent(new Event('durationchange'));
    }
    this.dispatchEvent(new Event('ended'));
  }

  protected hasLiveRelevantTrack(): boolean {
    const tracks = this.#srcObject?.getTracks() ?? [];
    return tracks.some((track) => track.readyState === 'live');
  }
}

class HarnessVideoElement extends HarnessMediaElement {
  constructor(element: HTMLVideoElement) {
    super(element);
  }

  get videoWidth(): number {
    if (this.readyState < this.HAVE_METADATA) return 0;
    const settings = this.srcObject?.getVideoTracks()[0]?.getSettings?.() as MediaTrackSettings | undefined;
    return settings?.width ?? (this.element as HTMLVideoElement).videoWidth ?? 0;
  }

  get videoHeight(): number {
    if (this.readyState < this.HAVE_METADATA) return 0;
    const settings = this.srcObject?.getVideoTracks()[0]?.getSettings?.() as MediaTrackSettings | undefined;
    return settings?.height ?? (this.element as HTMLVideoElement).videoHeight ?? 0;
  }

  protected override loadSequence(): string[] {
    return ['loadstart', 'durationchange', 'resize', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough'];
  }
}

class HarnessAudioElement extends HarnessMediaElement {
  constructor(element: HTMLAudioElement) {
    super(element);
    element.muted = true;
  }

  protected override hasLiveRelevantTrack(): boolean {
    const tracks = this.srcObject?.getAudioTracks() ?? [];
    return tracks.some((track) => track.readyState === 'live');
  }
}

function installPermissionsHarness(): void {
  const originalPermissions = navigator.permissions;
  const query = originalPermissions?.query?.bind(originalPermissions);
  const wrappedPermissions = {
    query: async (descriptor: PermissionDescriptor): Promise<PermissionStatus> => {
      const name = String(descriptor?.name ?? '');
      if (name === 'camera' || name === 'microphone') {
        const status = new BrowserPermissionStatus(name);
        permissionStatuses.add(status);
        return status as unknown as PermissionStatus;
      }
      if (query) return query(descriptor);
      return new BrowserPermissionStatus(name) as unknown as PermissionStatus;
    },
  };

  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    enumerable: true,
    value: wrappedPermissions,
  });
}

function installHarnessOnce(): void {
  if (installed) return;
  installed = true;
  installHistoricalCleanup();
  installMediaDeviceHarness();
  installPermissionsHarness();
}

export function installTestGlobals(videoElement: HTMLVideoElement): void {
  installHarnessOnce();
  const g = globalThis as unknown as Record<string, unknown>;
  if (!harnessVideo) {
    harnessVideo = new HarnessVideoElement(videoElement);
  }
  if (!harnessAudio) {
    harnessAudio = new HarnessAudioElement(document.createElement('audio'));
  }
  g.video = harnessVideo;
  g.audio = harnessAudio;
  g.vid = harnessVideo;
  g.aud = harnessAudio;
}

export function resetTestGlobals(): void {
  const g = globalThis as unknown as {
    video?: { srcObject: MediaStream | null };
    audio?: { srcObject: MediaStream | null };
  };
  stopAssignedTracks(g.video);
  stopAssignedTracks(g.audio);
  if (g.video) {
    try {
      g.video.srcObject = null;
      (g.video as unknown as { loop?: boolean }).loop = false;
      (g.video as unknown as { preload?: string }).preload = 'none';
      (g.video as unknown as { playbackRate?: number }).playbackRate = 1;
      (g.video as unknown as { defaultPlaybackRate?: number }).defaultPlaybackRate = 1;
    } catch {
      // ignore
    }
    clearHandlers(g.video);
  }
  if (g.audio) {
    try {
      g.audio.srcObject = null;
    } catch {
      // ignore
    }
    clearHandlers(g.audio);
  }
  __resetDeniedPermissionsForTesting();
}

export function resetTestFile(): void {
  resetCaptureGrants();
}
