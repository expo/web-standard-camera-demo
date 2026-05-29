# LLP 0002: Spec subset scope

**Type:** Spec
**Status:** Active
**Systems:** standard-camera
**Author:** James Ide
**Date:** 2026-05-19 (audio brought into scope 2026-05-22; `resizeMode: "crop-and-scale"` brought into scope 2026-05-26)
**Related:** 0000, 0003, 0004, 0005, 0001, 0008, 0013, 0014

## Summary

This document is the index of which clauses of [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) (Editor's Draft) and the [HTML `srcObject` section](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject) we implement, stub, or omit.

- **[LLP 0001](./0001-w3c-spec-text.spec.md)** holds the spec text itself, with each member at the matching W3C anchor (e.g. `dom-mediastreamtrack-stop`). Code annotations that exist *because of* a spec clause should cite that anchor: `@ref LLP 0001#<anchor>`.
- **This LLP (0001)** and the per-interface notes (0002–0004) record our *scope decisions* — which clauses are in vs. out, and the iOS-specific implementation paths through them.

The scope covers `navigator.mediaDevices.getUserMedia({ video: true })`, `getUserMedia({ audio: true })`, and the combined `getUserMedia({ audio: true, video: true })` resolving to a `MediaStream` whose video track displays in a `<Video srcObject={stream} />` while the audio track is fed through the iOS audio output.

Media Capture depth tracks are out of scope. The discontinued W3C Media Capture
Depth Stream Extensions draft proposed depth streams and a `videoKind: "depth"`
constrainable property, but this repo does not add those members to
`navigator.mediaDevices`, `MediaStream`, or `MediaStreamTrack`. That is an
intentional standards-positioning decision, not just an implementation deferral:
native LiDAR depth can demonstrate web-shaped rendering beside `getUserMedia`,
but it should remain an explicit native extension unless/until a live web
standard defines depth semantics. See [LLP 0013](./0013-lidar-webgpu-depth-demo.plan.md).

WebXR depth sensing is also out of scope for this package's Media Capture
surface. It is the better active standards model for AR depth, but it requires
an XR session/runtime surface rather than an extension of this repo's
`navigator.mediaDevices` subset. [LLP 0014](./0014-webxr-lidar-depth-api.spec.md)
specifies and tracks the separate research implementation used by the WebXR
LiDAR demo route.

### Audio is in scope (as of 2026-05-22)

`getUserMedia({ audio: <truthy> })` resolves to a `MediaStream` containing exactly one `MediaStreamTrack` whose `kind === "audio"`. Audio devices are surfaced via `enumerateDevices()` once the caller has been granted microphone access. Audio track `getSettings()` reports `sampleRate`, `sampleSize`, `echoCancellation`, `autoGainControl`, `noiseSuppression`, `voiceIsolation`, `latency`, `channelCount`, `deviceId`, `groupId`. `getCapabilities()` reports the matching capability ranges / enums. iOS implementation details — `AVCaptureDevice(for: .audio)`, `AVAudioSession` configuration, `AVCaptureAudioDataOutput` as the audio FrameSink, echo-cancellation via `setMode(.voiceChat)` — are documented in [LLP 0008](./0008-audio-ios-mapping.decision.md).

`getUserMedia({ audio: true, video: true })` returns a `MediaStream` containing one video track and one audio track sharing a single `AVCaptureSession`. Stopping either track is independent of the other; the session is stopped when both tracks (across any clones) have ended.

### `resizeMode: "crop-and-scale"` is in scope (as of 2026-05-26)

Video tracks support both spec values of `resizeMode`: `"none"` (the default — frames pass through at the device's native dimensions) and `"crop-and-scale"`, which picks the closest natively-supported `AVCaptureDevice.Format` and center-crops + bilinear-rescales it in `FrameSink`'s sample-buffer callback to satisfy explicit `width` / `height` constraints. Without this, `getUserMedia({ video: { width: { ideal: 320 } } })` can't be satisfied on iPhone cameras whose smallest native format is wider than the request, which is why the WPT `GUM-required-constraint-with-ideal-value` test and the `MediaStreamTrack-getCapabilities` `Value: crop-and-scale` sub-tests were marked out-of-scope in the per-name overrides; with `crop-and-scale` in scope they become applicable again.

`getCapabilities()` reports `resizeMode: ["none", "crop-and-scale"]` for both the video track and the matching `InputDeviceInfo` entry; `getSettings().resizeMode` reflects whichever mode the session ended up in (chosen from `MediaTrackConstraints.resizeMode` and the closest-format selection). The cropped/scaled `CVPixelBuffer` is what `__getLatestFrame()` returns and what the `AVCaptureVideoPreviewLayer` renders, so on-screen and WebGPU consumers see identical pixels.

`"none"` remains the default when constraints don't request a specific dimension; the existing behaviour is unchanged for callers that don't opt in.

## Status legend

- **Implemented** — fully implemented and validated by a ported WPT test
- **Implemented (no test)** — implemented but no WPT test ported yet
- **Stubbed** — present on the JS surface but throws / returns a no-op value
- **Out of scope** — not present at all in v1

## `navigator.mediaDevices` — `MediaDevices` interface

Section: [§ MediaDevices](https://www.w3.org/TR/mediacapture-streams/#mediadevices)

| Anchor | Member | Status | Notes |
|---|---|---|---|
| <a id="mediadevices-getusermedia"></a>`mediadevices-getusermedia` | `getUserMedia(constraints)` | **Implemented** | Video + audio + combined audio/video; see [LLP 0003](./0003-getusermedia.spec.md) and [LLP 0008](./0008-audio-ios-mapping.decision.md). |
| <a id="mediadevices-enumeratedevices"></a>`mediadevices-enumeratedevices` | `enumerateDevices()` | **Implemented** | Returns every built-in camera and the default microphone as separate `MediaDeviceInfo` / `InputDeviceInfo` entries. `deviceId` / `label` / `groupId` are gated until the matching kind has been granted via `getUserMedia()`. |
| <a id="mediadevices-getsupportedconstraints"></a>`mediadevices-getsupportedconstraints` | `getSupportedConstraints()` | **Implemented** | Returns every recognized video + audio constraint name from the spec. |
| <a id="mediadevices-ondevicechange"></a>`mediadevices-ondevicechange` | `ondevicechange` / `devicechange` event | **Out of scope** | We never fire it. |
| <a id="mediadevices-getdisplaymedia"></a>`mediadevices-getdisplaymedia` | `getDisplayMedia()` | **Out of scope** | — |

## `MediaStream`

Section: [§ MediaStream](https://www.w3.org/TR/mediacapture-streams/#mediastream)

| Anchor | Member | Status | Notes |
|---|---|---|---|
| <a id="mediastream-constructor"></a>`mediastream-constructor` | `new MediaStream()` / `new MediaStream(stream)` / `new MediaStream(tracks)` | **Implemented** | Pure JS-side construction; a JS-only MediaStream has no `_native` handle and therefore cannot be passed to `<Video srcObject>` until/unless its tracks come from `getUserMedia` (then we resolve the session via the first video track's source). See [LLP 0004#stream-construction](./0004-mediastream.spec.md#stream-construction). |
| <a id="mediastream-id"></a>`mediastream-id` | `id` | **Implemented** | UUIDv4 (36 characters, allowed character set per the spec). Generated natively for `getUserMedia` streams and in JS for script-constructed streams. |
| <a id="mediastream-active"></a>`mediastream-active` | `active` | **Implemented** | True iff at least one track is `live`. Computed JS-side over `#tracks`. |
| <a id="mediastream-gettracks"></a>`mediastream-gettracks` | `getTracks()` | **Implemented** | |
| <a id="mediastream-getvideotracks"></a>`mediastream-getvideotracks` | `getVideoTracks()` | **Implemented** | |
| <a id="mediastream-getaudiotracks"></a>`mediastream-getaudiotracks` | `getAudioTracks()` | **Implemented** | Returns the audio tracks in the stream. |
| <a id="mediastream-gettrackbyid"></a>`mediastream-gettrackbyid` | `getTrackById(id)` | **Implemented** | |
| <a id="mediastream-addtrack"></a>`mediastream-addtrack` | `addTrack(track)` | **Implemented** | Add to the track set if not already present. Script-initiated; per spec no `addtrack` event fires. |
| <a id="mediastream-removetrack"></a>`mediastream-removetrack` | `removeTrack(track)` | **Implemented** | Remove from the track set if present. Script-initiated; per spec no `removetrack` event fires. |
| <a id="mediastream-clone"></a>`mediastream-clone` | `clone()` | **Implemented** | New `id`, plus a `MediaStreamTrack.clone()` for each track. |
| <a id="mediastream-events"></a>`mediastream-events` | `onaddtrack` / `onremovetrack` | **Stubbed** | Handler attributes exist for IDL conformance and addEventListener works, but we never fire them — `addTrack`/`removeTrack` are always script-initiated in v1, and the spec says script-initiated adds/removes do **not** fire these events. |

See [LLP 0004](./0004-mediastream.spec.md).

## `MediaStreamTrack`

Section: [§ MediaStreamTrack](https://www.w3.org/TR/mediacapture-streams/#mediastreamtrack)

| Anchor | Member | Status | Notes |
|---|---|---|---|
| <a id="mediastreamtrack-id"></a>`mediastreamtrack-id` | `id` | **Implemented** | |
| <a id="mediastreamtrack-kind"></a>`mediastreamtrack-kind` | `kind` | **Implemented** | `"video"` for camera tracks; `"audio"` for microphone tracks. |
| <a id="mediastreamtrack-label"></a>`mediastreamtrack-label` | `label` | **Implemented** | `AVCaptureDevice.localizedName`; set at construction, never changes (per [LLP 0001#dom-mediastreamtrack-label](./0001-w3c-spec-text.spec.md#attribute-label-dom-mediastreamtrack-label)). |
| <a id="mediastreamtrack-enabled"></a>`mediastreamtrack-enabled` | `enabled` (get/set) | **Implemented** | Set toggles whether frames / audio samples are forwarded (we flip the connection's `isEnabled`). |
| <a id="mediastreamtrack-muted"></a>`mediastreamtrack-muted` | `muted` | **Implemented** | Mirrors AVCaptureSession interruption state (overheating, backgrounding, in-use-by-another-app, audio-session interruption). |
| <a id="mediastreamtrack-readystate"></a>`mediastreamtrack-readystate` | `readyState` | **Implemented** | `"live"` until `stop()`. |
| <a id="mediastreamtrack-stop"></a>`mediastreamtrack-stop` | `stop()` | **Implemented** | Transitions to `"ended"` synchronously; per spec it does **not** fire the public `ended` event. |
| <a id="mediastreamtrack-clone"></a>`mediastreamtrack-clone` | `clone()` | **Implemented** | New `id`, new JS object; shares the underlying capture source. Stopping the original does not stop the clone (per spec). See [LLP 0004#track-clone](./0004-mediastream.spec.md#track-clone). |
| <a id="mediastreamtrack-getcapabilities"></a>`mediastreamtrack-getcapabilities` | `getCapabilities()` | **Implemented** | Returns video capabilities (`width`/`height`/`aspectRatio`/`frameRate`/`facingMode`/`resizeMode`/`deviceId`/`groupId`) for video tracks; audio capabilities (`sampleRate`/`sampleSize`/`echoCancellation`/`autoGainControl`/`noiseSuppression`/`voiceIsolation`/`latency`/`channelCount`/`deviceId`/`groupId`) for audio tracks. |
| <a id="mediastreamtrack-getconstraints"></a>`mediastreamtrack-getconstraints` | `getConstraints()` | **Implemented** | Returns the constraints passed to `getUserMedia`. |
| <a id="mediastreamtrack-getsettings"></a>`mediastreamtrack-getsettings` | `getSettings()` | **Implemented** | Video: `{ deviceId, groupId, facingMode, width, height, frameRate, aspectRatio, resizeMode }`. Audio: `{ deviceId, groupId, sampleRate, sampleSize, echoCancellation, autoGainControl, noiseSuppression, voiceIsolation, latency, channelCount }`. |
| <a id="mediastreamtrack-applyconstraints"></a>`mediastreamtrack-applyconstraints` | `applyConstraints(constraints?)` | **Implemented (partial)** | Empty constraints `{}` resolves as a no-op; non-empty constraints reject with `OverconstrainedError` (we do not actually re-apply). Per spec, when `readyState == "ended"`, the promise resolves regardless of constraints. |
| <a id="mediastreamtrack-events"></a>`mediastreamtrack-events` | `mute` / `unmute` / `ended` events | **Implemented** | `mute`/`unmute` fire on AVCaptureSession / AVAudioSession interruption notifications. `ended` fires on non-`stop()` source endings such as a session runtime error. |

## `HTMLMediaElement.srcObject` integration

Section: [HTML living standard `srcObject`](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject) + [Media Capture § Implementation Suggestions](https://www.w3.org/TR/mediacapture-streams/#htmlmediaelement-extensions).

We don't really have an `HTMLMediaElement`; we have a React Native `<Video>` view that exposes a ref-attribute mirror of the spec surface.

| Anchor | Member | Status | Notes |
|---|---|---|---|
| `videoelement-srcObject` | `srcObject` getter/setter | **Implemented** | Either a prop or a property on the ref. |
| `videoelement-readyState` | `readyState` | **Implemented** | Transitions `HAVE_NOTHING → HAVE_ENOUGH_DATA` when the first frame is captured. |
| <a id="videoelement-seekable"></a>`videoelement-seekable` | `seekable.length === 0` | **Implemented** | Always empty. |
| <a id="videoelement-seeking"></a>`videoelement-seeking` | `seeking === false` | **Implemented** | Always false. |
| <a id="videoelement-duration"></a>`videoelement-duration` | `duration` | **Implemented** | `NaN` until loaded; `Infinity` after, with `durationchange` event. |
| `videoelement-currentTime` | `currentTime` get / set | **Implemented** | Setter is a no-op (spec MUST). |
| `videoelement-playbackRate` | `playbackRate` get / set | **Implemented** | Always 1; setter is a no-op. |
| `videoelement-defaultPlaybackRate` | `defaultPlaybackRate` | **Implemented** | Always 1. |
| <a id="videoelement-preload"></a>`videoelement-preload` | `preload` get / set | **Implemented** | Always `"none"`; setter is a no-op. |
| <a id="videoelement-buffered"></a>`videoelement-buffered` | `buffered.length === 0` | **Implemented** | Always empty. |
| <a id="videoelement-ended"></a>`videoelement-ended` | `ended` | **Implemented** | Becomes true asynchronously after all tracks stop. |
| <a id="videoelement-play"></a>`videoelement-play` | `play()` | **Implemented** | Resolves; the AVCaptureSession is always running. |
| <a id="videoelement-pause"></a>`videoelement-pause` | `pause()` | **Implemented** | Stops the session (resumable via `play()`). |
| <a id="videoelement-events"></a>`videoelement-events` | `loadeddata` / `durationchange` / `ended` / `play` / `pause` | **Implemented** | Via `addEventListener` and convenience setters `onloadeddata` etc. |

See [LLP 0005](./0005-htmlmediaelement-srcobject.spec.md).

## Errors

| Anchor | DOMException name | When |
|---|---|---|
| `error-NotAllowedError` | `NotAllowedError` | User denied the camera or microphone permission prompt. |
| `error-NotFoundError` | `NotFoundError` | No matching camera or microphone (e.g., front camera requested but none available, or no audio input device on the host). |
| `error-OverconstrainedError` | `OverconstrainedError` | A required constraint cannot be satisfied (e.g., a `sampleRate: { exact: 999999 }` that no device delivers). |
| `error-NotSupportedError` | `NotSupportedError` | Operation is out of scope (e.g., `getDisplayMedia()`). |
| `error-TypeError` | `TypeError` | Constraints object is malformed or contains neither `audio` nor `video`. |

## Open questions

1. Should `getCapabilities()` return non-empty even in v1? Probably yes once we have real frame-rate enumeration; deferred.
2. Should `pause()` actually stop the AVCaptureSession or just the preview layer? Stopping the session releases the camera (and the indicator light), which is friendlier. We do that.
3. Should `applyConstraints()` actually re-pick a session preset / reconfigure the device? The current implementation is a no-op on empty input and rejects on non-empty input. Doing real reconfiguration would require a non-disruptive `session.beginConfiguration()` block on the session queue, which is doable but defer until a real consumer asks for it.
