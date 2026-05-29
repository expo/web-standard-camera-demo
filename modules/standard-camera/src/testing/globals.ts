// @ref LLP 0007 — DOM-style globals for 1:1 WPT ports.
//
// WPT tests rely on the HTML id-as-global pattern: `<video id="video">` makes
// `video` available as a global. To keep our ported tests byte-identical to
// upstream, we install one shared video element and one stub audio element as
// `globalThis.video` and `globalThis.audio`. The runner resets `srcObject` on
// both between tests.

import { __installTestDeniedCheck, __resetCaptureGrantsForTesting } from '../MediaDevices';
import { INTERNAL_TRACK_ENDED_EVENT } from '../internalEvents';
import { __getDeniedKindsForTesting, __resetDeniedPermissionsForTesting } from './testharness';

// Wire `setMediaPermission('denied', …)` (testharness helper) into the gUM
// path so a denied kind rejects with `NotAllowedError`. The install happens
// once at module load; the per-test reset is below.
__installTestDeniedCheck(__getDeniedKindsForTesting);
import type { HTMLVideoElement } from '../HTMLVideoElement';

// @ref LLP 0004 — Stub HTMLAudioElement. The stub exists to satisfy WPT
// tests that do `audio.srcObject = stream` without observing playback
// behavior. Beyond storing srcObject, the stub emits the small set of
// HTMLMediaElement events that WPT tests await on:
//   - `loadedmetadata` immediately when srcObject is set to a stream
//   - `loadeddata` right after `loadedmetadata`
//   - `ended` when the assigned stream becomes *inaudible* — i.e. there
//     are no live AUDIO tracks left, even if video tracks are still live.
//     WPT's `MediaStream-MediaElement-srcObject` tests assert this exact
//     audio-element-specific rule ("becomes inaudible through audio tracks
//     ending"). A `<video>` element would instead end on stream inactivity
//     (all tracks ended) — that case is handled by `HTMLVideoElement`.
class StubAudioElement extends EventTarget {
  #srcObject: MediaStream | null = null;
  #ended = false;
  #trackSetListener: (() => void) | null = null;
  #trackEndedListeners: Array<{ track: globalThis.MediaStreamTrack; fn: () => void }> = [];

  readyState = 0;
  duration = NaN;
  currentTime = 0;
  paused = true;
  muted = true;
  autoplay = true;

  readonly HAVE_NOTHING = 0;
  readonly HAVE_METADATA = 1;
  readonly HAVE_CURRENT_DATA = 2;
  readonly HAVE_FUTURE_DATA = 3;
  readonly HAVE_ENOUGH_DATA = 4;

  // Event-handler attributes WPT bodies frequently use.
  onloadeddata: ((e: Event) => void) | null = null;
  onloadedmetadata: ((e: Event) => void) | null = null;
  ondurationchange: ((e: Event) => void) | null = null;
  onended: ((e: Event) => void) | null = null;
  onplay: ((e: Event) => void) | null = null;
  onpause: ((e: Event) => void) | null = null;

  // Route addEventListener-attached handlers AND the on* property handlers.
  override dispatchEvent(ev: Event): boolean {
    const handlerName = `on${ev.type}` as keyof StubAudioElement;
    const handler = this[handlerName] as unknown as ((e: Event) => void) | null | undefined;
    if (typeof handler === 'function') handler(ev);
    return super.dispatchEvent(ev);
  }

