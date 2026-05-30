// @ref LLP 0005 — <Video> component + HTMLMediaElement-shaped ref attribute mirror

import { requireNativeView } from 'expo';
import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { INTERNAL_TRACK_ENDED_EVENT } from './internalEvents';

// Use the DOM lib types on the public surface so consumer code that's been
// ported from a browser type-checks 1:1 against `navigator.mediaDevices`.
type Stream = globalThis.MediaStream;

// @ref LLP 0006#sharedobject-view-prop — Canonical helper from
// https://github.com/expo/expo/pull/46054. Expo's view-prop marshaller can't
// resolve a SharedObject proxy passed directly; the JS side forwards the
// proxy's id (a number) and the native Prop converter — typed normally as the
// SharedObject — resolves the id back. Our MediaStream class exposes
// `__expo_shared_object_id__` via a getter so this helper works on it.
function getSharedObjectId(object: unknown): number | null {
  return (object as { __expo_shared_object_id__?: number } | null)?.__expo_shared_object_id__ ?? null;
}

// Bridge-level prop type — the native view receives only the id.
// (Public-facing prop type is `VideoProps` below, which takes the stream.)
interface NativeVideoViewProps {
  srcObject?: number | null;
  style?: StyleProp<ViewStyle>;
  onLoadedData?: (event: { nativeEvent: object }) => void;
  onDurationChange?: (event: { nativeEvent: object }) => void;
  onPlay?: (event: { nativeEvent: object }) => void;
  onPause?: (event: { nativeEvent: object }) => void;
}

interface NativeVideoViewRef {
  playAsync(): Promise<void>;
  pauseAsync(): Promise<void>;
}

const NativeView = requireNativeView('StandardCamera') as unknown as React.ForwardRefExoticComponent<
  NativeVideoViewProps & React.RefAttributes<NativeVideoViewRef>
>;

// @ref LLP 0005#readystate-constants
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;

// @ref LLP 0005#srcobject-seekable / buffered — empty TimeRanges
const EMPTY_TIME_RANGES = {
  length: 0,
  start(_index: number): never {
    throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
  },
  end(_index: number): never {
    throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
  },
};

export interface HTMLVideoElement extends EventTarget {
  // @ref LLP 0005#srcObject
  srcObject: Stream | null;

  // @ref LLP 0005#readystate
  readonly readyState: 0 | 1 | 2 | 3 | 4;
  readonly HAVE_NOTHING: 0;
  readonly HAVE_METADATA: 1;
  readonly HAVE_CURRENT_DATA: 2;
  readonly HAVE_FUTURE_DATA: 3;
  readonly HAVE_ENOUGH_DATA: 4;

  // @ref LLP 0005#duration
  readonly duration: number;

  // @ref LLP 0001#video-properties — Intrinsic dimensions of the displayed
  // video. For a MediaStream, these track the first video track's
  // settings — including the cropped dimensions when `resizeMode:
  // 'crop-and-scale'` is active. 0 before metadata is loaded.
  readonly videoWidth: number;
  readonly videoHeight: number;

  // @ref LLP 0005#currentTime
  currentTime: number;

  // @ref LLP 0005#seekable
  readonly seekable: typeof EMPTY_TIME_RANGES;
  readonly buffered: typeof EMPTY_TIME_RANGES;
  readonly seeking: false;

  // @ref LLP 0005#playback
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  preload: 'none' | 'metadata' | 'auto';

  play(): Promise<void>;
  pause(): void;

  // event setters
  onloadstart: ((ev: Event) => void) | null;
  onresize: ((ev: Event) => void) | null;
  onloadedmetadata: ((ev: Event) => void) | null;
  onloadeddata: ((ev: Event) => void) | null;
  oncanplay: ((ev: Event) => void) | null;
  oncanplaythrough: ((ev: Event) => void) | null;
  ondurationchange: ((ev: Event) => void) | null;
  onended: ((ev: Event) => void) | null;
  onplay: ((ev: Event) => void) | null;
  onpause: ((ev: Event) => void) | null;
  ontimeupdate: ((ev: Event) => void) | null;
}

