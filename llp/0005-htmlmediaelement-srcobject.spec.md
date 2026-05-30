# LLP 0005: `HTMLMediaElement.srcObject` subset

**Type:** Spec
**Status:** Active
**Systems:** standard-camera
**Author:** James Ide
**Date:** 2026-05-19 (refactored 2026-05-21)
**Related:** 0002, 0004, 0006, 0001

## Summary

We don't have a real `HTMLMediaElement` in React Native, so our `<Video>` component exposes the subset of the `HTMLMediaElement` interface required to consume a `MediaStream` via `srcObject`. The settable surface is exposed both as a prop (`<Video srcObject={stream} />`) and as a property on a ref (`videoRef.current.srcObject = stream`). The ref form mirrors DOM idiom 1:1.

[LLP 0001](./0001-w3c-spec-text.spec.md) deliberately does not cover this material: the W3C "Media Capture and Streams" spec defers HTMLMediaElement behavior to the HTML Standard, which is too large to inline. This LLP is the local source-of-truth for the `srcObject` invariants we implement, with deep links to the HTML Standard for anyone wanting the full spec context.

## Spec sources

- **`srcObject` IDL attribute** ([HTML Standard `#dom-media-srcobject`](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject)):

  > The `srcObject` IDL attribute, on getting, must return the element's assigned media provider object, if any, or null otherwise. On setting, it must set the element's assigned media provider object to the new value, and then invoke the element's media element load algorithm.

  Our setter (`HTMLVideoElement.tsx`'s `VideoElementImpl.srcObject`) implements this: stores the value, resets `readyState` / `duration` / `ended`, detaches old track listeners, attaches new ones, and forwards the new MediaProvider id to the native view (which sets it on the `AVCaptureVideoPreviewLayer`).

- **Media element load algorithm** ([HTML Standard `#concept-media-load-algorithm`](https://html.spec.whatwg.org/multipage/media.html#concept-media-load-algorithm)) — determines the `readyState` transitions and the firing of `loadeddata` / `durationchange` events. We don't implement the algorithm verbatim; we implement the *observable behavior* for MediaProvider sources via the FrameSink delegate signaling first frame.

- **`readyState` constants** ([HTML Standard `#ready-states`](https://html.spec.whatwg.org/multipage/media.html#ready-states)): `HAVE_NOTHING = 0` through `HAVE_ENOUGH_DATA = 4`. We use the same integer values.

- **W3C Media Capture § HTMLMediaElement extensions** ([`#htmlmediaelement-extensions`](https://www.w3.org/TR/mediacapture-streams/#htmlmediaelement-extensions)) — deferral statement, no normative behavior of its own.

The invariants listed below are what falls out of the above when the media provider is a non-seekable `MediaStream`. They're verified by our ported WPT tests (`MediaStream-MediaElement-srcObject.test.ts`).

<a id="srcObject"></a>
## The ref surface

A `<Video>` ref exposes:

```ts
interface VideoRef {
  // Stream
  srcObject: MediaStream | null;            // get/set

  // ReadyState — same numeric constants as HTMLMediaElement
  readyState: 0 | 1 | 2 | 3 | 4;
  HAVE_NOTHING: 0;
  HAVE_METADATA: 1;
  HAVE_CURRENT_DATA: 2;
  HAVE_FUTURE_DATA: 3;
  HAVE_ENOUGH_DATA: 4;

  // Time / duration
  duration: number;       // NaN until loaded, Infinity after
  currentTime: number;    // get returns elapsed since play; setter is no-op
  seekable: { length: 0 };
  buffered: { length: 0 };
  seeking: false;

  // Playback
  paused: boolean;
  ended: boolean;
  playbackRate: number;          // always 1; setter is no-op
  defaultPlaybackRate: number;   // always 1
  preload: "none";               // setter is no-op
  play(): Promise<void>;
  pause(): void;

  // Events
  addEventListener(type, listener, options?): void;
  removeEventListener(type, listener, options?): void;
  onloadeddata: ((ev: Event) => void) | null;
  ondurationchange: ((ev: Event) => void) | null;
  onended: ((ev: Event) => void) | null;
  onplay: ((ev: Event) => void) | null;
  onpause: ((ev: Event) => void) | null;
}
```

## Required invariants

<a id="readystate"></a><a id="readystate-constants"></a>
### `srcObject-readyState`

- Initially `readyState === HAVE_NOTHING (0)`.
- When the first frame is captured (signaled by the `FrameSink` data-output delegate firing — see [LLP 0006#first-frame-detection](./0006-ios-native-mapping.decision.md)), set `readyState = HAVE_ENOUGH_DATA (4)` and fire `loadeddata`.

<a id="duration"></a>
### `srcObject-duration`

- Initially `duration === NaN`.
- When transitioning to `HAVE_ENOUGH_DATA`, set `duration = Infinity` and fire `durationchange`.

<a id="currentTime"></a>
### `srcObject-currentTime`

- Get: returns elapsed wall-clock seconds since `play()` or first frame. While
  playing, repeated reads in the same JavaScript task return the same sampled
  "last known" time so `played.end(0) === currentTime` and no-op setter checks
  are not made flaky by a one-millisecond wall-clock tick between reads.
- Set: the UA MUST ignore attempts to set `currentTime` for a MediaStream source. Per the WPT test, the assignment `vid.currentTime = 42` must leave `currentTime` at `0` (or its actual elapsed value).

<a id="defaultPlaybackRate"></a><a id="playbackRate"></a>
### `srcObject-playbackRate`

- Get: always returns `1`.
- Set: ignored. `vid.playbackRate = 0.5; expect(vid.playbackRate).toBe(1)`.

<a id="preload"></a>
### `srcObject-preload`

- Always `"none"`.
- Set: ignored.

<a id="seekable"></a>
### `srcObject-seekable`

- `seekable.length === 0`. We expose a `TimeRanges`-shaped polyfill (`{ length: 0, start, end }` where start/end throw `InvalidStateError` if called with length 0).

<a id="played"></a>
### `srcObject-ended`

- `ended` becomes `true` asynchronously after every track in `srcObject` has `readyState === "ended"`. The transition fires an `ended` event. Because `MediaStreamTrack.stop()` does not fire the public track `ended` event, the JS track wrapper queues a prefixed internal `__standardcamera_trackended` event for media-element bookkeeping.

<a id="playback"></a>
### `srcObject-play-pause`

- `play()` starts the underlying `AVCaptureSession` if not running; resolves; fires `play`.
- `pause()` stops the underlying `AVCaptureSession`; sets `paused = true`; fires `pause`.

<a id="prop-vs-ref"></a>
## Prop vs. ref attribute

The prop form is for ergonomic React code:

```tsx
<Video srcObject={stream} />
```

The ref form mirrors the DOM:

```tsx
const videoRef = useRef<VideoRef>(null);
useEffect(() => {
  videoRef.current!.srcObject = stream;
  videoRef.current!.onloadeddata = () => console.log("ready");
}, [stream]);
```

If both are set, the last writer wins (the React reconciler will set the prop after the user sets the ref, or vice versa). Internally both routes funnel through the same setter, which:

1. Sends the new `MediaStream` shared object handle to native via a `srcObject` prop on the underlying view.
2. Resets `readyState = 0`, `duration = NaN`, `ended = false`.
3. Waits for the native `loadeddata` event to fire the transitions above.

## Preview mirroring

The standard browser idiom for a self-view preview is a horizontal transform on
the video element (`scaleX(-1)`). The React Native surface accepts the equivalent
style (`transform: [{ scaleX: -1 }]`) on `<Video>`.

On iOS the rendered camera pixels live inside an `AVCaptureVideoPreviewLayer`,
not a DOM/CSS box. The native view translates the React style's effective
horizontal flip into `AVCaptureConnection.isVideoMirrored`, the AVFoundation
preview-only mirror flag. The preview layer subclass observes every
`transform` setter call from React Native, including a clear-to-identity write.
This is required because the native view resets the CALayer transform to
identity after translating it; plain KVO can miss a later React style clear
when the underlying CALayer is already identity, leaving a stale front-camera
mirror active when a later back-camera stream attaches to the same view.

This mirror affects only display. Frame sinks, `ImageCapture`, and
`MediaStreamTrack.getSettings()` continue to observe the unmirrored source
frames.

## What we don't expose

- `src` (URL-based source). React Native developers should reach for `expo-video` for URL playback.
- `canPlayType`, `crossOrigin`, `muted` audio routing, `volume`, `played` (`TimeRanges`).
- `error` (the `MediaError` object). v1 surfaces capture-time errors as the `getUserMedia()` promise rejection, not through `ref.current.error`.

These omissions are because the underlying view is an `AVCaptureVideoPreviewLayer`, not an `AVPlayerLayer`. Adding URL playback would require a different native view (likely shared with `expo-video`).

## Open questions

1. Should `ended` event also fire on the underlying `MediaStreamTrack` objects we observe? Only for non-`stop()` source endings. The spec says `stop()` sets `readyState` to `"ended"` without firing `ended`; `<Video>` listens to the internal `__standardcamera_trackended` event for both stop-driven and source-driven state changes.
2. Should we expose `error: MediaError | null`? Out of scope until a use case appears.
