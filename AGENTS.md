# Agent instructions

## Documentation

Read the exact versioned Expo docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code that touches the Expo SDK. SDK 56 introduces several changes (Hermes V1, RN 0.85, Swift/C++ interop in modules, new `create-expo-module` flags) — do not rely on memory of older SDKs.

## Linked Literate Programming (LLP)

This repo uses [LLP](https://github.com/ccheever/llp). Design decisions and the precise W3C spec slices we implement live under `llp/`. Read the relevant LLP before changing code that implements a spec clause; if you change the implementation, update the LLP first or update both in the same change.

Start at `llp/0000-standard-camera.explainer.md`. Document numbering and types follow the LLP 0000 conventions (`Explainer`, `Spec`, `Decision`, `Plan`, `Guide`, `Principle`, `Issue`, `Research`).

### `@ref` annotations

Every load-bearing implementation detail that exists because a spec clause says so should have an `@ref` comment pointing at the relevant LLP section:

```swift
// @ref LLP 0004#track-stop — MediaStreamTrack.stop() must transition readyState to "ended"
```

```ts
// @ref LLP 0005#srcobject-currentTime — UA MUST ignore attempts to set currentTime on a MediaStream source
```

Run the `ref-check` skill (`/ref-check`) before requesting review to catch broken references and orphaned annotations.

## Scope reminder

This project implements a tiny subset of the W3C "Media Capture and Streams" spec on iOS only. Before adding a feature, check `llp/0002-spec-subset-scope.spec.md` — if the clause is marked "out of scope", do not add it without first updating LLP 0002.

## Testing

The in-app WPT-style runner is the source of truth for spec compliance. To run:

```
bun run test:ios
```

This boots an iOS 26 simulator, installs the app, deep-links to the test runner, parses results from the simulator log, and shuts the simulator down. Do not mark a spec change "done" until the runner is green.

## Physical iPhone builds

When building for a physical iPhone, copy the built app to a stable output directory so install retries do not require another native build:

```
bunx expo run:ios --device <device-udid> --output ./.build/ios-device
```

If the build succeeds but install or launch fails because the iPhone is locked, unreachable, or temporarily not accepting installs, retry with the saved binary instead of rebuilding:

```
bunx expo run:ios --device <device-udid> --binary ./.build/ios-device/standardcameraapp.app --no-bundler
```

For a lower-level install-only retry, use the same `.app` with `devicectl`:

```
xcrun devicectl device install app --device <device-udid> ./.build/ios-device/standardcameraapp.app
```

Do not use `--device generic` for this physical-device cache; Expo's generic iOS build path produces a simulator `.app`, not an installable iPhone build.

## Findings

- WebGPU camera/depth demos: avoid per-frame JS pixel swizzles or format conversions. In the LiDAR demos, converting 960x720 BGRA preview frames to RGBA in JS cost about 140ms per upload on an iPhone 15 Pro and dropped rendering to about 6fps. Prefer matching the WebGPU texture format to the native buffer format (for example `bgra8unorm`) and verify with physical-device `WEBGPU_DEMO_PROFILE` logs before optimizing shader code.
