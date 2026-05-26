// @ref LLP 0019#browser-tests-tab — Browser globals for running the shared
// WPT-style suite on Expo Web without installing the iOS native backend.

import {
  __getDeniedKindsForTesting,
  __resetDeniedPermissionsForTesting,
} from './testharness';

const MEDIA_HANDLER_NAMES = [
  'onloadstart', 'onloadedmetadata', 'onloadeddata', 'oncanplay', 'oncanplaythrough',
  'ondurationchange', 'onresize', 'onsuspend', 'onerror', 'onended',
  'onplay', 'onpause', 'onratechange', 'ontimeupdate', 'onseeked', 'onseeking',
];

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

function proxyDevice(
  device: MediaDeviceInfo,
  overrides: Partial<Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'kind' | 'label'>>
): MediaDeviceInfo {
  return new Proxy(device, {
    get(target, prop) {
      if (prop in overrides) {
        return overrides[prop as keyof typeof overrides];
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
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
    const exposed = grantedForKind(kind) ? list : list.slice(0, 1);
    for (const device of exposed) {
      out.push(
        grantedForKind(kind)
          ? proxyDevice(device, { kind })
          : proxyDevice(device, { deviceId: '', groupId: '', kind, label: '' })
      );
    }
  }
  return out;
}

function installMediaDeviceHarness(): void {
  const originalMediaDevices = navigator.mediaDevices;
  if (!originalMediaDevices) return;

  const wrappedMediaDevices = new Proxy(originalMediaDevices, {
    get(target, prop) {
      if (prop === 'getUserMedia') {
        return async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
          const requested = requestedKinds(constraints);
          const denied = __getDeniedKindsForTesting();
          if ((requested.camera && denied.camera) || (requested.microphone && denied.microphone)) {
            throw new DOMException('Permission denied', 'NotAllowedError');
          }
          const stream = await target.getUserMedia.call(target, constraints);
          if (stream.getVideoTracks().length > 0 || requested.camera) setGranted('camera');
          if (stream.getAudioTracks().length > 0 || requested.microphone) setGranted('microphone');
          return stream;
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
  installMediaDeviceHarness();
  installPermissionsHarness();
}

export function installTestGlobals(videoElement: HTMLVideoElement): void {
  installHarnessOnce();
  const g = globalThis as unknown as Record<string, unknown>;
  g.video = videoElement;
  if (!g.audio) {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = true;
    g.audio = audio;
  }
  g.vid = videoElement;
  g.aud = g.audio;
}

export function resetTestGlobals(): void {
  const g = globalThis as unknown as {
    video?: HTMLVideoElement;
    audio?: HTMLAudioElement & { srcObject: MediaStream | null };
  };
  stopAssignedTracks(g.video);
  stopAssignedTracks(g.audio);
  if (g.video) {
    try {
      g.video.srcObject = null;
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
