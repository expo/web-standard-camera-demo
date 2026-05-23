# LLP 0001: Spec subset scope

**Type:** Spec
**Status:** Active
**Systems:** standard-camera
**Author:** James Ide
**Date:** 2026-05-19
**Related:** 0000, 0002, 0003, 0004

## Summary

This document is the index of which clauses of [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) (Editor's Draft) and the [HTML `srcObject` section](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject) we implement, stub, or omit.

- **[LLP 0008](./0008-w3c-spec-text.spec.md)** holds the spec text itself, with each member at the matching W3C anchor (e.g. `dom-mediastreamtrack-stop`). Code annotations that exist *because of* a spec clause should cite that anchor: `@ref LLP 0008#<anchor>`.
- **This LLP (0001)** and the per-interface notes (0002–0004) record our *scope decisions* — which clauses are in vs. out, and the iOS-specific implementation paths through them.

The scope is intentionally tiny: enough to let `navigator.mediaDevices.getUserMedia({ video: true })` resolve to a `MediaStream` whose video track displays in a `<Video srcObject={stream} />`.

### Audio is deferred

v1 is video-only. `getUserMedia({ audio: <anything truthy> })` rejects with `OverconstrainedError` carrying `constraint: 'audio'`. `MediaStream.getAudioTracks()` always returns `[]`. The audio constraint family (`sampleRate`, `sampleSize`, `echoCancellation`, `autoGainControl`, `noiseSuppression`, `voiceIsolation`, `latency`, `channelCount`) appears in `getSupportedConstraints()` for IDL conformance, but no audio settings or capabilities are reported because no audio track is ever returned. The in-app WPT runner uses its `ENV_SKIPPED_SOURCES` / `ENV_SKIPPED_TEST_NAMES` mechanism to mark audio-dependent tests as `skip` with the rationale "audio capture is deferred (LLP 0001 v1 is video-only)" so they are visible but distinguished from regressions. A follow-up LLP will define the audio scope (mic device pick, audio track type, capabilities) when an audio consumer asks for it.

## Status legend

- **Implemented** — fully implemented and validated by a ported WPT test
- **Implemented (no test)** — implemented but no WPT test ported yet
- **Stubbed** — present on the JS surface but throws / returns a no-op value
- **Out of scope** — not present at all in v1

## `navigator.mediaDevices` — `MediaDevices` interface

Section: [§ MediaDevices](https://www.w3.org/TR/mediacapture-streams/#mediadevices)

| Anchor | Member | Status | Notes |
|---|---|---|---|
| `mediadevices-getusermedia` | `getUserMedia(constraints)` | **Implemented** | Video-only; see [LLP 0002](./0002-getusermedia.spec.md). |
| `mediadevices-enumeratedevices` | `enumerateDevices()` | **Stubbed** | Returns the default front camera as a single `MediaDeviceInfo`. |
| `mediadevices-getsupportedconstraints` | `getSupportedConstraints()` | **Stubbed** | Returns `{ width: true, height: true, facingMode: true }`. |
| `mediadevices-ondevicechange` | `ondevicechange` / `devicechange` event | **Out of scope** | We never fire it. |
| `mediadevices-getdisplaymedia` | `getDisplayMedia()` | **Out of scope** | — |

## `MediaStream`

Section: [§ MediaStream](https://www.w3.org/TR/mediacapture-streams/#mediastream)

| Anchor | Member | Status | Notes |
|---|---|---|---|
| `mediastream-constructor` | `new MediaStream()` / `new MediaStream(stream)` / `new MediaStream(tracks)` | **Implemented** | Pure JS-side construction; a JS-only MediaStream has no `_native` handle and therefore cannot be passed to `<Video srcObject>` until/unless its tracks come from `getUserMedia` (then we resolve the session via the first video track's source). See [LLP 0003#stream-construction](./0003-mediastream.spec.md#stream-construction). |
| `mediastream-id` | `id` | **Implemented** | UUIDv4 (36 characters, allowed character set per the spec). Generated natively for `getUserMedia` streams and in JS for script-constructed streams. |
| `mediastream-active` | `active` | **Implemented** | True iff at least one track is `live`. Computed JS-side over `#tracks`. |
| `mediastream-gettracks` | `getTracks()` | **Implemented** | |
| `mediastream-getvideotracks` | `getVideoTracks()` | **Implemented** | |
| `mediastream-getaudiotracks` | `getAudioTracks()` | **Implemented** | Always returns `[]` in v1. |
| `mediastream-gettrackbyid` | `getTrackById(id)` | **Implemented** | |
| `mediastream-addtrack` | `addTrack(track)` | **Implemented** | Add to the track set if not already present. Script-initiated; per spec no `addtrack` event fires. |
| `mediastream-removetrack` | `removeTrack(track)` | **Implemented** | Remove from the track set if present. Script-initiated; per spec no `removetrack` event fires. |
| `mediastream-clone` | `clone()` | **Implemented** | New `id`, plus a `MediaStreamTrack.clone()` for each track. |
| `mediastream-events` | `onaddtrack` / `onremovetrack` | **Stubbed** | Handler attributes exist for IDL conformance and addEventListener works, but we never fire them — `addTrack`/`removeTrack` are always script-initiated in v1, and the spec says script-initiated adds/removes do **not** fire these events. |

See [LLP 0003](./0003-mediastream.spec.md).

## `MediaStreamTrack`

Section: [§ MediaStreamTrack](https://www.w3.org/TR/mediacapture-streams/#mediastreamtrack)

| Anchor | Member | Status | Notes |
|---|---|---|---|
| `mediastreamtrack-id` | `id` | **Implemented** | |
| `mediastreamtrack-kind` | `kind` | **Implemented** | Always `"video"` in v1. |
| `mediastreamtrack-label` | `label` | **Implemented** | `AVCaptureDevice.localizedName`; set at construction, never changes (per [LLP 0008#dom-mediastreamtrack-label](./0008-w3c-spec-text.spec.md#attribute-label-dom-mediastreamtrack-label)). |
| `mediastreamtrack-enabled` | `enabled` (get/set) | **Implemented** | Set toggles whether frames are forwarded (we flip the connection's `isEnabled`). |
| `mediastreamtrack-muted` | `muted` | **Implemented** | Mirrors AVCaptureSession interruption state (overheating, backgrounding, in-use-by-another-app). |
| `mediastreamtrack-readystate` | `readyState` | **Implemented** | `"live"` until `stop()`. |
| `mediastreamtrack-stop` | `stop()` | **Implemented** | Transitions to `"ended"`, fires `ended`. |
| `mediastreamtrack-clone` | `clone()` | **Implemented** | New `id`, new JS object; shares the underlying capture source. Stopping the original does not stop the clone (per spec). See [LLP 0003#track-clone](./0003-mediastream.spec.md#track-clone). |
| `mediastreamtrack-getcapabilities` | `getCapabilities()` | **Implemented** | Returns `{}` — spec allows an empty `MediaTrackCapabilities`. |
| `mediastreamtrack-getconstraints` | `getConstraints()` | **Implemented** | Returns the constraints passed to `getUserMedia`. |
| `mediastreamtrack-getsettings` | `getSettings()` | **Implemented** | `{ deviceId, groupId, facingMode, width, height, frameRate, aspectRatio }`. |
| `mediastreamtrack-applyconstraints` | `applyConstraints(constraints?)` | **Implemented (partial)** | Empty constraints `{}` resolves as a no-op; non-empty constraints reject with `OverconstrainedError` (we do not actually re-apply). Per spec, when `readyState == "ended"`, the promise resolves regardless of constraints. |
| `mediastreamtrack-events` | `mute` / `unmute` / `ended` events | **Implemented** | `mute`/`unmute` fire on AVCaptureSession interruption notifications. `ended` fires on `stop()` or a session runtime error. |

## `HTMLMediaElement.srcObject` integration

Section: [HTML living standard `srcObject`](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject) + [Media Capture § Implementation Suggestions](https://www.w3.org/TR/mediacapture-streams/#htmlmediaelement-extensions).

We don't really have an `HTMLMediaElement`; we have a React Native `<Video>` view that exposes a ref-attribute mirror of the spec surface.

| Anchor | Member | Status | Notes |
|---|---|---|---|
| `videoelement-srcObject` | `srcObject` getter/setter | **Implemented** | Either a prop or a property on the ref. |
| `videoelement-readyState` | `readyState` | **Implemented** | Transitions `HAVE_NOTHING → HAVE_ENOUGH_DATA` when the first frame is captured. |
| `videoelement-seekable` | `seekable.length === 0` | **Implemented** | Always empty. |
| `videoelement-seeking` | `seeking === false` | **Implemented** | Always false. |
| `videoelement-duration` | `duration` | **Implemented** | `NaN` until loaded; `Infinity` after, with `durationchange` event. |
| `videoelement-currentTime` | `currentTime` get / set | **Implemented** | Setter is a no-op (spec MUST). |
| `videoelement-playbackRate` | `playbackRate` get / set | **Implemented** | Always 1; setter is a no-op. |
| `videoelement-defaultPlaybackRate` | `defaultPlaybackRate` | **Implemented** | Always 1. |
| `videoelement-preload` | `preload` get / set | **Implemented** | Always `"none"`; setter is a no-op. |
| `videoelement-buffered` | `buffered.length === 0` | **Implemented** | Always empty. |
| `videoelement-ended` | `ended` | **Implemented** | Becomes true asynchronously after all tracks stop. |
| `videoelement-play` | `play()` | **Implemented** | Resolves; the AVCaptureSession is always running. |
| `videoelement-pause` | `pause()` | **Implemented** | Stops the session (resumable via `play()`). |
| `videoelement-events` | `loadeddata` / `durationchange` / `ended` / `play` / `pause` | **Implemented** | Via `addEventListener` and convenience setters `onloadeddata` etc. |

See [LLP 0004](./0004-htmlmediaelement-srcobject.spec.md).

## Errors

| Anchor | DOMException name | When |
|---|---|---|
| `error-NotAllowedError` | `NotAllowedError` | User denied the camera permission prompt. |
| `error-NotFoundError` | `NotFoundError` | No matching camera (e.g., front camera requested but none available). |
| `error-OverconstrainedError` | `OverconstrainedError` | A required constraint cannot be satisfied (e.g., `audio: { exact: true }`). |
| `error-NotSupportedError` | `NotSupportedError` | Operation is out of scope (e.g., `MediaStream.clone()`). |
| `error-TypeError` | `TypeError` | Constraints object is malformed or contains neither `audio` nor `video`. |

## Open questions

1. Should `getCapabilities()` return non-empty even in v1? Probably yes once we have real frame-rate enumeration; deferred.
2. Should `pause()` actually stop the AVCaptureSession or just the preview layer? Stopping the session releases the camera (and the indicator light), which is friendlier. We do that.
3. Should `applyConstraints()` actually re-pick a session preset / reconfigure the device? The current implementation is a no-op on empty input and rejects on non-empty input. Doing real reconfiguration would require a non-disruptive `session.beginConfiguration()` block on the session queue, which is doable but defer until a real consumer asks for it.