  get srcObject(): MediaStream | null { return this.#srcObject; }
  set srcObject(value: MediaStream | null) {
    if (value === this.#srcObject) return;
    this.#detachStreamListeners();
    this.#srcObject = value;
    this.#ended = false;
    this.readyState = 0;
    if (value) {
      this.#attachStreamListeners(value);
      // Fire metadata/data events in a microtask so a synchronous srcObject
      // assignment isn't observed as having already-fired events.
      Promise.resolve().then(() => {
        if (this.#srcObject !== value) return;
        this.readyState = this.HAVE_ENOUGH_DATA;
        this.dispatchEvent(new Event('loadedmetadata'));
        this.dispatchEvent(new Event('loadeddata'));
      });
    }
  }

  get ended(): boolean { return this.#ended; }
  set ended(_v: boolean) {}

  #attachStreamListeners(stream: MediaStream): void {
    // For track state changes, call #maybeEnded synchronously inside the
    // prefixed internal event task. That internal event is queued after
    // stop(), which satisfies the spec's "asynchronously" requirement for
    // the media element without firing the public MediaStreamTrack "ended"
    // event. For tracksetchange (script-initiated removeTrack), we DO need
    // a setTimeout so `aud.ended` stays false until the next task, matching
    // the Video element's pattern.
    const onChange = (): void => {
      this.#detachTrackEndedListeners();
      this.#wireAudioEndedListeners(stream);
      setTimeout(() => this.#maybeEnded(), 0);
    };
    stream.addEventListener('__standardcamera_tracksetchange', onChange);
    this.#trackSetListener = onChange;
    this.#wireAudioEndedListeners(stream);
  }

  #wireAudioEndedListeners(stream: MediaStream): void {
    for (const t of stream.getAudioTracks()) {
      const fn = (): void => {
        this.#maybeEnded();
      };
      t.addEventListener(INTERNAL_TRACK_ENDED_EVENT, fn);
      this.#trackEndedListeners.push({ track: t, fn });
    }
  }

  #detachStreamListeners(): void {
    if (this.#srcObject && this.#trackSetListener) {
      this.#srcObject.removeEventListener('__standardcamera_tracksetchange', this.#trackSetListener);
    }
    this.#trackSetListener = null;
    this.#detachTrackEndedListeners();
  }

  #detachTrackEndedListeners(): void {
    for (const { track, fn } of this.#trackEndedListeners) {
      track.removeEventListener(INTERNAL_TRACK_ENDED_EVENT, fn);
    }
    this.#trackEndedListeners = [];
  }

  #maybeEnded(): void {
    if (!this.#srcObject || this.#ended) return;
    // Audio element ends when there are no live AUDIO tracks. A live video
    // track does NOT keep an audio element going — the spec's "inaudibility"
    // rule.
    const audioTracks = this.#srcObject.getAudioTracks();
    const hasLiveAudio = audioTracks.some((t) => t.readyState === 'live');
    if (!hasLiveAudio) {
      this.#ended = true;
      this.dispatchEvent(new Event('ended'));
    }
  }

  play(): Promise<void> { return Promise.resolve(); }
  pause(): void {}
}

declare global {
  // eslint-disable-next-line no-var
  var video: HTMLVideoElement;
  // eslint-disable-next-line no-var
  var audio: HTMLAudioElement & { srcObject: MediaStream | null };
}

/** Install shared video / audio globals. Called once by the run-tests screen
 *  before tests register. The `video` arg comes from a real <Video> mounted
 *  in the screen; `audio` is the local stub. */
export function installTestGlobals(videoElement: HTMLVideoElement): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.video = videoElement;
  if (!g.audio) {
    g.audio = new StubAudioElement() as unknown as HTMLAudioElement;
  }
  // Some WPT bodies use `vid` and `aud` as the implicit id-to-global names
  // (e.g. `<video id="vid"></video>` makes `vid` a global). Install live
  // aliases so those bodies work even when they don't call getElementById.
  if (!g.vid) g.vid = videoElement;
  if (!g.aud) g.aud = g.audio;
}

// Media-element event-handler properties cleared between tests. WPT bodies
// routinely leave `vid.onfoo = unreached_func(...)` assignments behind on the
// shared element; if a subsequent test sets srcObject the stale handler fires
// and trips the next test's assertions ("Got unexpected event foo").
const MEDIA_HANDLER_NAMES = [
  'onloadstart', 'onloadedmetadata', 'onloadeddata', 'oncanplay', 'oncanplaythrough',
  'ondurationchange', 'onresize', 'onsuspend', 'onerror', 'onended',
  'onplay', 'onpause', 'onratechange', 'ontimeupdate', 'onseeked', 'onseeking',
];

function clearHandlers(target: object | undefined): void {
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

/** Reset between tests: detach srcObject so the next test starts fresh.
 *  Capture grants are NOT reset here — within a single WPT source file,
 *  later tests are written assuming earlier `getUserMedia` calls' grants
 *  persist (e.g. MediaDevices-enumerateDevices.https.html's "after video
 *  then audio capture" test relies on the prior "after video capture"
 *  test's videoinput exposure carrying over). Per-file isolation is
 *  handled by `resetTestFile` below. */
export function resetTestGlobals(): void {
  const g = globalThis as unknown as { video?: HTMLVideoElement; audio?: { srcObject: MediaStream | null } };
  if (g.video) {
    try {
      if (g.video.srcObject) {
        for (const t of g.video.srcObject.getTracks()) t.stop();
      }
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
  // Forget synthetic denials installed by `setMediaPermission('denied', …)`.
  // Denials are explicit per-test setup; we don't want them to leak.
  __resetDeniedPermissionsForTesting();
}

/** Reset at WPT source-file boundaries to match the "each .html is a fresh
 *  page" semantics WPT assumes. Clears capture grants so the first test in
 *  a file that asserts "deviceId is empty before capture" sees the gated,
 *  pre-grant device list — even if a previous file has already done a
 *  successful `getUserMedia`. */
export function resetTestFile(): void {
  __resetCaptureGrantsForTesting();
}
