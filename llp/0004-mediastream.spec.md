# LLP 0004: `MediaStream` and `MediaStreamTrack` — iOS implementation

**Type:** Spec
**Status:** Active
**Systems:** standard-camera, ios
**Author:** James Ide
**Date:** 2026-05-19 (refactored 2026-05-21; expanded for clone/addTrack/removeTrack on 2026-05-21; audio added 2026-05-22)
**Related:** 0002, 0003, 0006, 0001, 0008

## Summary

This document records the iOS-specific behavior of our `MediaStream` and `MediaStreamTrack` SharedObjects. The spec text (IDL, MUSTs, algorithms) lives in [LLP 0001#dom-mediastream](./0001-w3c-spec-text.spec.md#mediastream-interface-dom-mediastream) and [#dom-mediastreamtrack](./0001-w3c-spec-text.spec.md#mediastreamtrack-interface-dom-mediastreamtrack). The in-scope/out-of-scope decisions are in [LLP 0002](./0002-spec-subset-scope.spec.md). What follows is the AVFoundation realization of those clauses and the small set of iOS-specific concerns that have no spec analog (notification observers, session lifecycle, simulator behavior).

Section anchors below are stable; code annotations cite them as `@ref LLP 0004#<anchor>`. Each section pairs the spec anchor it implements with the iOS specifics.

---

## `MediaStream`

`MediaStream` is the JS-side track container. Construction can happen in two ways:

1. **Native-backed** — `getUserMedia()` returns a JS wrapper over a native `MediaStream` SharedObject. The native handle carries the `id` and the initial track list.
2. **Script-constructed** — `new MediaStream()`, `new MediaStream(stream)`, `new MediaStream(sequence<MediaStreamTrack>)` build a JS-only wrapper with a JS-generated `id` (UUIDv4) and no `_native` handle. This is `stream-construction` below.

Live capture continues to live behind a Swift `CaptureSource` referenced (strong) by each `MediaStreamTrack` instance. `MediaStream` no longer owns the `AVCaptureSession` — the session is reference-counted by live tracks across original and cloned streams, so stopping all tracks of the original stream does not stop the camera when a clone is still consuming the same source.

### `stream-construction`

Implements [LLP 0001#mediastream-constructor](./0001-w3c-spec-text.spec.md#constructors-mediastream-constructor). All three constructor signatures are JS-side:

1. `new MediaStream()` → empty track set, fresh `id`.
2. `new MediaStream(otherStream)` → copy the tracks of `otherStream` into a new set (the tracks themselves are not cloned; they're added by reference).
3. `new MediaStream(tracks)` → take a `sequence<MediaStreamTrack>`, dedupe, and add to the set.

Script-constructed streams cannot be assigned to `<Video srcObject>` unless one of their tracks comes from a `getUserMedia` source — the `<Video>` view derives its `AVCaptureSession` from the first track's `CaptureSource`. A pure JS stream with no native-backed track is a JS-only construct and the video element will sit at `HAVE_NOTHING`.

### `stream-id`

### `stream-id`

Implements [LLP 0001#dom-mediastream-id](./0001-w3c-spec-text.spec.md#attribute-id-dom-mediastream-id). UUIDv4 (36 characters; the printable-ASCII subset that excludes whitespace and double quote per the spec's "allowed character set"). Generated in `MediaDevices.swift`'s `getUserMedia` for native-backed streams; generated in JS (`crypto.randomUUID()` when available, falling back to a `Math.random`-based RFC 4122 v4 generator otherwise) for script-constructed streams.

### `stream-active`

Implements [LLP 0001#dom-mediastream-active](./0001-w3c-spec-text.spec.md#attribute-active-dom-mediastream-active). Computed each access: `tracks.contains { $0.readyState == "live" }`. Not cached — cheap enough.

### `stream-getTracks`

Implements [LLP 0001#dom-mediastream-gettracks](./0001-w3c-spec-text.spec.md#method-gettracks-dom-mediastream-gettracks). Returns the `tracks` array directly. Swift arrays are value types, so the caller gets a copy — the "snapshot" semantics the spec requires are preserved.

### `stream-getVideoTracks`

### `stream-getAudioTracks`

Implements [LLP 0001#dom-mediastream-getvideotracks](./0001-w3c-spec-text.spec.md#method-getvideotracks-dom-mediastream-getvideotracks) and `#dom-mediastream-getaudiotracks`. Filtered by `kind`. A `getUserMedia({ audio: true })` stream contains one audio track; a combined `{audio, video}` stream contains both.

### `stream-getTrackById`

Implements [LLP 0001#dom-mediastream-gettrackbyid](./0001-w3c-spec-text.spec.md#method-gettrackbyidtrackid-dom-mediastream-gettrackbyid). Linear scan; first match.

### `stream-addtrack`

Implements [LLP 0001#dom-mediastream-addtrack](./0001-w3c-spec-text.spec.md#method-addtracktrack-dom-mediastream-addtrack). If the track is not already in `#tracks`, append it. The native `MediaStream` is also notified so its track set stays in sync (used by the `<Video>` view to resolve the first video track's `CaptureSource`).

Per spec, `addTrack` is **script-initiated** and the `addtrack` event does **not** fire — it fires only when the user agent itself adds a track (e.g., a network-driven RTP path). Our subset has no such path, so we never fire it; the `onaddtrack` handler attribute still exists for IDL conformance and `addEventListener('addtrack', …)` works (listeners just never receive an event).

### `stream-removetrack`

Implements [LLP 0001#dom-mediastream-removetrack](./0001-w3c-spec-text.spec.md#method-removetracktrack-dom-mediastream-removetrack). If the track is in `#tracks`, remove it; otherwise this is a silent no-op (per spec, "abort").

Per spec, `removeTrack` is **script-initiated** and the `removetrack` event does **not** fire. Removing a track does *not* implicitly call `track.stop()` — the track keeps its `readyState` and continues to deliver frames to any other stream / consumer that holds it. The WPT `MediaStream-removetrack` test verifies that after `stream.removeTrack(track)`, the `video.srcObject = stream` element's `ended` event fires only when the *other* tracks of the stream also leave or end — not because removing a track stops it.

### `stream-events`

The native `MediaStream` (for native-backed streams) installs three observers on its `AVCaptureSession`:

- `AVCaptureSession.wasInterruptedNotification` → every track's `muted` flips to `true` and fires `mute`.
- `AVCaptureSession.interruptionEndedNotification` → every track's `muted` flips to `false` and fires `unmute`.
- `AVCaptureSession.runtimeErrorNotification` → every track is ended (readyState → `"ended"`, fires `ended`).

These are stream-scoped observers because `AVCaptureSession` is the unit iOS notifies; we fan out to per-track events because that's what the spec exposes to JS.

### `stream-clone`

Implements [LLP 0001#dom-mediastream-clone](./0001-w3c-spec-text.spec.md#method-clone-dom-mediastream-clone). Algorithm:

1. Build a new `MediaStream` with a freshly-generated `id`.
2. For each track in `this.#tracks`, call `track.clone()` and add the result to the new stream's track set.
3. Return the new stream.

The clone is a JS-only stream (no `_native`) when constructed via this path. Each cloned track shares the underlying `CaptureSource` with its original, so the camera stays live as long as any clone references it. See `track-clone` below.

### Session lifecycle

- The session is created inside `getUserMedia` ([LLP 0003#gum-build-session](./0003-getusermedia.spec.md#gum-build-session)). Audio-only streams start immediately on the session queue; video streams start lazily when a preview or `ImageCapture` consumer requests frames.
- The `AVCaptureSession` is owned by a `CaptureSource` Swift object that is reference-counted by **live** `MediaStreamTrack` instances. Each native track strong-refs its source; on `stop()` (or runtime-error end), the track unregisters itself. When the live count reaches zero, the `CaptureSource`'s `unregisterTrack` posts `stopRunning` to the session queue.
- This shape means clones keep the source live: stopping every track of the original stream does *not* end the source as long as a cloned track still references it. The session is fully torn down only when every original-and-cloned track has been ended.
- When the last native `VideoView` preview detaches, `CaptureSource` may pause the underlying session without ending tracks. A later `<Video>.play()` or `ImageCapture.grabFrame()` request restarts it on the session queue. Multiple attached views can still show the same stream; detaching one view does not pause while another preview remains subscribed.

---

## `MediaStreamTrack`

A `SharedObject` holding metadata (`id`, `kind`, `label`, `enabled`, `muted`, `readyState`, `settings`, `constraints`) plus a weak back-reference to the owning `MediaStream` and to the `AVCaptureConnection` between the capture device input and the FrameSink output.

### `track-id`

Implements [LLP 0001#dom-mediastreamtrack-id](./0001-w3c-spec-text.spec.md#attribute-id-dom-mediastreamtrack-id). UUIDv4 from `gum-build-session`. Stored as `let`.

### `track-kind`

Implements [LLP 0001#dom-mediastreamtrack-kind](./0001-w3c-spec-text.spec.md#attribute-kind-dom-mediastreamtrack-kind). `"video"` for camera tracks; `"audio"` for microphone tracks. The audio implementation lives in [LLP 0008](./0008-audio-ios-mapping.decision.md).

### `track-label`

Implements [LLP 0001#dom-mediastreamtrack-label](./0001-w3c-spec-text.spec.md#attribute-label-dom-mediastreamtrack-label). Set to `AVCaptureDevice.localizedName` at construction. Stored as `let` — never mutated. (An earlier revision of this LLP and the implementation incorrectly cleared `label` after `stop()`; the spec mandates no such clearing. Fixed 2026-05-21.)

### `track-enabled`

Implements [LLP 0001#dom-mediastreamtrack-enabled](./0001-w3c-spec-text.spec.md#attribute-enabled-dom-mediastreamtrack-enabled). Read/write `Bool`, default `true`. Setting flips the `AVCaptureConnection.isEnabled` on the FrameSink data output, which stops frames from being delivered downstream.

Caveat: the spec describes the `enabled = false` effect as "the track is muted at the source" (frames become black for video / silence for audio, but the track still nominally produces samples). On our preview path, the `AVCaptureVideoPreviewLayer` has its own internal connection that we don't toggle, so the on-screen preview keeps showing the most recent frame after `enabled = false`. Downstream consumers (FrameSink, future MediaRecorder, etc.) stop receiving samples as expected. Documented divergence; consider it good enough until someone needs strict "produce black frames" behavior.

### `track-muted`

Implements [LLP 0001#dom-mediastreamtrack-muted](./0001-w3c-spec-text.spec.md#attribute-muted-dom-mediastreamtrack-muted). Reflects the parent `AVCaptureSession`'s interruption state — see `stream-events` above.

iOS interruption reasons that map to `muted = true` (all of them; the spec only cares that the source is temporarily unable to provide data):

- `videoDeviceNotAvailableInBackground` — app went to background
- `videoDeviceInUseByAnotherClient` — another app opened the camera
- `videoDeviceNotAvailableWithMultipleForegroundApps` — Split View on iPad
- `videoDeviceNotAvailableDueToSystemPressure` — **thermal pressure / overheating**
- `sensitiveContentMitigationActivated` — iOS 17+ content moderation

### `track-readyState`

Implements [LLP 0001#dom-mediastreamtrack-readystate](./0001-w3c-spec-text.spec.md#attribute-readystate-dom-mediastreamtrack-readystate). `"live"` initially; transitions to `"ended"` exactly once via either:

- `stop()` (explicit JS call) — see `track-stop` below
- An `AVCaptureSessionRuntimeErrorNotification` on the underlying session — see `stream-events`

Once `"ended"`, `setMuted` calls are no-ops; `label` is unchanged.

### `track-stop`

Implements [LLP 0001#dom-mediastreamtrack-stop](./0001-w3c-spec-text.spec.md#method-stop-dom-mediastreamtrack-stop). Our algorithm:

1. If `readyState == "ended"` → return (idempotent per spec).
2. Notify the `CaptureSource` that this track ended. The source owns the live-track refcount and stops the `AVCaptureSession` when no live tracks remain; for single-track video streams this releases the camera and turns off the indicator light.
3. Set `readyState = "ended"` synchronously before the bridge call returns.
4. Do **not** fire the public `ended` event. The spec reserves `ended` for source endings other than explicit `stop()`.

The JS wrapper queues an internal, prefixed `__standardcamera_trackended` event after `stop()` so `<Video>` / the test audio element can re-evaluate whether their assigned `MediaStream` became inactive. This is intentionally not the public `MediaStreamTrack` `ended` event.

### `track-events`

`ended` / `mute` / `unmute` — see [LLP 0001#dom-mediastreamtrack-mute-algorithm](./0001-w3c-spec-text.spec.md#event-setting-muted-state-dom-mediastreamtrack-mute-algorithm) and `#event-mediastreamtrack-ended`. Native side uses `SharedObject.emit`, which runs the dispatch on the JS runtime — the JS-side `MediaStreamTrack` class subscribes once in its constructor and re-dispatches as DOM `Event` objects. The public `ended` event is emitted only for non-`stop()` source endings such as `AVCaptureSessionRuntimeErrorNotification`.

### `track-getSettings`

Implements [LLP 0001#dom-mediastreamtrack-getsettings](./0001-w3c-spec-text.spec.md#method-getsettings-dom-mediastreamtrack-getsettings). Returns the snapshot captured at construction:

For a video track (settings come from [LLP 0003#gum-build-session](./0003-getusermedia.spec.md#gum-build-session)):

```ts
{
  deviceId: string,          // AVCaptureDevice.uniqueID
  groupId: string,           // matches deviceId in v1 (single-camera groups)
  facingMode: "user" | "environment",
  width: number,             // active format dimensions, not the preset
  height: number,
  frameRate: number,         // device.activeFormat.videoSupportedFrameRateRanges[0].maxFrameRate
  aspectRatio: number,
  resizeMode: "none"
}
```

For an audio track (settings come from [LLP 0008#audio-track-settings](./0008-audio-ios-mapping.decision.md#audio-track-settings)):

```ts
{
  deviceId: string,
  groupId: string,
  sampleRate: number,        // AVAudioSession.sampleRate
  sampleSize: number,        // 16 in v1
  echoCancellation: boolean | "all" | "remote-only",
  autoGainControl: boolean,
  noiseSuppression: boolean,
  voiceIsolation: boolean,
  latency: number,           // AVAudioSession.inputLatency, seconds
  channelCount: number
}
```

Per spec, after `readyState == "ended"` we still return the settings as they were at end time. We get this for free because the snapshot is captured at construction and never reread.

### `track-getConstraints`

Implements [LLP 0001#dom-mediastreamtrack-getconstraints](./0001-w3c-spec-text.spec.md#method-getconstraints-dom-mediastreamtrack-getconstraints). Returns the flattened constraints we received from JS — *not* the original `ConstrainDOMString`-shaped input. Strictly, the spec returns "the constraints currently applied to the track"; our return value reflects the applied scalars but doesn't reconstruct the original exact/ideal envelope. Known divergence (see [LLP 0003 open question #3](./0003-getusermedia.spec.md#open-questions)).

### `track-getCapabilities`

Implements [LLP 0001#dom-mediastreamtrack-getcapabilities](./0001-w3c-spec-text.spec.md#method-getcapabilities-dom-mediastreamtrack-getcapabilities). Video tracks report `width`, `height`, `aspectRatio`, `frameRate` (as `{min, max}`), `facingMode` and `resizeMode` (as arrays), plus `deviceId` and `groupId`. Audio tracks report `sampleRate`, `sampleSize`, `latency`, `channelCount` (as `{min, max}`), `echoCancellation`, `autoGainControl`, `noiseSuppression`, `voiceIsolation` (as boolean arrays), plus `deviceId` and `groupId`. See [LLP 0008#audio-track-capabilities](./0008-audio-ios-mapping.decision.md#audio-track-capabilities) for the audio derivation.

### `track-clone`

Implements [LLP 0001#dom-mediastreamtrack-clone](./0001-w3c-spec-text.spec.md#method-clone-dom-mediastreamtrack-clone). Algorithm:

1. If `this.readyState == "ended"`, the clone is born in the `"ended"` state with no live consumer of the source.
2. Otherwise, create a new native `MediaStreamTrack` with:
   - A fresh `id` (UUIDv4).
   - The same `CaptureSource` (strong-referenced, increments the live count).
   - The same `label`, `settings`, `constraints`, `kind`.
   - `enabled = true` (independent of the original; the spec leaves the initial value of a clone's `enabled` unspecified but Chrome / Firefox both reset it to `true`).
3. Return the new track.

Two important consequences:

- **Independent stop**. Stopping the original does not stop the clone; the clone keeps the underlying camera open via its strong reference to the same `CaptureSource`. This is how the canonical WPT `MediaStream-clone` test verifies cloning works.
- **Shared `enabled` plumbing — divergence**. Our `enabled` setter toggles the shared `AVCaptureConnection.isEnabled` on the FrameSink. Because clones share a `CaptureSource` (and therefore the connection), setting `enabled = false` on one clone disables frame delivery for *all* consumers downstream of the FrameSink. This is the same divergence the original-only path has with `AVCaptureVideoPreviewLayer` (its internal connection isn't toggled), now also between clones. We accept this in v1; making `enabled` per-track would require switching to a per-track `AVAssetWriter`-style consumer pipeline.

### `track-applyConstraints`

Implements [LLP 0001#dom-mediastreamtrack-applyconstraints](./0001-w3c-spec-text.spec.md#method-applyconstraintsconstraints-dom-mediastreamtrack-applyconstraints). Algorithm:

1. If `this.readyState == "ended"`, return a resolved promise. (Spec MUST.)
2. If the constraints object is `undefined` or empty (`{}`), return a resolved promise without modifying the track. (Spec allows constraints to "be empty" and we treat that as a no-op.)
3. Otherwise, return a rejected promise with `OverconstrainedError` whose `constraint` field names the first unsatisfiable constraint. v1 does not actually re-configure the AVCaptureSession; any non-empty constraints object is treated as unsatisfiable. See [LLP 0002 open question #3](./0002-spec-subset-scope.spec.md#open-questions).

---

## Open questions

- ~~Multi-track streams: how do we coordinate session stop across tracks?~~ Resolved: `CaptureSource.liveTrackCount` covers any kind of track. When a combined audio/video stream's video track stops, the live count drops to 1 (audio is still live), so the session keeps running until the audio track also ends. Stopping the audio track first behaves symmetrically.
- `track-getConstraints` should ideally round-trip the original constraint shape. Today the bridge loses the `{exact: ...}` / `{ideal: ...}` envelope (see [LLP 0003 open question #3](./0003-getusermedia.spec.md#open-questions)).
