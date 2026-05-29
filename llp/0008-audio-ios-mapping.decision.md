# LLP 0008: Audio capture — iOS implementation

**Type:** Decision
**Status:** Active
**Systems:** standard-camera, ios
**Author:** James Ide
**Date:** 2026-05-22
**Related:** 0002, 0003, 0004, 0006, 0001

## Summary

This LLP documents how our local Expo module turns `navigator.mediaDevices.getUserMedia({ audio: <truthy> })` into an `AVCaptureSession` + `AVAudioSession` configuration on iOS, and how a combined `getUserMedia({ audio: true, video: true })` call yields a single `MediaStream` containing one audio and one video track sharing one session.

Section anchors below are stable; code annotations cite them as `@ref LLP 0008#<anchor>`. The spec text for the constrainable audio surface lives in [LLP 0001](./0001-w3c-spec-text.spec.md); the scope decision is in [LLP 0002](./0002-spec-subset-scope.spec.md).

## Why a single session for combined audio/video

`AVCaptureSession` accepts both an audio `AVCaptureDeviceInput` and a video `AVCaptureDeviceInput` in the same configuration block. Using a single session for the combined case has three benefits:

1. **Lifecycle is naturally shared.** Stopping the session releases both inputs; an interruption on the session covers both modalities.
2. **Notification fan-out reuses the existing observer plumbing.** `CaptureSource` already installs observers on the session and fans out to every track; the audio track just registers in the same set.
3. **The clone semantics from [LLP 0004#stream-clone](./0004-mediastream.spec.md#stream-clone) work unchanged.** Each track strong-refs the same `CaptureSource`; the live count covers both kinds.

The alternative — separate `AVAudioEngine` for audio and `AVCaptureSession` for video — would require duplicating interruption observers, would not let the session's runtime-error notification end the audio track, and would force a custom merge step in `MediaStream`. We accept the constraint that audio-only `getUserMedia` also opens an `AVCaptureSession` (with only an audio input and an `AVCaptureAudioDataOutput` sink) for symmetry.

## `audio-permission`

Done on iOS, before any `AVCaptureSession` setup.

1. `AVCaptureDevice.authorizationStatus(for: .audio)`.
2. If `.notDetermined` → `AVCaptureDevice.requestAccess(for: .audio)`; await the system prompt.
3. If the final status is `.denied`, `.restricted`, or the request returned `false` → throw `NotAllowedError`.

Permission state is per-app, persistent across launches. The prompt is driven by `NSMicrophoneUsageDescription` in `app.json` → `Info.plist`. When both audio and video are requested, we ask for both permissions; if either is denied we throw `NotAllowedError` (per spec the rejection covers the whole call).

## `audio-pick-device`

Done on iOS, on the main thread.

1. If `deviceId` is provided → look it up via `AVCaptureDevice(uniqueID:)`. Not found, or the device's `hasMediaType(.audio)` is false → `OverconstrainedError(constraint: "deviceId")`.
2. Otherwise if `groupId` is provided → resolve identically (in v1 a device's `deviceId` and `groupId` are the same string), but throw `OverconstrainedError(constraint: "groupId")` on mismatch so the WPT `groupId is correctly supported by getUserMedia()` test sees the right constraint name. Empty-string `groupId` is treated as unmatchable.
3. Otherwise return `AVCaptureDevice.default(for: .audio)`. The iOS audio capture API treats the system's currently-selected input route as the single audio device. We do not enumerate per-port (built-in vs. headset vs. bluetooth) — `enumerateDevices()` reports a single `audioinput` entry that resolves to whatever the route happens to be.
4. If `default(for: .audio)` is `nil` → throw `NotFoundError`.

iOS simulators sometimes hand back an empty string for the audio device's `uniqueID`. We substitute the stable synthetic id `"default-audio-input"` whenever we encounter an empty one — in both `enumerateDevices` and on the track's `getSettings()` — so the JS side sees a non-empty `deviceId` / `groupId` consistent with the spec (which requires a non-empty string once the kind has been granted).

## `audio-session-configuration`

`AVAudioSession` controls iOS's audio routing and processing chain. Configure it on the session queue before adding inputs:

1. `try AVAudioSession.sharedInstance().setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetooth])`. We use `.playAndRecord` (not `.record`) so any audio rendered by the app — including the `<Video>` element playing back the live capture — coexists with capture without ducking. `.defaultToSpeaker` routes playback through the loudspeaker by default rather than the earpiece; `.allowBluetooth` lets a paired BT headset replace the built-in mic.
2. `try AVAudioSession.sharedInstance().setMode(<mode>)`. Mode is derived from the requested `echoCancellation` constraint:
   - `echoCancellation: true | { exact: true } | { exact: "all" } | { exact: "remote-only" }` → `.voiceChat`. Voice-chat mode enables iOS's hardware echo cancellation and noise suppression.
   - `echoCancellation: false | { exact: false }` or omitted → `.default`. No processing applied.
3. `try AVAudioSession.sharedInstance().setActive(true, options: [])`. Activation must happen before `AVCaptureSession.startRunning()`.

These calls can throw; we map every `AVAudioSession`-originated error to `NotReadableError` (cf. [LLP 0003#gum-error-mapping](./0003-getusermedia.spec.md#gum-error-mapping)).

## `audio-build-session`

Done on the session queue. The audio input attaches to the *same* `AVCaptureSession` as the video input when both are requested, or to a session that holds only the audio side when video is absent.

1. Configure the audio session per `audio-session-configuration`.
2. Inside the same `beginConfiguration` / `commitConfiguration` block that owns the video input (if any):
   - `try AVCaptureDeviceInput(device: audioDevice)` → on throw, map to `NotReadableError`.
   - `session.canAddInput(audioInput) && session.addInput(audioInput)`.
   - Add an `AVCaptureAudioDataOutput` (`audioSink`); this is the audio analog of the video `FrameSink`. We don't need its frames for anything in v1, but attaching it forces samples to flow and gives us a connection to toggle for `track.enabled`.
3. After `commitConfiguration` + `startRunning`, snapshot:
   - `deviceId` = audio device's `uniqueID`.
   - `groupId` = same as `deviceId` in v1.
   - `sampleRate` = `AVAudioSession.sharedInstance().sampleRate` (the actual rate the route is delivering).
   - `sampleSize` = 16. We don't expose the underlying `AudioStreamBasicDescription.mBitsPerChannel`; the iOS audio chain delivers `Float32` PCM by default but the spec's `sampleSize` is a hint about the captured representation, and 16 matches Chrome/Safari on macOS.
   - `channelCount` = `AVAudioSession.sharedInstance().inputNumberOfChannels`.
   - `latency` = `AVAudioSession.sharedInstance().inputLatency`. Seconds, per the iOS docs and the spec.
   - `echoCancellation` round-trips the caller's original value verbatim: `true` / `false` come back as booleans, `"all"` / `"remote-only"` come back as the matching enum string. We split the value at the bridge (`echoCancellation: Bool?` + `echoCancellationMode: String?`) so the native `Record` stays typed; native then collapses both forms into a single `.voiceChat` vs `.default` mode decision, but reports back the original shape so WPT assertions like `assert_equals(settings.echoCancellation, "all")` and `assert_equals(settings.echoCancellation, true)` both pass.
   - `autoGainControl`, `noiseSuppression`, `voiceIsolation` = `true` iff mode is `.voiceChat`. iOS bundles AGC / NS / voice isolation under voice-chat mode; we report them in lockstep with the effective EC state.
4. Hand back the audio data output's connection (`audioSink.connection(with: .audio)`) as the track's `AVCaptureConnection` — `MediaStreamTrack.enabled = false` toggles this.

## `audio-track-settings`

The audio track's `getSettings()` returns:

```ts
{
  deviceId: string,                                  // AVCaptureDevice.uniqueID (or "default-audio-input" fallback)
  groupId: string,                                   // matches deviceId in v1
  sampleRate: number,                                // hz, e.g. 48000
  sampleSize: number,                                // bits per sample, 16 in v1
  echoCancellation: boolean | "all" | "remote-only", // round-trips the caller's request
  autoGainControl: boolean,
  noiseSuppression: boolean,
  voiceIsolation: boolean,
  latency: number,                                   // seconds
  channelCount: number,                              // typically 1 (mono mic) or 2 (stereo headset)
}
```

These properties are the entries in the constrainable audio set the spec mandates ([LLP 0001#audio-properties](./0001-w3c-spec-text.spec.md#audio-properties)).

## `audio-track-capabilities`

`getCapabilities()` for an audio track returns:

```ts
{
  sampleRate: { min: 8000, max: 96000 },     // iOS's supported AVAudioSession sample rates
  sampleSize: { min: 16, max: 16 },          // we report 16 only
  echoCancellation: [true, false],            // both supported via mode switching
  autoGainControl: [true, false],
  noiseSuppression: [true, false],
  voiceIsolation: [true, false],
  latency: { min: <currentInputLatency>, max: <currentInputLatency> },
  channelCount: { min: 1, max: <currentNumberOfChannels> },
  deviceId: "<uniqueID>",
  groupId: "<uniqueID>",
}
```

`sampleRate` reports `{min, max}` even though we can't reconfigure on the fly; the spec describes capabilities as the range the source *could* deliver, not what it *will* deliver. WPT's `MediaStreamTrack-getCapabilities.https.html` asserts each numeric capability is a `{ min, max }` object with `min <= max` and each boolean / string-enum capability is an array — we satisfy both.

## `audio-track-events`

The audio track shares the same `CaptureSource` notification fan-out as the video track:

- `AVCaptureSession.wasInterruptedNotification` → `muted = true`, fires `mute` on every track (audio and video).
- `AVCaptureSession.interruptionEndedNotification` → `muted = false`, fires `unmute`.
- `AVCaptureSession.runtimeErrorNotification` → end every track.

iOS additionally posts `AVAudioSession.interruptionNotification` (separate from `AVCaptureSession`) when a phone call or another app's audio session preempts ours. We translate this into the same `mute` / `unmute` path so audio tracks experience the same interruption semantics as video tracks. The handler lives on `CaptureSource` next to the `AVCaptureSession` observers.

## `audio-error-mapping`

| Native condition | DOMException `name` | When |
|---|---|---|
| Mic permission denied / restricted | `NotAllowedError` | `audio-permission` step 3 |
| `AVCaptureDevice.default(for: .audio)` returned nil | `NotFoundError` | `audio-pick-device` step 4 |
| `AVCaptureDevice(uniqueID:)` returned nil for an audio deviceId | `OverconstrainedError` (`.constraint = "deviceId"`) | `audio-pick-device` step 1 |
| `AVCaptureDevice(uniqueID:)` returned nil for an audio groupId | `OverconstrainedError` (`.constraint = "groupId"`) | `audio-pick-device` step 2 |
| `AVAudioSession.setCategory` / `setMode` / `setActive` threw | `NotReadableError` | `audio-session-configuration` |
| `AVCaptureDeviceInput(device:)` threw on audio device | `NotReadableError` | `audio-build-session` step 2 |
| `canAddInput` returned false for the audio input | `NotReadableError` | `audio-build-session` step 2 |

## Combined-call atomicity

When `getUserMedia({ audio: true, video: true })` is invoked:

1. Permissions are requested in the order video, then audio. If either denies, the entire call rejects with `NotAllowedError` and we tear down anything we'd already partially created (`AVAudioSession.setActive(false)`; we never started the `AVCaptureSession`).
2. The single `AVCaptureSession` is built with both inputs added in the same `beginConfiguration` / `commitConfiguration` block. This guarantees both connections come up atomically, matching the rationale in [LLP 0003#gum-build-session](./0003-getusermedia.spec.md#gum-build-session).
3. Two `MediaStreamTrack`s are created, both holding the same `CaptureSource`. The `CaptureSource`'s live-count starts at 2; stopping one track decrements but does not stop the session. Stopping both (across any clones) does.

## Open questions

1. iOS `setMode(.voiceChat)` also tries to route audio through the earpiece for the actual playback path (since voice-chat sessions typically include a downlink). We override with `.defaultToSpeaker`; verify on a real device that capture quality and routing both behave.
2. Should `applyConstraints({ echoCancellation: false })` reconfigure `AVAudioSession.mode` live? In v1 it rejects with `OverconstrainedError` (consistent with the video track's behavior). Reconfiguring `AVAudioSession.mode` mid-capture is supported by iOS but requires a brief deactivate/reactivate; defer.
3. The simulator delivers audio from the Mac host's default input. This means `bun run test:ios` *can* validate the audio path end-to-end, unlike video which has no simulator device (see [LLP 0010](./0010-in-app-wpt-runner.guide.md)). Combined `audio + video` tests still skip on the simulator because the video side fails to find a device.
