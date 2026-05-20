// @ref LLP 0004 — <Video> component + HTMLMediaElement-shaped ref attribute mirror

import { requireNativeView } from 'expo';
import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

// Use the DOM lib types on the public surface so consumer code that's been
// ported from a browser type-checks 1:1 against `navigator.mediaDevices`.
type Stream = globalThis.MediaStream;

// Unwrap our TS MediaStream into its native shared-object id. The Swift view
// prop is typed as `MediaStream?` but Expo's view manager only accepts the
// shared-object id (a number) for now — expo-video uses the same workaround.
// See expo-video/src/VideoView.tsx getPlayerId().
function unwrap(stream: Stream | null): number | null {
  if (stream == null) return null;
  const native = (stream as unknown as { _native?: { __expo_shared_object_id__?: number } })._native;
  return native?.__expo_shared_object_id__ ?? null;
}

interface NativeVideoViewProps {
  srcObject?: unknown;
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

// @ref LLP 0004#readystate-constants
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;

// @ref LLP 0004#srcobject-seekable / buffered — empty TimeRanges
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
  // @ref LLP 0004#srcObject
  srcObject: Stream | null;

  // @ref LLP 0004#readystate
  readonly readyState: 0 | 1 | 2 | 3 | 4;
  readonly HAVE_NOTHING: 0;
  readonly HAVE_METADATA: 1;
  readonly HAVE_CURRENT_DATA: 2;
  readonly HAVE_FUTURE_DATA: 3;
  readonly HAVE_ENOUGH_DATA: 4;

  // @ref LLP 0004#duration
  readonly duration: number;

  // @ref LLP 0004#currentTime
  currentTime: number;

  // @ref LLP 0004#seekable
  readonly seekable: typeof EMPTY_TIME_RANGES;
  readonly buffered: typeof EMPTY_TIME_RANGES;
  readonly seeking: false;

  // @ref LLP 0004#playback
  paused: boolean;
  ended: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  preload: 'none';

  play(): Promise<void>;
  pause(): void;

  // event setters
  onloadeddata: ((ev: Event) => void) | null;
  ondurationchange: ((ev: Event) => void) | null;
  onended: ((ev: Event) => void) | null;
  onplay: ((ev: Event) => void) | null;
  onpause: ((ev: Event) => void) | null;
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

  // @ref LLP 0004#prop-vs-ref — Prop changes win until the user sets srcObject on the ref.
  React.useEffect(() => {
    if (props.srcObject !== undefined) {
      el.srcObject = props.srcObject ?? null;
    }
  }, [props.srcObject, el]);

  // Wire the native view's commands onto the element.
  React.useEffect(() => {
    el.__bindNative(nativeRef.current);
    if (props.autoplay && el.srcObject) {
      void el.play();
    }
    return () => {
      el.__bindNative(null);
    };
  }, [el, props.autoplay]);

  return (
    <NativeView
      ref={nativeRef}
      srcObject={unwrap(srcObjectState)}
      style={props.style}
      onLoadedData={() => el.__handleLoadedData()}
      onDurationChange={() => el.__handleDurationChange()}
      onPlay={() => el.__handlePlay()}
      onPause={() => el.__handlePause()}
    />
  );
});

// @ref LLP 0004 — concrete HTMLVideoElement implementation
class VideoElementImpl extends EventTarget implements HTMLVideoElement {
  readonly HAVE_NOTHING = HAVE_NOTHING;
  readonly HAVE_METADATA = HAVE_METADATA;
  readonly HAVE_CURRENT_DATA = HAVE_CURRENT_DATA;
  readonly HAVE_FUTURE_DATA = HAVE_FUTURE_DATA;
  readonly HAVE_ENOUGH_DATA = HAVE_ENOUGH_DATA;

  readonly seekable = EMPTY_TIME_RANGES;
  readonly buffered = EMPTY_TIME_RANGES;
  readonly seeking = false as const;

