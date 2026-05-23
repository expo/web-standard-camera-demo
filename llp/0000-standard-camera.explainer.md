# LLP 0000: standard-camera-app

**Type:** Explainer
**Status:** Active
**Systems:** standard-camera, demo-app
**Role:** Root
**Author:** James Ide
**Date:** 2026-05-19 (audio added 2026-05-22)
**Related:** 0001, 0005, 0006, 0007, 0009

## Summary

`standard-camera-app` is a demo Expo SDK 56 app plus a local Expo module (`standard-camera`) that implements a small, deliberately spec-shaped subset of the W3C "Media Capture and Streams" specification on iOS. The goal is that a developer can write `navigator.mediaDevices.getUserMedia({ video: true }).then(stream => video.srcObject = stream)` — the exact code they would write in a browser — and see the live camera preview on iOS, with as few RN-specific concessions as possible.

This is a learning exercise more than a production library. The hypothesis being tested is: "If a popular browser API is small enough and well-shaped, we can port it 1:1 to React Native and let DOM-first code run." Camera capture via `getUserMedia` and `<video srcObject>` is small enough.

## What is in scope

- iOS only (Swift, AVFoundation)
- Camera (video) and microphone (audio) capture — `getUserMedia({ video: true })`, `getUserMedia({ audio: true })`, and `getUserMedia({ audio: true, video: true })`
- The `navigator.mediaDevices.getUserMedia()` entry point, polyfilled onto `globalThis.navigator`
- The `MediaStream` and `MediaStreamTrack` interfaces (the subset listed in LLP 0003)
- A `<Video>` component that mirrors `HTMLMediaElement` closely enough that the assignment `videoRef.srcObject = stream` works, plus the `srcObject`-related invariants from the spec (LLP 0004)
- An in-app testharness-compatible runner that executes a port of relevant `web-platform-tests` against the real iOS implementation (LLP 0007)

## What is out of scope (for v1)

- Android (call it out in the module manifest; no Kotlin)
- `getDisplayMedia`, `MediaRecorder`
- Web platform output of the module
- Permissions UI beyond the native iOS prompts (driven by `NSCameraUsageDescription` + `NSMicrophoneUsageDescription`)

The complete list of what's in vs out, clause-by-clause, lives in [LLP 0001](./0001-spec-subset-scope.spec.md).

## High-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Demo app (Expo SDK 56, Hermes V1)                           │
│                                                             │
│  src/app/_layout.tsx   installs navigator.mediaDevices     │
│  src/app/index.tsx     demo: camera in <Video>             │
│  src/app/run-tests.tsx in-app WPT-style test runner        │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ modules/standard-camera/  (local Expo module)               │
│                                                             │
│  TypeScript (src/)                                          │
│   install.ts              navigator.mediaDevices polyfill   │
│   MediaDevices.ts         getUserMedia() + singleton        │
│   MediaStream.ts          MediaStream class                 │
│   MediaStreamTrack.ts     MediaStreamTrack class            │
│   HTMLVideoElement.tsx    <Video> + ref-attribute mirror    │
│                                                             │
│  Swift (ios/)                                               │
│   StandardCameraModule.swift  module definition             │
│   MediaDevices.swift          AVCaptureDevice/Session        │
│   MediaStream.swift           SharedRef<AVCaptureSession>    │
│   MediaStreamTrack.swift      per-track metadata             │
│   VideoView.swift             ExpoView w/ preview layer      │
└─────────────────────────────────────────────────────────────┘
```

The bridge between JS `MediaStream` and Swift `AVCaptureSession` uses Expo Modules Core's SharedObject pattern (`SharedRef<AVCaptureSession>`). JS gets back an opaque native-backed handle from `getUserMedia()`; when the handle is passed as `srcObject` to a `<Video>`, the native view extracts the underlying `AVCaptureSession` and feeds it into an `AVCaptureVideoPreviewLayer`. This is the same shape `expo-video` uses for its `VideoPlayer` shared object.

See [LLP 0005](./0005-ios-native-mapping.decision.md) for the details of the iOS mapping.

## Key constraints and invariants

1. **Spec compliance trumps ergonomics.** When a spec clause is implemented, we follow it. If we can't (because RN lacks the underlying primitive), we document the divergence in LLP 0001 with a `notes:` field rather than papering over it.
2. **Global polyfill, not module import.** We install `globalThis.navigator.mediaDevices` so that copy-pasted browser code runs unchanged. The trade-off is that other modules can collide with the global; we accept that risk because the value of "DOM code just works" is the whole point of the project. See [LLP 0006](./0006-navigator-polyfill.decision.md).
3. **`@ref` everywhere it matters.** Any line that exists because the spec says so gets an `@ref LLP NNNN#anchor` comment so a future agent can trace it back. Validated with `ref-check`.
4. **Tests are the source of truth.** The in-app WPT runner is what proves we're spec-compliant. If a WPT case can be ported, it should be. See [LLP 0007](./0007-in-app-wpt-runner.guide.md).
5. **One direction at a time.** Add Android, recording, etc. only after the iOS capture happy path is locked down and green under tests. (Audio was the first "second direction" — added 2026-05-22 after the video subset shipped green.)

## Repo layout

```
.
├── AGENTS.md                          agent instructions, LLP entry point
├── app.json                           Expo config (iOS 16.4, NSCameraUsageDescription)
├── package.json
├── src/                               demo app (Expo Router)
│   └── app/
├── llp/                               this directory
│   ├── 0000-…explainer.md             you are here
│   ├── 0001-spec-subset-scope.spec.md
│   ├── 0002-getusermedia.spec.md
│   ├── 0003-mediastream.spec.md
│   ├── 0004-htmlmediaelement-srcobject.spec.md
│   ├── 0005-ios-native-mapping.decision.md
│   ├── 0006-navigator-polyfill.decision.md
│   ├── 0007-in-app-wpt-runner.guide.md
│   ├── 0008-w3c-spec-text.spec.md     verbatim spec source-of-truth
│   └── 0009-audio-ios-mapping.decision.md
├── modules/
│   └── standard-camera/               local Expo module
└── scripts/
    └── test-ios.ts                    bun run test:ios
```

## References

- [W3C: Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) — primary normative spec
- [HTML living standard: `HTMLMediaElement.srcObject`](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject)
- [`web-platform-tests/wpt` — `mediacapture-streams/`](https://github.com/web-platform-tests/wpt/tree/master/mediacapture-streams) — the tests we adapt
- [LLP project](https://github.com/ccheever/llp)
- [Expo SDK 56 beta release notes](https://staging.expo.dev/changelog/sdk-56-beta)
