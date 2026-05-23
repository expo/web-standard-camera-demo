// @ref LLP 0007 — Minimal DOM shim so 1:1 WPT ports can be evaluated.
//
// The upstream WPT files run in a browser where `document`, `window`,
// `test_driver`, and friends are present. To let our verbatim ports load
// without crashing the bundle, we install just-enough stubs at module-import
// time. Tests that actually USE these globals at runtime will still fail —
// that's the intended TDD signal — but the bundle survives evaluation.

import type { HTMLVideoElement as RNHTMLVideoElement } from '../HTMLVideoElement';

declare global {
  // eslint-disable-next-line no-var
  var document: Document;
  // eslint-disable-next-line no-var
  var window: Window & typeof globalThis;
  // eslint-disable-next-line no-var
  var test_driver: TestDriver;
  // eslint-disable-next-line no-var
  var get_host_info: () => Record<string, string>;
  // eslint-disable-next-line no-var
  var EventWatcher: new (t: unknown, target: EventTarget, events: string[]) => {
    wait_for: (types: string | string[]) => Promise<Event | Event[]>;
    stop_watching: () => void;
  };
}

interface TestDriver {
  bless(_name: string): Promise<void>;
  set_permission(_descriptor: PermissionDescriptor, _state: PermissionState): Promise<void>;
  click(_element: unknown): Promise<void>;
}

class StubElement extends EventTarget {
  readonly tagName: string;
  id: string = '';
  className: string = '';
  style: Record<string, string> = {};
  children: StubElement[] = [];
  parentElement: StubElement | null = null;
  // The most-used media attributes; subclasses override for richer behavior.
  srcObject: MediaStream | null = null;
  src: string = '';
  muted: boolean = false;
  autoplay: boolean = false;
  loop: boolean = false;
  preload: string = '';
  readyState: number = 0;
  duration: number = NaN;
  currentTime: number = 0;
  videoWidth: number = 0;
  videoHeight: number = 0;
  width: number = 0;
  height: number = 0;
  ended: boolean = false;
  paused: boolean = true;
  defaultPlaybackRate: number = 1;
  playbackRate: number = 1;
  networkState: number = 0;
  textContent: string = '';
  innerHTML: string = '';
  contentWindow: Window | null = null;
  contentDocument: Document | null = null;
  permissionsPolicy: { features(): string[] } = { features: () => ['camera', 'microphone'] };

  // Event-handler attributes we see in WPT — wired through EventTarget.
  onloadstart: ((e: Event) => void) | null = null;
  onloadeddata: ((e: Event) => void) | null = null;
  onloadedmetadata: ((e: Event) => void) | null = null;
  ondurationchange: ((e: Event) => void) | null = null;
  onresize: ((e: Event) => void) | null = null;
  oncanplay: ((e: Event) => void) | null = null;
  oncanplaythrough: ((e: Event) => void) | null = null;
  onsuspend: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onended: ((e: Event) => void) | null = null;
  onplay: ((e: Event) => void) | null = null;
  onpause: ((e: Event) => void) | null = null;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    (this as unknown as Record<string, unknown>)[name] = value;
  }

  getAttribute(name: string): string | null {
    return ((this as unknown as Record<string, unknown>)[name] as string | undefined) ?? null;
  }

  removeAttribute(name: string): void {
    delete (this as unknown as Record<string, unknown>)[name];
  }

  appendChild<T extends StubElement>(child: T): T {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  remove(): void {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
  }

  removeChild<T extends StubElement>(child: T): T {
    child.remove();
    return child;
  }

  querySelector(_sel: string): null { return null; }
  querySelectorAll(_sel: string): StubElement[] { return []; }

  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }
}

// Bridge `document.createElement('video')` to our React-rendered <Video> when
// possible. We can't actually mount a React component synchronously here, so
// we return a stub that supports the spec-shaped surface. Tests that need a
// real preview should use the globally-installed `video` element instead.
class StubVideoElement extends StubElement {
  constructor() {
    super('video');
  }
}

