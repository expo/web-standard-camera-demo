# LLP 0003: `getUserMedia` — iOS implementation

**Type:** Spec
**Status:** Active
**Systems:** standard-camera, ios
**Author:** James Ide
**Date:** 2026-05-19 (refactored 2026-05-21; audio added 2026-05-22)
**Related:** 0002, 0004, 0006, 0001, 0008

## Summary

This document covers how our local Expo module turns `navigator.mediaDevices.getUserMedia(constraints)` into an `AVCaptureSession` on iOS. The spec algorithm and IDL are in [LLP 0001#dom-mediadevices-getusermedia](./0001-w3c-spec-text.spec.md#method-getusermediaconstraints-dom-mediadevices-getusermedia); the in-scope/out-of-scope decision is in [LLP 0002](./0002-spec-subset-scope.spec.md). This LLP documents the *iOS-specific algorithm* that realizes the spec — the bits the spec doesn't describe because it can't (it doesn't know about AVFoundation).

Section anchors below are stable; code annotations cite them as `@ref LLP 0003#<anchor>`.

## Surface accepted from JS

The JS layer (`modules/standard-camera/src/MediaDevices.ts`) normalizes the spec-shaped constraints into a flat record before crossing the bridge:

```ts
interface FlatGetUserMediaConstraints {
  video?: {
    deviceId?: string;
    facingMode?: string;       // "user" | "environment"
    width?: number;
    height?: number;
    frameRate?: number;
    aspectRatio?: number;
  };
  audio?: {
    deviceId?: string;
    sampleRate?: number;
    sampleSize?: number;
    channelCount?: number;
    latency?: number;
    echoCancellation?: boolean;  // true / false / "all" / "remote-only" all collapse to a bool
    autoGainControl?: boolean;
    noiseSuppression?: boolean;
    voiceIsolation?: boolean;
  };
}
```

`ConstrainDOMString` / `ConstrainULong` / `ConstrainDouble` shapes collapse to single scalars: `{exact: 'user'}`, `{ideal: 'user'}`, and bare `'user'` all become `'user'`. We lose the exact-vs-ideal distinction at the bridge — see the open question on this.

For `echoCancellation` the spec allows `boolean` *or* the `"all"` / `"remote-only"` enum members ([LLP 0001#audio-properties](./0001-w3c-spec-text.spec.md#audio-properties)). We accept all four forms on JS, but the native side only distinguishes "on" vs "off" — see [LLP 0008#audio-session-configuration](./0008-audio-ios-mapping.decision.md#audio-session-configuration). The original value is preserved through `getSettings()` so `assert_equals(settings.echoCancellation, "all")` works.

## `gum-validate-constraints`

Done on the JS side, before the native bridge call. Rules:

1. `constraints` not an object → reject with `TypeError`.
2. Neither `video` nor `audio` truthy → reject with `TypeError` ("at least one of audio and video must be requested").
3. Normalize `video` and `audio` to the flat records above and forward.

All other failures surface from native.

## `gum-request-permission`

Done on iOS. Async; runs before any `AVCaptureSession` setup. Performed *for each requested media type* in the call:

1. For video: `AVCaptureDevice.authorizationStatus(for: .video)`; `.notDetermined` → `requestAccess(for: .video)`; `.denied` / `.restricted` / `false` → throw `NotAllowedError`.
2. For audio: same flow with `.audio`. Per spec the rejection covers the whole call — denying either denies both.

Permission state is per-app, persistent across launches. The prompts are the iOS system prompts driven by `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` in `app.json` → `Info.plist`. Audio device picking and session configuration live in [LLP 0008](./0008-audio-ios-mapping.decision.md).

## `gum-pick-device`

Done on iOS, on the main thread (`AVCaptureDevice.DiscoverySession` doesn't require a serial queue).

1. If `deviceId` is provided → look it up via `AVCaptureDevice(uniqueID:)`. Not found → `OverconstrainedError(constraint: "deviceId")`. (We treat `deviceId` as effectively exact since the spec doesn't have an ideal form for it that we honor.)
2. Otherwise, map `facingMode` to `AVCaptureDevice.Position`:
   - `"user"` → `.front`
   - `"environment"` → `.back`
   - missing → `.back` (project default)
3. Build an `AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: <position>)`. Return the first device.
4. If discovery is empty:
   - If `facingMode` was explicitly requested → throw `OverconstrainedError(constraint: "facingMode")`. (Bug fix 2026-05-21: previously we fell back to `AVCaptureDevice.default(for: .video)` here, silently violating the user's `facingMode` request — a back-camera fallback when the user asked for `'user'`.)
   - If no `facingMode` was specified → fall back to `AVCaptureDevice.default(for: .video)`. Still nothing → `NotFoundError`.

## `gum-build-session`

Done on iOS, on the dedicated session queue `dev.ide.standardcamera.session`. Single transaction:

1. `let session = AVCaptureSession()`
2. `session.beginConfiguration()`
3. Pick `sessionPreset` from the requested `width`/`height` (`pickPreset`): `≥1080` → `.hd1920x1080`, `≥720` → `.hd1280x720`, `≥480` → `.vga640x480`, else `.high`. `canSetSessionPreset` first.
4. `try AVCaptureDeviceInput(device:)`. On throw → `NotReadableError`.
5. `canAddInput / addInput`. Couldn't add → `NotReadableError`.
6. Add the hidden `FrameSink` (an `AVCaptureVideoDataOutput`) so frames are actively pulled and a delegate fires on the first sample. See [LLP 0006#first-frame-detection](./0006-ios-native-mapping.decision.md).
7. `session.commitConfiguration()`
8. Snapshot the device's active format (`activeFormat.formatDescription`) for `track.getSettings()`: `deviceId`, `groupId` (= deviceId in v1), `facingMode`, `width`, `height`, `frameRate`, `aspectRatio`.
9. Capture `frameSink.output.connection(with: .video)` as the track's `AVCaptureConnection` — this is what `track.enabled = false` toggles.
10. Return the `MediaStream`, then ask its `CaptureSource` to start the session on `MediaStream.sessionQueue` without awaiting `startRunning()`.

The atomic configuration matters: we add input and output in the *same* `beginConfiguration` / `commitConfiguration` block so the auto-created connection between them comes up in one step. We did this differently in an earlier revision and the connection was `nil` when the track was constructed.

`AVCaptureSession.startRunning()` is a blocking AVFoundation call. It must stay
off the main thread, but resolving `getUserMedia()` only after it completes also
means React cannot attach the `<Video>` preview layer until the session is
already hot. That made tab-return and front/back switch UI animations compete
with a main-thread preview attachment to a running capture graph. The current
shape returns the stream after the graph is configured, lets the preview attach
to a cold session, and coalesces `getUserMedia()`, `<Video srcObject>`, and
`play()` start requests through `CaptureSource.startSessionIfNeeded()`.

## `gum-error-mapping`

The thrown `Error.name` MUST match a spec-defined name ([LLP 0001#errors](./0001-w3c-spec-text.spec.md#errors)). Map:

| Native condition | DOMException `name` | When |
|---|---|---|
| Permission denied / restricted | `NotAllowedError` | `gum-request-permission` step 3 |
| `AVCaptureDevice(uniqueID:)` returned nil | `OverconstrainedError` (`.constraint = "deviceId"`) | `gum-pick-device` step 1 |
| Empty discovery + facingMode requested | `OverconstrainedError` (`.constraint = "facingMode"`) | `gum-pick-device` step 4 |
| Empty discovery + no facingMode + no default device | `NotFoundError` | `gum-pick-device` step 4 |
| `AVCaptureDeviceInput(device:)` threw | `NotReadableError` | `gum-build-session` step 4 |
| `canAddInput` returned false | `NotReadableError` | `gum-build-session` step 5 |
| JS-side normalizer rejected (neither audio nor video, malformed) | `TypeError` | `gum-validate-constraints` step 1–2 |

`OverconstrainedError` is constructed with the `.constraint` field encoded into the message as `"Constraint cannot be satisfied: <name>"`. The TS-side `rewrapNativeError` in `src/DOMException.ts` parses it back out and re-attaches it as a typed property — see [LLP 0001#error-overconstrainederror](./0001-w3c-spec-text.spec.md#overconstrainederror-error-overconstrainederror).

## Open questions

1. Should we expose an `AbortSignal` parameter? Spec does not require it for v1; defer.
2. ~~Should the simulator's synthetic camera count as a real device?~~ Resolved (2026-05-20): iOS 26 simulator on current Xcode has **no** `AVCaptureDevice`; `getUserMedia` always rejects with `NotFoundError` there. See [LLP 0010](./0010-in-app-wpt-runner.guide.md).
3. Should we preserve the `exact` / `ideal` distinction across the bridge? Today the JS normalizer collapses both into a flat scalar, so `gum-pick-device` treats every `facingMode` as effectively exact (throws `OverconstrainedError` if no match). For `facingMode: {ideal: 'user'}` the spec would allow falling back to a back camera; we don't. Pragmatically fine for video-only v1 but a real divergence worth restoring when we revisit constraints (would require a `*-exact` boolean per field in `FlatGetUserMediaConstraints`).
