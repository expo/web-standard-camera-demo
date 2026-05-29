# standard-camera-app

A demo Expo app and a local Expo module (`standard-camera`) that implement a small, deliberately spec-shaped subset of the W3C [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) specification on iOS. The hypothesis being tested is that if a browser API is small enough and well-shaped, you can port it 1:1 to React Native and let DOM-first code run unchanged:

```js
const stream = await navigator.mediaDevices.getUserMedia({ video: true });
videoRef.srcObject = stream;
```

That is the exact code you would write in a browser, and it works on iOS in this app.

This is a learning exercise, not a production library. See [`llp/0000-standard-camera.explainer.md`](./llp/0000-standard-camera.explainer.md) for the full motivation and architecture.

## Scope

The module ships `navigator.mediaDevices.getUserMedia()`, `MediaStream`, `MediaStreamTrack`, and a `<Video>` component whose `srcObject` setter binds an `AVCaptureSession` to an `AVCaptureVideoPreviewLayer`. Both `{ video: true }` and `{ audio: true }` (and the combined form) work. The clause-by-clause inventory of what is in and out lives in [`llp/0002-spec-subset-scope.spec.md`](./llp/0002-spec-subset-scope.spec.md).

Out of scope for v1: Android, `getDisplayMedia`, `MediaRecorder`, depth tracks, and WebXR. The repo does contain research-only WebXR-shaped LiDAR demos (see LLPs 0013–0015), but those are not part of the polyfilled surface.

## Repo layout

- `src/app/` — Expo Router screens for the demo app, including the camera preview, in-app WPT runner, and the WebGPU, LiDAR, panorama, and neural-lens demos.
- `modules/standard-camera/` — the local Expo module. TypeScript polyfill in `src/`, Swift implementation in `ios/`.
- `llp/` — Linked Literate Programming documents. Start at LLP 0000. Design decisions, spec slices, and demo plans live here.
- `scripts/` — `test-ios.ts`, `test-web.ts`, and the panorama validation runner.

## Quick start

This repo uses Bun:

```bash
bun install
bun run ios       # build and run on an iOS simulator
bun run web       # start the Expo Web bundler
```

For physical-device builds and the install-retry workflow, see [`AGENTS.md`](./AGENTS.md). The app requires iOS 16.4 or newer and has `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` set in `app.json`.

## Testing

The in-app WPT-style runner is the source of truth for spec compliance. To run it end to end on a simulator:

```bash
bun run test:ios
```

This boots iOS 26, installs the app, deep-links to the test runner, parses results from the simulator log, and shuts the simulator down. A spec change is not "done" until the runner is green. See [`llp/0010-in-app-wpt-runner.guide.md`](./llp/0010-in-app-wpt-runner.guide.md).

For an Expo Web smoke test that exercises the app shell, bundler, and browser console without emulating the iOS backend:

```bash
bun run test:web
```

The default web smoke test does not request camera permission. See [`llp/0011-expo-web-testing-flow.guide.md`](./llp/0011-expo-web-testing-flow.guide.md).

## Demos

The `(demo)` tab in the app collects a few things built on top of the polyfilled camera stream:

- A plain `<Video srcObject={stream} />` preview that mirrors the browser API.
- WebGPU shader-lens demos that sample camera frames as textures (LLP 0012).
- A LiDAR depth demo behind a research-only WebXR-shaped API (LLPs 0013–0014).
- A panoramic scene-capture demo (LLP 0015).
- TFJS- and MobileNet-based on-device scene classification.

## Contributing

Read the LLP for the area you are touching before changing code, and update the LLP in the same change. Every load-bearing implementation detail that exists because a spec clause says so should carry an `@ref LLP NNNN#anchor` comment. Run the `ref-check` skill before requesting review.

Agent and contributor guidance lives in [`AGENTS.md`](./AGENTS.md).