export interface VideoProps {
  srcObject?: Stream | null;
  style?: StyleProp<ViewStyle>;
  /** Convenience: invoke play() automatically when srcObject is attached. */
  autoplay?: boolean;
}

export const Video = React.forwardRef<HTMLVideoElement, VideoProps>(function Video(props, ref) {
  const nativeRef = React.useRef<NativeVideoViewRef>(null);

  // React-driven mirror of the element's srcObject so setting via the ref
  // triggers a re-render that forwards the new value to the native view.
  const [srcObjectState, setSrcObjectState] = React.useState<Stream | null>(null);

  const elementRef = React.useRef<VideoElementImpl | null>(null);
  if (elementRef.current === null) {
    elementRef.current = new VideoElementImpl(setSrcObjectState);
  }
  const el = elementRef.current;

  React.useImperativeHandle(ref, () => el, [el]);

  // @ref LLP 0005#prop-vs-ref — Prop changes win until the user sets srcObject on the ref.
  React.useEffect(() => {
    if (props.srcObject !== undefined) {
      el.srcObject = props.srcObject ?? null;
    }
  }, [props.srcObject, el]);

  // Wire the native view's commands onto the element.
  React.useEffect(() => {
    el.__bindNative(nativeRef.current);
    return () => {
      el.__bindNative(null);
    };
  }, [el]);

  React.useEffect(() => {
    if (props.autoplay && srcObjectState) {
      void el.play();
    }
  }, [el, props.autoplay, srcObjectState]);

  return (
    <NativeView
      ref={nativeRef}
      srcObject={getSharedObjectId(srcObjectState)}
      style={props.style}
      onLoadedData={() => el.__handleLoadedData()}
      onDurationChange={() => el.__handleDurationChange()}
      onPlay={() => el.__handlePlay()}
      onPause={() => el.__handlePause()}
    />
  );
});

// @ref LLP 0005 — concrete HTMLVideoElement implementation
class VideoElementImpl extends EventTarget implements HTMLVideoElement {
  readonly HAVE_NOTHING = HAVE_NOTHING;
  readonly HAVE_METADATA = HAVE_METADATA;
  readonly HAVE_CURRENT_DATA = HAVE_CURRENT_DATA;
  readonly HAVE_FUTURE_DATA = HAVE_FUTURE_DATA;
  readonly HAVE_ENOUGH_DATA = HAVE_ENOUGH_DATA;

  readonly seekable = EMPTY_TIME_RANGES;
  readonly buffered = EMPTY_TIME_RANGES;
  readonly seeking = false as const;

  // @ref LLP 0005#played — Per HTML, a media element's played TimeRanges grows
  // as the element advances its currentTime. For a MediaStream source this is
  // always a single range [0, currentTime] once play() has happened, and empty
  // before. The end of the range tracks our current accumulated playback time.
  get played(): { length: number; start(i: number): number; end(i: number): number } {
    const ct = this.currentTime;
    if (ct <= 0) return EMPTY_TIME_RANGES;
    return {
      length: 1,
      start(i: number): number {
        if (i !== 0) throw new DOMException('Index or size is negative or greater than the allowed amount', 'IndexSizeError');
        return 0;
      },
      end: (_i: number): number => ct,
    };
  }

  // `loop` is ignored for MediaStream srcObject; default to false.
  loop = false;

