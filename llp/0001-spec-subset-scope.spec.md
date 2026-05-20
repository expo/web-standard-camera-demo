# LLP 0001: Spec subset scope

**Type:** Spec
**Status:** Active
**Systems:** standard-camera
**Author:** James Ide
**Date:** 2026-05-19
**Related:** 0000, 0002, 0003, 0004

## Summary

This document is the index of which clauses of [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) (Editor's Draft) and the [HTML `srcObject` section](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject) we implement, stub, or omit. Every line in our implementation that exists because of a spec clause should `@ref` an anchor in this document or in one of the per-interface spec LLPs (0002–0004).

The scope is intentionally tiny: enough to let `navigator.mediaDevices.getUserMedia({ video: true })` resolve to a `MediaStream` whose video track displays in a `<Video srcObject={stream} />`.

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
| `mediastream-constructor` | `new MediaStream()` / `new MediaStream(stream)` / `new MediaStream(tracks)` | **Out of scope** | We construct streams only via `getUserMedia()`. Calling the constructor throws `NotSupportedError`. |
| `mediastream-id` | `id` | **Implemented** | UUIDv4 from native. |
| `mediastream-active` | `active` | **Implemented** | True iff at least one track is `live`. |
| `mediastream-gettracks` | `getTracks()` | **Implemented** | |
| `mediastream-getvideotracks` | `getVideoTracks()` | **Implemented** | |
| `mediastream-getaudiotracks` | `getAudioTracks()` | **Implemented** | Always returns `[]`. |
| `mediastream-gettrackbyid` | `getTrackById(id)` | **Implemented** | |
| `mediastream-addtrack` | `addTrack(track)` | **Out of scope** | Throws. |
| `mediastream-removetrack` | `removeTrack(track)` | **Out of scope** | Throws. |
| `mediastream-clone` | `clone()` | **Stubbed** | Throws `NotSupportedError`. |
| `mediastream-events` | `onaddtrack` / `onremovetrack` | **Out of scope** | We never fire them. |

See [LLP 0003](./0003-mediastream.spec.md).

## `MediaStreamTrack`

Section: [§ MediaStreamTrack](https://www.w3.org/TR/mediacapture-streams/#mediastreamtrack)

| Anchor | Member | Status | Notes |
|---|---|---|---|
| `mediastreamtrack-id` | `id` | **Implemented** | |
| `mediastreamtrack-kind` | `kind` | **Implemented** | Always `"video"` in v1. |
| `mediastreamtrack-label` | `label` | **Implemented** | `AVCaptureDevice.localizedName`. |
| `mediastreamtrack-enabled` | `enabled` (get/set) | **Implemented** | Set toggles whether frames are forwarded (we flip the connection's `isEnabled`). |
| `mediastreamtrack-muted` | `muted` | **Implemented** | Always `false` in v1. |
| `mediastreamtrack-readystate` | `readyState` | **Implemented** | `"live"` until `stop()`. |
| `mediastreamtrack-stop` | `stop()` | **Implemented** | Transitions to `"ended"`, fires `ended`. |
| `mediastreamtrack-clone` | `clone()` | **Out of scope** | Throws. |
| `mediastreamtrack-getcapabilities` | `getCapabilities()` | **Out of scope** | Returns `{}`. |
| `mediastreamtrack-getconstraints` | `getConstraints()` | **Implemented** | Returns the constraints passed to `getUserMedia`. |
| `mediastreamtrack-getsettings` | `getSettings()` | **Implemented** | `{ deviceId, groupId, facingMode, width, height, frameRate, aspectRatio }`. |
| `mediastreamtrack-applyconstraints` | `applyConstraints()` | **Out of scope** | Rejects. |
| `mediastreamtrack-events` | `mute` / `unmute` / `ended` events | **`ended` implemented** | `mute`/`unmute` never fire in v1. |

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