class StubAudioElement extends StubElement {
  constructor() {
    super('audio');
  }
}

class StubIframeElement extends StubElement {
  constructor() {
    super('iframe');
    // contentWindow is wired lazily after appendChild.
  }
}

// Returns a stable Proxy that forwards every property access to the
// currently-installed `globalThis[name]` element. Used by document.getElementById
// so WPT bodies can capture the reference at module load yet still see the
// real element once the runner installs it via `installTestGlobals(...)`.
const liveProxyCache = new Map<string, object>();
function liveProxy(name: 'video' | 'audio'): object {
  const cached = liveProxyCache.get(name);
  if (cached) return cached;
  const target: Record<string, unknown> = {};
  const proxy = new Proxy(target, {
    get(_t, prop) {
      const live = (globalThis as unknown as Record<string, unknown>)[name];
      if (live == null) return undefined;
      const value = (live as Record<string | symbol, unknown>)[prop as string | symbol];
      // Bind methods so `this` is the live element, not the proxy.
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(live) : value;
    },
    set(_t, prop, value) {
      const live = (globalThis as unknown as Record<string, unknown>)[name];
      if (live == null) return false;
      (live as Record<string | symbol, unknown>)[prop as string | symbol] = value;
      return true;
    },
    has(_t, prop) {
      const live = (globalThis as unknown as Record<string, unknown>)[name];
      if (live == null) return false;
      return prop in (live as object);
    },
  });
  liveProxyCache.set(name, proxy);
  return proxy;
}

class StubDocument {
  body = new StubElement('body');
  head = new StubElement('head');
  documentElement = new StubElement('html');
  permissionsPolicy = { features: (): string[] => ['camera', 'microphone'] };

  createElement(tagName: string): StubElement {
    const tag = tagName.toLowerCase();
    if (tag === 'video') return new StubVideoElement();
    if (tag === 'audio') return new StubAudioElement();
    if (tag === 'iframe') return new StubIframeElement();
    return new StubElement(tagName);
  }

  getElementById(id: string): StubElement | null {
    // Common WPT pattern: `<video id="vid">` + top-level
    // `const vid = document.getElementById('vid')`. The capture happens at
    // module load, BEFORE `installTestGlobals()` runs and sets
    // `globalThis.video`. To keep WPT bodies byte-identical, we return a
    // stable live-binding proxy whose every property access delegates to the
    // current `globalThis.video` (or `globalThis.audio`) — so captures stay
    // valid once the runner actually starts.
    if (id === 'vid' || id === 'video') {
      return liveProxy('video') as unknown as StubElement;
    }
    if (id === 'aud' || id === 'audio') {
      return liveProxy('audio') as unknown as StubElement;
    }
    // Some tests use `vid2`/`vid3`/etc. We hand them the same live video proxy
    // — there's only one underlying element, but tests usually only operate
    // on one at a time so collisions are rare. Better than null.
    if (/^vid\d*$/.test(id)) {
      return liveProxy('video') as unknown as StubElement;
    }
    if (/^aud\d*$/.test(id)) {
      return liveProxy('audio') as unknown as StubElement;
    }
    return null;
  }

  // Hand back the live video/audio element for the common WPT
  // patterns `document.querySelector("video")` / `document.querySelector("audio")`.
  // These are equivalent to the id-based getElementById path above; we return
  // the same live-binding proxies so tests like MediaStream-MediaElement-preload-none
  // (which uses `querySelector` rather than `getElementById`) can run.
  querySelector(sel: string): StubElement | null {
    const s = sel.toLowerCase().trim();
    if (s === 'video') return liveProxy('video') as unknown as StubElement;
    if (s === 'audio') return liveProxy('audio') as unknown as StubElement;
    return null;
  }
  querySelectorAll(_sel: string): StubElement[] { return []; }
}

const docStub = new StubDocument() as unknown as Document;
const driverStub: TestDriver = {
  bless: async () => undefined,
  set_permission: async () => undefined,
  click: async () => undefined,
};

