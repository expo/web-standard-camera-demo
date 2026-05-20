# LLP 0002: `getUserMedia` subset

**Type:** Spec
**Status:** Active
**Systems:** standard-camera
**Author:** James Ide
**Date:** 2026-05-19
**Related:** 0001, 0003

## Summary

This document describes the subset of `MediaDevices.getUserMedia()` ([W3C § 5.2](https://www.w3.org/TR/mediacapture-streams/#dom-mediadevices-getusermedia)) we implement. The spec's algorithm is long; we implement the iOS-relevant happy path plus a small set of error cases.

## Signature

```ts
getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
```

Where `MediaStreamConstraints` is the subset:

```ts
interface MediaStreamConstraints {
  video?: boolean | MediaTrackConstraints;
  audio?: boolean | MediaTrackConstraints;  // accepted but ignored
}

interface MediaTrackConstraints {
  deviceId?: ConstrainDOMString;
  facingMode?: ConstrainDOMString;  // "user" | "environment"
  width?: ConstrainULong;
  height?: ConstrainULong;
  frameRate?: ConstrainDouble;
  aspectRatio?: ConstrainDouble;
}
```

## Algorithm (subset)

### `gum-validate-constraints` — Validate `constraints`

1. If `constraints` is not an object, **reject** with `TypeError`.
2. If neither `constraints.video` nor `constraints.audio` is truthy, **reject** with `TypeError` (matches spec: "at least one of video and audio must be requested").
3. If `constraints.audio` is `{ exact: true }` or otherwise hard-required, **reject** with `OverconstrainedError(constraint: "audio")` — we have no audio.
4. Otherwise, set `constraints.audio = false` silently (we accept the request for video; audio is just ignored).

### `gum-request-permission` — Request authorization

1. Call `AVCaptureDevice.authorizationStatus(for: .video)`.
2. If `.notDetermined`, call `AVCaptureDevice.requestAccess(for: .video)` and await the result.
3. If the final status is `.denied` or `.restricted`, **reject** with `NotAllowedError`.

### `gum-pick-device` — Resolve a device from constraints

1. If `constraints.video.deviceId.exact` is set, look up that device. If not found, **reject** with `OverconstrainedError(constraint: "deviceId")`.
2. Else if `constraints.video.facingMode.exact === "user"`, prefer `.builtInWideAngleCamera` on the front.
3. Else if `constraints.video.facingMode.exact === "environment"`, prefer back.
4. Else default to the back wide-angle camera.
5. If no device matches, **reject** with `NotFoundError`.

### `gum-build-session` — Build the capture session

1. On the dedicated serial queue (`dev.ide.standardcamera.session`):
   - `session.beginConfiguration()`
   - Attempt to add an `AVCaptureDeviceInput` for the chosen device. On failure, **reject** with `NotReadableError` (which we surface as a `DOMException` of that name).
   - Resolve a resolution preset from `width` × `height` if hinted; else default to `.high`.
   - `session.commitConfiguration()`
   - `session.startRunning()`
2. Construct a `MediaStreamTrack` whose `id` is a UUIDv4, `kind: "video"`, `label: device.localizedName`, `readyState: "live"`.
3. Construct a `MediaStream` with `id` = UUIDv4 and a single track. Resolve the promise with it.

### `gum-error-mapping` — Native error → DOMException name

| Native condition | DOMException name |
|---|---|
| User denied / restricted | `NotAllowedError` |
| No matching device | `NotFoundError` |
| Required constraint unsatisfiable | `OverconstrainedError` (with `.constraint`) |
| `AVCaptureDeviceInput(device:)` throws | `NotReadableError` |
| Malformed constraints object | `TypeError` |

The thrown JS error must have a string `.name` matching one of the above, per [§ 9 Errors](https://www.w3.org/TR/mediacapture-streams/#methods-2).

## Open questions

1. Should we expose an `AbortSignal` parameter? Spec does not require it; defer.
2. Should the simulator's synthetic camera (`xcrun simctl` test pattern) count as a real device? Yes — `AVCaptureDevice.default(for: .video)` returns it on the simulator, which lets the WPT runner verify the happy path.
