# LLP 0011: Expo Web testing flow

**Type:** Guide
**Status:** Active
**Systems:** demo-app, testing
**Author:** James Ide
**Date:** 2026-05-26
**Related:** 0000, 0010

## Summary

Expo Web is a smoke target for the demo app shell. It is not the source of
truth for this repo's Media Capture implementation: browsers already provide
`navigator.mediaDevices`, `MediaStream`, `MediaStreamTrack`, and
`HTMLVideoElement`. The iOS app is where `standard-camera` implements those
web APIs over AVFoundation.

The web target therefore must not emulate the iOS `NativeStandardCamera`
backend. Web platform files use browser APIs directly, while iOS platform
files keep the native backend underneath the same public, web-shaped module
surface.

## CLI flow

Run:

```bash
bun run test:web
```

The script:

1. Picks a free localhost port.
2. Starts `bun run web -- --localhost --port <port>` and streams the Expo CLI
   output.
3. Waits for the Expo dev server `/status` endpoint.
4. Clears `agent-browser` console and page-error buffers.
5. Opens the app in `agent-browser`.
6. Reads browser console logs and uncaught page errors.
7. Fails if an Expo error overlay is visible, page errors exist, browser
   console errors exist, or the app shell text does not render.
8. Prints the browser logs and a dev-server log tail on failure.

Useful flags:

```bash
bun run test:web -- --strict-console
bun run test:web -- --keep-open
bun run test:web -- --port 19006
```

`--strict-console` treats browser warnings as failures. The default fails only
browser console errors and uncaught page errors because React/Expo development
builds can emit informational warnings that are not app regressions.

## Camera permission

The default web smoke test does not click "Start camera" and should not trigger
a browser camera permission prompt. A future browser-camera test may request
permission for the localhost origin, but that would be a test of the browser's
own `navigator.mediaDevices`, not a test of the iOS StandardCamera backend.

## Browser Tests Tab

The web Tests tab imports `modules/standard-camera/src/testing/index.web.ts`,
not the iOS registration index. The web index registers only the in-scope
Media Capture and Streams / `srcObject` cases that can run against browser
APIs. It intentionally does not register:

- Browser Capture / Element Capture tests (`cropTo`, `restrictTo`) because
  they require `getDisplayMedia()`, which LLP 0002 marks out of scope.
- Cross-origin iframe, Permissions Policy header, and SecureContext
  infrastructure tests because the app shell does not own those browser-hosted
  conditions.
- Project-local iOS backdoor tests such as AVCaptureSession interruption
  `mute` / `unmute`, source-side frame/audio probes, multi-camera hardware
  enumeration, and AVFoundation format-selection checks.

Those files may stay on disk for provenance, but they are not part of the
active compliance suite unless LLP 0002 brings the corresponding API into
scope first.

## Platform boundary

- `modules/standard-camera/index.ts` is the iOS/native entry point.
- `modules/standard-camera/index.web.ts` exports the browser's own web APIs
  and does not install the iOS polyfill.
- `modules/standard-camera/src/native.ts` is the backend contract.
- `modules/standard-camera/src/native.ios.ts` binds that contract to the
  `StandardCamera` Expo native module.
- Web app code that needs camera state uses `src/contexts/CameraContext.web.tsx`,
  which calls `navigator.mediaDevices` directly.

This keeps the project thesis intact: iOS implements web APIs; web uses web
APIs.