  private __srcObject: Stream | null = null;
  private __readyState: 0 | 1 | 2 | 3 | 4 = HAVE_NOTHING;
  private __duration: number = NaN;
  private __ended: boolean = false;
  private __paused: boolean = true;
  private __trackEndedSubscriptions: Array<{ track: globalThis.MediaStreamTrack; listener: () => void }> = [];
  private __trackSetSubscription: { stream: Stream; listener: () => void } | null = null;
  private __native: NativeVideoViewRef | null = null;
  // Time bookkeeping. `__playStartMs` is the timestamp of the most recent
  // play(); `__accumulatedSeconds` is total played time accrued across
  // pause/resume cycles. `currentTime` returns __accumulatedSeconds while
  // paused, and __accumulatedSeconds + (now - playStartMs) while playing.
  private __playStartMs: number = 0;
  private __accumulatedSeconds: number = 0;
  private __currentTimeSnapshot: number | null = null;
  private __currentTimeSnapshotClearTimer: ReturnType<typeof setTimeout> | null = null;
  private __notifyReact: (s: Stream | null) => void;
  // Pre-stream user values for `preload` / `playbackRate` / `defaultPlaybackRate`.
  // While `srcObject` is a MediaStream the getters MUST return the spec-fixed
  // values ('none' / 1 / 1) and setters MUST be ignored — but once srcObject
  // is cleared the values revert to whatever the caller had set, per HTML
  // spec's "save and restore" semantics.
  private __userPreload: 'none' | 'metadata' | 'auto' = 'none';
  private __userPlaybackRate = 1;
  private __userDefaultPlaybackRate = 1;
  private __timeUpdateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(notifyReact: (s: Stream | null) => void) {
    super();
    this.__notifyReact = notifyReact;
  }

  // @ref LLP 0005#srcObject
  get srcObject(): Stream | null { return this.__srcObject; }
  set srcObject(value: Stream | null) {
    if (value === this.__srcObject) return;
    const wasStream = this.__srcObject != null;
    const becomingNull = value == null;
    this.__detachTrackListeners();
    this.__detachTrackSetListener();
    this.__srcObject = value;
    this.__readyState = HAVE_NOTHING;
    this.__duration = NaN;
    this.__ended = false;
    // Per HTML spec, assigning a MediaStream resets the timeline to 0.
    this.__clearCurrentTimeSnapshot();
    this.__playStartMs = 0;
    this.__accumulatedSeconds = 0;
    // Treat srcObject assignment as a clean slate: pause and stop the
    // timeupdate ticker so the next test isn't observed mid-tick.
    this.__paused = true;
    this.__stopTimeUpdates();
    this.__attachTrackListeners();
    this.__attachTrackSetListener();
    // Per HTML spec, when a MediaStream is being unset from srcObject the
    // playbackRate attribute is set to the value of defaultPlaybackRate, and a
    // `ratechange` event fires if the value changed.
    if (wasStream && becomingNull) {
      const prevRate = this.__userPlaybackRate;
      this.__userPlaybackRate = this.__userDefaultPlaybackRate;
      if (prevRate !== this.__userPlaybackRate) {
        Promise.resolve().then(() => this.dispatchEvent(new Event('ratechange')));
      }
    }
    // Fire `loadstart` after the synchronous srcObject assignment completes,
    // so tests can install their handlers right after assignment and still
    // observe the event. Per the HTML media element load algorithm this fires
    // as soon as resource selection begins.
    if (value != null) {
      Promise.resolve().then(() => this.dispatchEvent(new Event('loadstart')));
    }
    // Trigger a React re-render so the native view receives the new srcObject prop.
    this.__notifyReact(value);
  }

  // @ref LLP 0005#readystate
  get readyState(): 0 | 1 | 2 | 3 | 4 { return this.__readyState; }

  // @ref LLP 0001#video-properties — `HTMLVideoElement.videoWidth` /
  // `videoHeight` report the *intrinsic* dimensions of the displayed video.
  // For a MediaStream source those are the settings of the first video
  // track (which already accounts for `resizeMode: 'crop-and-scale'`
  // delivered cropped dimensions, per `MediaDevices.swift`'s videoSettings).
  // Spec: 0 before metadata is loaded, then the source's dimensions.
  // WPT's `Tests that setting a required constraint with an ideal value in
  // getUserMedia works` asserts `video.videoWidth === track.getSettings().width`.
  get videoWidth(): number {
    if (this.__readyState < HAVE_METADATA) return 0;
    return this.#trackSettingsNumber('width');
  }
  get videoHeight(): number {
    if (this.__readyState < HAVE_METADATA) return 0;
    return this.#trackSettingsNumber('height');
  }