let installed = false;
export function installDomShim(): void {
  if (installed) return;
  installed = true;

  const g = globalThis as unknown as Record<string, unknown>;

  if (!g.document) g.document = docStub;
  if (!g.window) g.window = globalThis;
  if (!g.test_driver) g.test_driver = driverStub;

  // `window.postMessage(data)` + `window.onmessage` is the common WPT idiom
  // for queueing a task. Several tests do:
  //   function queueTask(f) { window.onmessage = f; window.postMessage("hi"); }
  // and await `new Promise(r => queueTask(r))`. We dispatch onmessage in a
  // fresh macrotask so it's a true task rather than a microtask.
  const w = g.window as Record<string, unknown>;
  if (typeof w.postMessage !== 'function') {
    w.postMessage = (data: unknown): void => {
      setTimeout(() => {
        const onmessage = w.onmessage as ((ev: { data: unknown }) => void) | null | undefined;
        if (typeof onmessage === 'function') onmessage({ data });
      }, 0);
    };
  }

  // navigator.permissions — stateful stub. Each query() returns a fresh
  // PermissionStatus whose `state` getter reflects the current grant state
  // (read from the MediaDevices module). When the grant flips, MediaDevices
  // notifies us via `__subscribeCaptureGrantsForTesting` and we dispatch a
  // `change` event on every matching PermissionStatus.
  const nav = (g.navigator as Record<string, unknown> | undefined) ?? (g.navigator = {});
  if (!(nav as Record<string, unknown>).permissions) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const MediaDevicesModule = require('../MediaDevices') as {
      __getCaptureGrantsForTesting?: () => { camera: boolean; microphone: boolean };
      __subscribeCaptureGrantsForTesting?: (
        fn: (name: 'camera' | 'microphone') => void
      ) => () => void;
    };

    class PermissionStatus extends EventTarget {
      readonly name: string;
      #onchange: ((ev: Event) => void) | null = null;
      constructor(name: string) {
        super();
        this.name = name;
      }
      get state(): string {
        const grants = MediaDevicesModule.__getCaptureGrantsForTesting?.() ?? {
          camera: false,
          microphone: false,
        };
        if (this.name === 'camera' && grants.camera) return 'granted';
        if (this.name === 'microphone' && grants.microphone) return 'granted';
        return 'prompt';
      }
      get onchange(): ((ev: Event) => void) | null { return this.#onchange; }
      set onchange(handler: ((ev: Event) => void) | null) {
        if (this.#onchange) this.removeEventListener('change', this.#onchange);
        this.#onchange = handler;
        if (handler) this.addEventListener('change', handler);
      }
    }

    const statusInstances = new Set<PermissionStatus>();
    MediaDevicesModule.__subscribeCaptureGrantsForTesting?.((flipped) => {
      for (const status of statusInstances) {
        if (status.name === flipped) {
          status.dispatchEvent(new Event('change'));
        }
      }
    });

    (nav as Record<string, unknown>).permissions = {
      query: async (desc: { name?: string }) => {
        const status = new PermissionStatus(desc?.name ?? '');
        statusInstances.add(status);
        return status as unknown as PermissionStatus;
      },
    };
  }

  // Make sure `globalThis.DOMException` points at our internal class so
  // `e instanceof DOMException` checks work in WPT bodies. RN 0.85 ships its
  // own built-in DOMException, but our `getUserMedia`/native-rewrap path
  // throws *our* DOMException subclass — if WPT tests check against the RN
  // global the instanceof fails. So we unconditionally overwrite the global
  // here to make both halves agree.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const DOMExceptionCls = require('../DOMException').DOMException as new (
    message: string,
    name: string,
    constraint?: string
  ) => Error;
  g.DOMException = DOMExceptionCls;
  const SharedDOMException = g.DOMException as typeof DOMExceptionCls;

  if (!g.OverconstrainedError) {
    // Per spec, `OverconstrainedError` IS a `DOMException` with name
    // `"OverconstrainedError"` plus a `constraint` field. WPT tests assert
    // `new OverconstrainedError(...) instanceof DOMException`, so the JS
    // class must actually extend DOMException.
    class OverconstrainedError extends SharedDOMException {
      constructor(constraint: string, message?: string) {
        super(message ?? `Constraint cannot be satisfied: ${constraint}`, 'OverconstrainedError', constraint);
      }
    }
    g.OverconstrainedError = OverconstrainedError;
  }

  // InputDeviceInfo / MediaDeviceInfo — class identifiers used in instanceof
  // checks. InputDeviceInfo extends MediaDeviceInfo per WebIDL and has a
  // `getCapabilities()` method.
  if (!g.MediaDeviceInfo) g.MediaDeviceInfo = class MediaDeviceInfo {};
  if (!g.InputDeviceInfo) {
    const MediaDeviceInfoCls = g.MediaDeviceInfo as new () => object;
    class InputDeviceInfo extends MediaDeviceInfoCls {
      getCapabilities(): Record<string, unknown> {
        return (this as unknown as { __capabilities?: Record<string, unknown> }).__capabilities ?? {};
      }
    }
    g.InputDeviceInfo = InputDeviceInfo;
  }

  // MediaStreamTrackEvent — used by track-event constructor tests; we don't
  // fire it, but the constructor must exist and accept `{track}` in init.
  // No default value on the `init` parameter so `.length === 2` per WebIDL
  // (the constructor takes the eventInitDict as a required argument).
  if (!g.MediaStreamTrackEvent) {
    class MediaStreamTrackEvent extends Event {
      readonly track: object;
      constructor(type: string, init: { track?: object } | null | undefined) {
        super(type);
        if (init == null || init.track == null) {
          throw new TypeError("Failed to construct 'MediaStreamTrackEvent': 'track' member is required.");
        }
        this.track = init.track;
      }
    }
    g.MediaStreamTrackEvent = MediaStreamTrackEvent;
  }
  if (!g.URL || !(g.URL as { createObjectURL?: unknown }).createObjectURL) {
    (g.URL ?? (g.URL = {} as Record<string, unknown>)) as Record<string, unknown>;
    (g.URL as Record<string, unknown>).createObjectURL = (): never => {
      throw new TypeError('URL.createObjectURL is not supported for MediaStream in this environment');
    };
  }

  // WPT testharness helpers used at file-evaluation scope. We stub them as
  // globals so 1:1 ports load; tests that actually call them at runtime will
  // fail with the stub's deliberate behavior.
  if (!g.get_host_info) {
    g.get_host_info = (): Record<string, string> => ({
      HTTP_ORIGIN: 'http://example.invalid',
      HTTPS_ORIGIN: 'https://example.invalid',
      HTTP_REMOTE_ORIGIN: 'http://remote.example.invalid',
      HTTPS_REMOTE_ORIGIN: 'https://remote.example.invalid',
      ORIGINAL_HOST: 'example.invalid',
      REMOTE_HOST: 'remote.example.invalid',
      HTTP_PORT: '80',
      HTTPS_PORT: '443',
    });
  }
  if (!g.EventWatcher) {
    g.EventWatcher = class EventWatcher {
      private target: EventTarget;
      private events: string[];
      constructor(_t: unknown, target: EventTarget, events: string[]) {
        this.target = target;
        this.events = events;
      }
      wait_for(types: string | string[]): Promise<Event | Event[]> {
        const list = Array.isArray(types) ? types : [types];
        return Promise.all(
          list.map(
            (type) =>
              new Promise<Event>((resolve) => {
                const once = (e: Event): void => {
                  this.target.removeEventListener(type, once);
                  resolve(e);
                };
                this.target.addEventListener(type, once);
              })
          )
        ).then((events) => (Array.isArray(types) ? events : events[0]));
      }
      stop_watching(): void {
        // no-op
      }
    };
  }
}