  private __srcObject: Stream | null = null;
  private __readyState: 0 | 1 | 2 | 3 | 4 = HAVE_NOTHING;
  private __duration: number = NaN;
  private __ended: boolean = false;
  private __paused: boolean = true;
  private __trackEndedSubscriptions: Array<{ track: globalThis.MediaStreamTrack; listener: () => void }> = [];
  private __native: NativeVideoViewRef | null = null;
  private __playStartMs: number = 0;
  private __notifyReact: (s: Stream | null) => void;

  constructor(notifyReact: (s: Stream | null) => void) {
    super();
    this.__notifyReact = notifyReact;
  }

  // @ref LLP 0004#srcObject
  get srcObject(): Stream | null { return this.__srcObject; }
  set srcObject(value: Stream | null) {
    if (value === this.__srcObject) return;
    this.__detachTrackListeners();
    this.__srcObject = value;
    this.__readyState = HAVE_NOTHING;
    this.__duration = NaN;
    this.__ended = false;
    this.__attachTrackListeners();
    // Trigger a React re-render so the native view receives the new srcObject prop.
    this.__notifyReact(value);
  }

  // @ref LLP 0004#readystate
  get readyState(): 0 | 1 | 2 | 3 | 4 { return this.__readyState; }

  // @ref LLP 0004#duration
  get duration(): number { return this.__duration; }

  // @ref LLP 0004#currentTime
  get currentTime(): number {
    if (this.__playStartMs === 0) return 0;
    return (Date.now() - this.__playStartMs) / 1000;
  }
  set currentTime(_value: number) {
    // @ref LLP 0004#srcobject-currentTime — UA MUST ignore attempts to set
  }

  get paused(): boolean { return this.__paused; }
  set paused(_value: boolean) { /* read-only effectively per spec */ }

  get ended(): boolean { return this.__ended; }
  set ended(_value: boolean) { /* read-only */ }

  // @ref LLP 0004#playbackRate
  get playbackRate(): number { return 1; }
  set playbackRate(_value: number) { /* no-op */ }

  // @ref LLP 0004#defaultPlaybackRate
  get defaultPlaybackRate(): number { return 1; }
  set defaultPlaybackRate(_value: number) { /* no-op */ }

  // @ref LLP 0004#preload
  get preload(): 'none' { return 'none'; }
  set preload(_value: string) { /* no-op */ }

  async play(): Promise<void> {
    await this.__native?.playAsync();
    this.__paused = false;
    this.__playStartMs = this.__playStartMs || Date.now();
  }

  pause(): void {
    void this.__native?.pauseAsync();
    this.__paused = true;
  }

  // Event-handler property accessors
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

  // @internal
  __bindNative(native: NativeVideoViewRef | null): void {
    this.__native = native;
  }

  __handleLoadedData(): void {
    if (this.__readyState !== HAVE_ENOUGH_DATA) {
      this.__readyState = HAVE_ENOUGH_DATA;
      this.dispatchEvent(new Event('loadeddata'));
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

  // @ref LLP 0004#ended — fire when all tracks become "ended"
  private __attachTrackListeners(): void {
    if (!this.__srcObject) return;
    for (const track of this.__srcObject.getTracks()) {
      const listener = () => {
        // Async check (spec: ended fires as a separate task)
        Promise.resolve().then(() => this.__maybeEnded());
      };
      track.addEventListener('ended', listener);
      this.__trackEndedSubscriptions.push({ track, listener });
    }
  }

  private __detachTrackListeners(): void {
    for (const { track, listener } of this.__trackEndedSubscriptions) {
      track.removeEventListener('ended', listener);
    }
    this.__trackEndedSubscriptions = [];
  }

  private __maybeEnded(): void {
    if (!this.__srcObject || this.__ended) return;
    const allEnded = this.__srcObject.getTracks().every((t) => t.readyState === 'ended');
    if (allEnded) {
      this.__ended = true;
      this.dispatchEvent(new Event('ended'));
    }
  }
}