  #trackSettingsNumber(key: 'width' | 'height'): number {
    const stream = this.__srcObject;
    if (!stream) return 0;
    const tracks = stream.getVideoTracks?.() ?? [];
    const settings = tracks[0]?.getSettings?.() as { width?: number; height?: number } | undefined;
    const v = settings?.[key];
    return typeof v === 'number' ? v : 0;
  }

  // @ref LLP 0005#duration
  get duration(): number { return this.__duration; }

  // @ref LLP 0005#currentTime — Reads elapsed-since-play wall clock while
  // playing, freezes at the accumulated value while paused. A playing read is
  // task-stable so same-task no-op setter checks do not race wall-clock ticks.
  get currentTime(): number {
    if (this.__playStartMs === 0) return this.__accumulatedSeconds;
    if (this.__currentTimeSnapshot !== null) return this.__currentTimeSnapshot;
    const currentTime = this.__currentTimeUncached();
    this.__currentTimeSnapshot = currentTime;
    this.__queueCurrentTimeSnapshotClear();
    return currentTime;
  }
  set currentTime(_value: number) {
    // @ref LLP 0005#srcobject-currentTime — UA MUST ignore attempts to set
  }

  get paused(): boolean { return this.__paused; }
  set paused(_value: boolean) { /* read-only effectively per spec */ }

  get ended(): boolean { return this.__ended; }
  set ended(_value: boolean) { /* read-only */ }

  // @ref LLP 0005#playbackRate — while srcObject is a MediaStream the spec
  // forces this to 1 and ignores setters. Once srcObject is cleared, the
  // value returns to whatever the caller assigned beforehand.
  get playbackRate(): number {
    return this.__srcObject ? 1 : this.__userPlaybackRate;
  }
  set playbackRate(value: number) {
    if (this.__srcObject) return;
    this.__userPlaybackRate = value;
  }

  // @ref LLP 0005#defaultPlaybackRate — same save/restore semantics.
  get defaultPlaybackRate(): number {
    return this.__srcObject ? 1 : this.__userDefaultPlaybackRate;
  }
  set defaultPlaybackRate(value: number) {
    if (this.__srcObject) return;
    this.__userDefaultPlaybackRate = value;
  }

  // @ref LLP 0005#preload — same save/restore semantics.
  get preload(): 'none' | 'metadata' | 'auto' {
    return this.__srcObject ? 'none' : this.__userPreload;
  }
  set preload(value: string) {
    if (this.__srcObject) return;
    if (value === 'none' || value === 'metadata' || value === 'auto') {
      this.__userPreload = value;
    }
  }

  async play(): Promise<void> {
    await this.__native?.playAsync();
    // @ref LLP 0001#video-properties — Wait for `loadeddata` (which fires
    // off the FrameSink's first sample callback, see VideoView.swift) so
    // `videoWidth` / `videoHeight` are non-zero by the time `await play()`
    // resolves. Browsers do this implicitly; the WPT
    // `GUM-required-constraint-with-ideal-value` test depends on it.
    // If the readyState is already HAVE_METADATA-or-better (because we
    // attached to an already-running source), this short-circuits.
    if (this.__readyState < HAVE_METADATA) {
      await new Promise<void>((resolve) => {
        const onLoaded = (): void => {
          this.removeEventListener('loadeddata', onLoaded);
          resolve();
        };
        this.addEventListener('loadeddata', onLoaded);
      });
    }
    this.__paused = false;
    this.__clearCurrentTimeSnapshot();
    this.__playStartMs = Date.now();
    this.__startTimeUpdates();
  }

  pause(): void {
    void this.__native?.pauseAsync();
    // Freeze currentTime: bank the just-played interval into the accumulator.
    if (this.__playStartMs !== 0) {
      this.__accumulatedSeconds = this.__currentTimeUncached();
      this.__playStartMs = 0;
    }
    this.__clearCurrentTimeSnapshot();
    this.__paused = true;
    this.__stopTimeUpdates();
  }

  // @ref LLP 0005 — `timeupdate` fires at ~4Hz (matching upstream browser
  // cadence) while play() is active and pause()'s when it isn't. Several WPT
  // tests await `vid.ontimeupdate` to checkpoint playback progress.
  private __startTimeUpdates(): void {
    if (this.__timeUpdateInterval) return;
    this.__timeUpdateInterval = setInterval(() => {
      if (!this.__paused) {
        this.dispatchEvent(new Event('timeupdate'));
      }
    }, 250);
  }
  private __stopTimeUpdates(): void {
    if (this.__timeUpdateInterval) {
      clearInterval(this.__timeUpdateInterval);
      this.__timeUpdateInterval = null;
    }
  }
  private __currentTimeUncached(): number {
    if (this.__playStartMs === 0) return this.__accumulatedSeconds;
    return this.__accumulatedSeconds + (Date.now() - this.__playStartMs) / 1000;
  }
  private __queueCurrentTimeSnapshotClear(): void {
    if (this.__currentTimeSnapshotClearTimer) return;
    this.__currentTimeSnapshotClearTimer = setTimeout(() => {
      this.__currentTimeSnapshot = null;
      this.__currentTimeSnapshotClearTimer = null;
    }, 0);
  }
  private __clearCurrentTimeSnapshot(): void {
    if (this.__currentTimeSnapshotClearTimer) {
      clearTimeout(this.__currentTimeSnapshotClearTimer);
      this.__currentTimeSnapshotClearTimer = null;
    }
    this.__currentTimeSnapshot = null;
  }

  // Event-handler property accessors. Each on* setter swaps the addEventListener
  // subscription so dispatched events route through both addEventListener-
  // attached listeners and the WPT-style `el.on<x> = handler` pattern.
  private __onloadstart: ((ev: Event) => void) | null = null;
  get onloadstart(): ((ev: Event) => void) | null { return this.__onloadstart; }
  set onloadstart(handler: ((ev: Event) => void) | null) {
    if (this.__onloadstart) this.removeEventListener('loadstart', this.__onloadstart);
    this.__onloadstart = handler;
    if (handler) this.addEventListener('loadstart', handler);
  }

  private __onresize: ((ev: Event) => void) | null = null;
  get onresize(): ((ev: Event) => void) | null { return this.__onresize; }
  set onresize(handler: ((ev: Event) => void) | null) {
    if (this.__onresize) this.removeEventListener('resize', this.__onresize);
    this.__onresize = handler;
    if (handler) this.addEventListener('resize', handler);
  }

  private __oncanplay: ((ev: Event) => void) | null = null;
  get oncanplay(): ((ev: Event) => void) | null { return this.__oncanplay; }
  set oncanplay(handler: ((ev: Event) => void) | null) {
    if (this.__oncanplay) this.removeEventListener('canplay', this.__oncanplay);
    this.__oncanplay = handler;
    if (handler) this.addEventListener('canplay', handler);
  }

  private __oncanplaythrough: ((ev: Event) => void) | null = null;
  get oncanplaythrough(): ((ev: Event) => void) | null { return this.__oncanplaythrough; }
  set oncanplaythrough(handler: ((ev: Event) => void) | null) {
    if (this.__oncanplaythrough) this.removeEventListener('canplaythrough', this.__oncanplaythrough);
    this.__oncanplaythrough = handler;
    if (handler) this.addEventListener('canplaythrough', handler);
  }

  private __onloadedmetadata: ((ev: Event) => void) | null = null;
  get onloadedmetadata(): ((ev: Event) => void) | null { return this.__onloadedmetadata; }
  set onloadedmetadata(handler: ((ev: Event) => void) | null) {
    if (this.__onloadedmetadata) this.removeEventListener('loadedmetadata', this.__onloadedmetadata);
    this.__onloadedmetadata = handler;
    if (handler) this.addEventListener('loadedmetadata', handler);
  }

  private __onloadeddata: ((ev: Event) => void) | null = null;
  get onloadeddata(): ((ev: Event) => void) | null { return this.__onloadeddata; }
  set onloadeddata(handler: ((ev: Event) => void) | null) {
    if (this.__onloadeddata) this.removeEventListener('loadeddata', this.__onloadeddata);
    this.__onloadeddata = handler;
    if (handler) this.addEventListener('loadeddata', handler);
  }

  private __ondurationchange: ((ev: Event) => void) | null = null;
  get ondurationchange(): ((ev: Event) => void) | null { return this.__ondurationchange; }
  set ondurationchange(handler: ((ev: Event) => void) | null) {
    if (this.__ondurationchange) this.removeEventListener('durationchange', this.__ondurationchange);
    this.__ondurationchange = handler;
    if (handler) this.addEventListener('durationchange', handler);
  }

  private __onended: ((ev: Event) => void) | null = null;
  get onended(): ((ev: Event) => void) | null { return this.__onended; }
  set onended(handler: ((ev: Event) => void) | null) {
    if (this.__onended) this.removeEventListener('ended', this.__onended);
    this.__onended = handler;
    if (handler) this.addEventListener('ended', handler);
  }

  private __onplay: ((ev: Event) => void) | null = null;
  get onplay(): ((ev: Event) => void) | null { return this.__onplay; }
  set onplay(handler: ((ev: Event) => void) | null) {
    if (this.__onplay) this.removeEventListener('play', this.__onplay);
    this.__onplay = handler;
    if (handler) this.addEventListener('play', handler);
  }

  private __onpause: ((ev: Event) => void) | null = null;
  get onpause(): ((ev: Event) => void) | null { return this.__onpause; }
  set onpause(handler: ((ev: Event) => void) | null) {
    if (this.__onpause) this.removeEventListener('pause', this.__onpause);
    this.__onpause = handler;
    if (handler) this.addEventListener('pause', handler);
  }

  private __ontimeupdate: ((ev: Event) => void) | null = null;
  get ontimeupdate(): ((ev: Event) => void) | null { return this.__ontimeupdate; }
  set ontimeupdate(handler: ((ev: Event) => void) | null) {
    if (this.__ontimeupdate) this.removeEventListener('timeupdate', this.__ontimeupdate);
    this.__ontimeupdate = handler;
    if (handler) this.addEventListener('timeupdate', handler);
  }

  private __onratechange: ((ev: Event) => void) | null = null;
  get onratechange(): ((ev: Event) => void) | null { return this.__onratechange; }
  set onratechange(handler: ((ev: Event) => void) | null) {
    if (this.__onratechange) this.removeEventListener('ratechange', this.__onratechange);
    this.__onratechange = handler;
    if (handler) this.addEventListener('ratechange', handler);
  }

  // @internal
  __bindNative(native: NativeVideoViewRef | null): void {
    this.__native = native;
  }

  __handleLoadedData(): void {
    if (this.__readyState === HAVE_ENOUGH_DATA) return;
    this.__readyState = HAVE_ENOUGH_DATA;
    // Fire the canonical HTML media-element first-frame event sequence
    // (resize → loadedmetadata → loadeddata → canplay → canplaythrough).
    // `durationchange` is fired separately via __handleDurationChange.
    // We dispatch each on its own macrotask so a test that does
    //   await new Promise(r => vid.onloadedmetadata = r);
    //   vid.onloadeddata = unexpected;
    // can install its next handler between two consecutive events. If we
    // dispatched all of them synchronously, the test's await continuation
    // would not have run yet and stale handlers from earlier in the test
    // would still be in place.
    void this.__fireSequence([
      'resize',
      'loadedmetadata',
      'loadeddata',
      'canplay',
      'canplaythrough',
    ]);
  }

  private async __fireSequence(events: string[]): Promise<void> {
    for (const evt of events) {
      await new Promise<void>((r) => setTimeout(r, 0));
      this.dispatchEvent(new Event(evt));
    }
  }

  __handleDurationChange(): void {
    if (this.__duration !== Infinity) {
      this.__duration = Infinity;
      this.dispatchEvent(new Event('durationchange'));
    }
  }

  __handlePlay(): void {
    this.dispatchEvent(new Event('play'));
  }

  __handlePause(): void {
    this.dispatchEvent(new Event('pause'));
  }

  // @ref LLP 0005#srcobject-ended — fire when the stream becomes inactive
  // (no live tracks). MediaStreamTrack.stop() does not fire the public
  // `ended` event, so tracks emit a prefixed internal notification for media
  // element bookkeeping. The notification is queued as a task for stop(), so
  // a single `queueTask` round-trip is enough for observers to see `ended`.
  private __attachTrackListeners(): void {
    if (!this.__srcObject) return;
    for (const track of this.__srcObject.getTracks()) {
      const listener = () => {
        this.__maybeEnded();
      };
      track.addEventListener(INTERNAL_TRACK_ENDED_EVENT, listener);
      this.__trackEndedSubscriptions.push({ track, listener });
    }
  }

  private __detachTrackListeners(): void {
    for (const { track, listener } of this.__trackEndedSubscriptions) {
      track.removeEventListener(INTERNAL_TRACK_ENDED_EVENT, listener);
    }
    this.__trackEndedSubscriptions = [];
  }

  // @ref LLP 0005#srcobject-ended — `removeTrack` is script-initiated and the
  // spec's `removetrack` event does not fire; but the HTML spec still requires
  // the media element to fire `ended` when its assigned MediaStream becomes
  // inactive (no live tracks). Our JS `MediaStream` emits an internal
  // `__standardcamera_tracksetchange` event whenever the track set changes;
  // we re-attach track listeners and re-evaluate ended on each.
  private __attachTrackSetListener(): void {
    if (!this.__srcObject) return;
    const stream = this.__srcObject;
    const listener = (): void => {
      // The set changed — rebuild per-track 'ended' subscriptions to cover
      // any newly-added tracks, then re-check the ended condition (might be
      // empty / all-ended now). Use a task break so observers see the same
      // event-loop step boundary the HTML spec mandates for `ended`.
      this.__detachTrackListeners();
      this.__attachTrackListeners();
      setTimeout(() => this.__maybeEnded(), 0);
    };
    stream.addEventListener('__standardcamera_tracksetchange', listener);
    this.__trackSetSubscription = { stream, listener };
  }

  private __detachTrackSetListener(): void {
    if (this.__trackSetSubscription) {
      const { stream, listener } = this.__trackSetSubscription;
      stream.removeEventListener('__standardcamera_tracksetchange', listener);
      this.__trackSetSubscription = null;
    }
  }

  private __maybeEnded(): void {
    if (!this.__srcObject || this.__ended) return;
    // Stream is inactive when it has no live tracks (covers both
    // "all tracks ended" and "all tracks removed via removeTrack").
    const tracks = this.__srcObject.getTracks();
    const hasLive = tracks.some((t) => t.readyState === 'live');
    if (!hasLive) {
      this.__ended = true;
      // @ref LLP 0005#srcobject-ended — Per the HTML spec, when a media element's
      // MediaStream provider becomes inactive the element's duration is set to
      // the official playback position (currentTime) and a `durationchange`
      // event fires before the `ended` event.
      const finalTime = this.currentTime;
      // Freeze the timeline so subsequent currentTime reads return finalTime.
      this.__playStartMs = 0;
      this.__accumulatedSeconds = finalTime;
      this.__stopTimeUpdates();
      if (this.__duration !== finalTime) {
        this.__duration = finalTime;
        this.dispatchEvent(new Event('durationchange'));
      }
      this.dispatchEvent(new Event('ended'));
    }
  }
}
