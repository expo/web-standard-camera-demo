# LLP 0003: `MediaStream` and `MediaStreamTrack` — iOS implementation

**Type:** Spec
**Status:** Active
**Systems:** standard-camera, ios
**Author:** James Ide
**Date:** 2026-05-19 (refactored 2026-05-21)
**Related:** 0001, 0002, 0005, 0008

## Summary

This document records the iOS-specific behavior of our `MediaStream` and `MediaStreamTrack` SharedObjects. The spec text (IDL, MUSTs, algorithms) lives in [LLP 0008#dom-mediastream](./0008-w3c-spec-text.spec.md#mediastream-interface-dom-mediastream) and [#dom-mediastreamtrack](./0008-w3c-spec-text.spec.md#mediastreamtrack-interface-dom-mediastreamtrack). The in-scope/out-of-scope decisions are in [LLP 0001](./0001-spec-subset-scope.spec.md). What follows is the AVFoundation realization of those clauses and the small set of iOS-specific concerns that have no spec analog (notification observers, session lifecycle, simulator behavior).

Section anchors below are stable; code annotations cite them as `@ref LLP 0003#<anchor>`. Each section pairs the spec anchor it implements with the iOS specifics.

---

## `MediaStream`

`MediaStream` is a [`SharedRef`-like](https://github.com/expo/expo/blob/main/packages/expo-modules-core/ios/Core/SharedObjects/SharedObject.swift) `SharedObject` that owns an `AVCaptureSession` and a snapshot array of tracks. The session is the unit of capture; tracks describe what's flowing through it. JS receives an opaque handle and uses the spec-shaped methods on the TS wrapper class.

### `stream-id`

Implements [LLP 0008#dom-mediastream-id](./0008-w3c-spec-text.spec.md#attribute-id-dom-mediastream-id). UUIDv4 generated in `MediaDevices.swift`'s `getUserMedia` and stored as `let id` on the Swift `MediaStream`.

### `stream-active`

Implements [LLP 0008#dom-mediastream-active](./0008-w3c-spec-text.spec.md#attribute-active-dom-mediastream-active). Computed each access: `tracks.contains { $0.readyState == "live" }`. Not cached — cheap enough.

### `stream-getTracks`

Implements [LLP 0008#dom-mediastream-gettracks](./0008-w3c-spec-text.spec.md#method-gettracks-dom-mediastream-gettracks). Returns the `tracks` array directly. Swift arrays are value types, so the caller gets a copy — the "snapshot" semantics the spec requires are preserved.

### `stream-getVideoTracks` / `stream-getAudioTracks`

Implements [LLP 0008#dom-mediastream-getvideotracks](./0008-w3c-spec-text.spec.md#method-getvideotracks-dom-mediastream-getvideotracks) and `#dom-mediastream-getaudiotracks`. Filtered by `kind`. `getAudioTracks` always returns `[]` in v1 (audio out of scope).

### `stream-getTrackById`

Implements [LLP 0008#dom-mediastream-gettrackbyid](./0008-w3c-spec-text.spec.md#method-gettrackbyidtrackid-dom-mediastream-gettrackbyid). Linear scan; first match.

### `stream-events`

The spec's `addtrack` / `removetrack` events ([LLP 0008#event-mediastream-addtrack](./0008-w3c-spec-text.spec.md#event-addtrack-event-mediastream-addtrack)) are not fired in v1 because `addTrack` / `removeTrack` are out of scope. The native `MediaStream` does install three other observers on its `AVCaptureSession`:

- `AVCaptureSession.wasInterruptedNotification` → every track's `muted` flips to `true` and fires `mute`.
- `AVCaptureSession.interruptionEndedNotification` → every track's `muted` flips to `false` and fires `unmute`.
- `AVCaptureSession.runtimeErrorNotification` → every track is ended (readyState → `"ended"`, fires `ended`).

These are stream-scoped observers because `AVCaptureSession` is the unit iOS notifies; we fan out to per-track events because that's what the spec exposes to JS.

### Session lifecycle

- The session is created and started inside `getUserMedia` ([LLP 0002#gum-build-session](./0002-getusermedia.spec.md#gum-build-session)).
- It is stopped when:
  1. The last live track has its `stop()` called ([LLP 0008#dom-mediastreamtrack-stop](./0008-w3c-spec-text.spec.md#method-stop-dom-mediastreamtrack-stop) step 3; spec says "notify track's source that track is ended", which on AVFoundation means stopping the capture session if no other tracks need it).
  2. The JS-side `MediaStream` handle is garbage-collected (`sharedObjectWillRelease` posts a `stopRunning` to the session queue).
- The session is **not** stopped when a `VideoView` is removed from the React tree — the stream lives independently of any view. Multiple views can show the same stream.

---

## `MediaStreamTrack`

A `SharedObject` holding metadata (`id`, `kind`, `label`, `enabled`, `muted`, `readyState`, `settings`, `constraints`) plus a weak back-reference to the owning `MediaStream` and to the `AVCaptureConnection` between the capture device input and the FrameSink output.

### `track-id`

Implements [LLP 0008#dom-mediastreamtrack-id](./0008-w3c-spec-text.spec.md#attribute-id-dom-mediastreamtrack-id). UUIDv4 from `gum-build-session`. Stored as `let`.

### `track-kind`

Implements [LLP 0008#dom-mediastreamtrack-kind](./0008-w3c-spec-text.spec.md#attribute-kind-dom-mediastreamtrack-kind). Always `"video"` in v1 (audio out of scope).

### `track-label`

Implements [LLP 0008#dom-mediastreamtrack-label](./0008-w3c-spec-text.spec.md#attribute-label-dom-mediastreamtrack-label). Set to `AVCaptureDevice.localizedName` at construction. Stored as `let` — never mutated. (An earlier revision of this LLP and the implementation incorrectly cleared `label` after `stop()`; the spec mandates no such clearing. Fixed 2026-05-21.)

### `track-enabled`

Implements [LLP 0008#dom-mediastreamtrack-enabled](./0008-w3c-spec-text.spec.md#attribute-enabled-dom-mediastreamtrack-enabled). Read/write `Bool`, default `true`. Setting flips the `AVCaptureConnection.isEnabled` on the FrameSink data output, which stops frames from being delivered downstream.

Caveat: the spec describes the `enabled = false` effect as "the track is muted at the source" (frames become black for video / silence for audio, but the track still nominally produces samples). On our preview path, the `AVCaptureVideoPreviewLayer` has its own internal connection that we don't toggle, so the on-screen preview keeps showing the most recent frame after `enabled = false`. Downstream consumers (FrameSink, future MediaRecorder, etc.) stop receiving samples as expected. Documented divergence; consider it good enough until someone needs strict "produce black frames" behavior.

### `track-muted`

Implements [LLP 0008#dom-mediastreamtrack-muted](./0008-w3c-spec-text.spec.md#attribute-muted-dom-mediastreamtrack-muted). Reflects the parent `AVCaptureSession`'s interruption state — see `stream-events` above.

iOS interruption reasons that map to `muted = true` (all of them; the spec only cares that the source is temporarily unable to provide data):

- `videoDeviceNotAvailableInBackground` — app went to background
- `videoDeviceInUseByAnotherClient` — another app opened the camera
- `videoDeviceNotAvailableWithMultipleForegroundApps` — Split View on iPad
- `videoDeviceNotAvailableDueToSystemPressure` — **thermal pressure / overheating**
- `sensitiveContentMitigationActivated` — iOS 17+ content moderation

### `track-readyState`

Implements [LLP 0008#dom-mediastreamtrack-readystate](./0008-w3c-spec-text.spec.md#attribute-readystate-dom-mediastreamtrack-readystate). `"live"` initially; transitions to `"ended"` exactly once via either:

- `stop()` (explicit JS call) — see `track-stop` below
- An `AVCaptureSessionRuntimeErrorNotification` on the underlying session — see `stream-events`

Once `"ended"`, `setMuted` calls are no-ops; `label` is unchanged.

### `track-stop`

Implements [LLP 0008#dom-mediastreamtrack-stop](./0008-w3c-spec-text.spec.md#method-stop-dom-mediastreamtrack-stop). Our algorithm:

1. If `readyState == "ended"` → return (idempotent per spec).
2. Set `readyState = "ended"` synchronously.
3. Disable the data-output `AVCaptureConnection` so frames stop flowing downstream.
4. Ask the owning `MediaStream` whether any live tracks remain; if not, stop the `AVCaptureSession`. This is the AVFoundation realization of "notify track's source that track is ended" — for single-track video streams it means releasing the camera and turning off the indicator light.
5. Fire `ended` via `SharedObject.emit`, which schedules it asynchronously on the JS runtime's thread — matching the spec's "fire as a separate task" requirement.

### `track-events`

`ended` / `mute` / `unmute` — see [LLP 0008#dom-mediastreamtrack-mute-algorithm](./0008-w3c-spec-text.spec.md#event-setting-muted-state-dom-mediastreamtrack-mute-algorithm) and `#event-mediastreamtrack-ended`. Native side uses `SharedObject.emit`, which runs the dispatch on the JS runtime — the JS-side `MediaStreamTrack` class subscribes once in its constructor and re-dispatches as DOM `Event` objects.

### `track-getSettings`

Implements [LLP 0008#dom-mediastreamtrack-getsettings](./0008-w3c-spec-text.spec.md#method-getsettings-dom-mediastreamtrack-getsettings). Returns the snapshot captured in `gum-build-session`:

```ts
{
  deviceId: string,          // AVCaptureDevice.uniqueID
  groupId: string,           // matches deviceId in v1 (single-camera groups)
  facingMode: "user" | "environment",
  width: number,             // active format dimensions, not the preset
  height: number,
  frameRate: number,         // device.activeFormat.videoSupportedFrameRateRanges[0].maxFrameRate
  aspectRatio: number
}
```

Per spec, after `readyState == "ended"` we still return the settings as they were at end time. We get this for free because the snapshot is captured at construction and never reread.

### `track-getConstraints`

Implements [LLP 0008#dom-mediastreamtrack-getconstraints](./0008-w3c-spec-text.spec.md#method-getconstraints-dom-mediastreamtrack-getconstraints). Returns the flattened constraints we received from JS — *not* the original `ConstrainDOMString`-shaped input. Strictly, the spec returns "the constraints currently applied to the track"; our return value reflects the applied scalars but doesn't reconstruct the original exact/ideal envelope. Known divergence (see [LLP 0002 open question #3](./0002-getusermedia.spec.md#open-questions)).

### `track-getCapabilities`

Implements [LLP 0008#dom-mediastreamtrack-getcapabilities](./0008-w3c-spec-text.spec.md#method-getcapabilities-dom-mediastreamtrack-getcapabilities). Returns `{}` in v1. The spec allows an empty `MediaTrackCapabilities`.

### Out of scope

- `track-clone` — throws `NotSupportedError`. See [LLP 0001](./0001-spec-subset-scope.spec.md).
- `track-applyConstraints` — rejects with `OverconstrainedError`. See [LLP 0001](./0001-spec-subset-scope.spec.md).

---

## Open questions

- Multi-track streams (e.g., when we add audio): how do we coordinate session stop across tracks? `track-stop` step 4 already checks for other live tracks, but the audio track and video track will share a session in our v1+audio plan, so we'll need to make sure stopping one doesn't break the other.
- `track-getConstraints` should ideally round-trip the original constraint shape. Today the bridge loses the `{exact: ...}` / `{ideal: ...}` envelope (see [LLP 0002 open question #3](./0002-getusermedia.spec.md#open-questions)).
