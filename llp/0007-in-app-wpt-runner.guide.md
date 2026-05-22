# LLP 0007: In-app WPT-style test runner

**Type:** Guide
**Status:** Active
**Systems:** standard-camera, demo-app
**Author:** James Ide
**Date:** 2026-05-19
**Related:** 0001, 0002, 0003, 0004

## Summary

The source of truth for spec compliance is a small in-app test runner that mimics the [`testharness.js`](https://web-platform-tests.org/writing-tests/testharness-api.html) surface, runs ported `web-platform-tests` against the real iOS implementation, and prints results to the simulator log in a parseable format. The `bun run test:ios` CLI script boots an iOS 26 simulator, deep-links the app to the test screen, captures the output, and shuts the simulator down.

## Why an in-app runner, not Jest

Jest would force us to mock the native module. Mocked tests verify the JS surface but not that the AVFoundation pipeline actually behaves as the spec demands (e.g., does `loadeddata` actually fire when frames are rendered?). The whole point of the project is "does my DOM code actually run on iOS"; that question can only be answered by running on a real (or simulated) device.

## Harness surface

A subset of `testharness.js` (just what our ported tests need):

```ts
function test(fn: () => void, name: string): void;
function promise_test(fn: () => Promise<void>, name: string): Promise<void>;

function assert_equals(actual, expected, msg?): void;
function assert_not_equals(actual, expected, msg?): void;
function assert_true(value, msg?): void;
function assert_false(value, msg?): void;
function assert_less_than_equal(actual, expected, msg?): void;
function assert_greater_than_equal(actual, expected, msg?): void;
function assert_unreached(msg?): void;
function assert_throws_dom(expectedName: string, fn: () => void): void;
```

Each `*test` registers an entry. After all registrations, the runner iterates them in order, awaits the function, and emits one of:

```
WPT_RESULT: { "name": "...", "status": "pass" }
WPT_RESULT: { "name": "...", "status": "fail", "message": "..." }
WPT_RESULT: { "name": "...", "status": "timeout" }
```

After the last test, emits:

```
WPT_DONE: { "passed": N, "failed": N, "timeout": N }
```

Both use `console.log`, so they end up in the simulator log stream the CLI is parsing.

## Adapter to DOM idioms

The harness assumes a few DOM globals. We polyfill the minimum:

- `document.createElement("video")` returns a transient `<Video>` React component instance mounted off-screen, exposing the same ref-shape from LLP 0004. Implemented by rendering it into a hidden portal in the test screen.
- `queueTask(fn)` and `setTimeout` exist in JS already.
- `assert_throws_dom` matches `error.name` against the expected DOMException name; we don't strictly require `instanceof DOMException` because RN doesn't provide it.

The `createElement("video")` polyfill is the only complex piece. It returns a thunk that lazily mounts the component and provides a settable `srcObject` etc. that proxies to the mounted view's ref. See `src/app/run-tests.tsx` for the implementation.

## Ported tests

Located in `modules/standard-camera/src/testing/wpt/`:

- `MediaDevices-getUserMedia.ts` — adapted from [`wpt/mediacapture-streams/MediaDevices-getUserMedia.https.html`](https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-getUserMedia.https.html). Asserts API presence and that the returned stream contains exactly one live video track with reasonable settings.
- `MediaStream-MediaElement-srcObject.ts` — adapted from [`wpt/mediacapture-streams/MediaStream-MediaElement-srcObject.https.html`](https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-MediaElement-srcObject.https.html). Verifies the LLP 0004 invariants.
- `MediaStreamTrack-mute.ts` — covers `track.muted`, `mute` / `unmute` events, the empty-label-after-stop invariant, and the stop-stops-session step from LLP 0003. The mute/unmute path is exercised via a test-only native hook (`stream._native.__simulateInterruptionForTesting`) that posts a synthetic `AVCaptureSession.wasInterruptedNotification`.

Adding a new test: drop a file under `testing/wpt/`, import it from `testing/index.ts`, and add a one-line entry in this LLP.

## The simulator does not have a camera device

The iOS 26 simulator in current Xcode exposes no `AVCaptureDevice` to apps:

- `AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: …)` returns an empty array regardless of `position`.
- `AVCaptureDevice.default(for: .video)` returns `nil`.
- The kernel-side capture daemon logs `FigCaptureSourceSimulator signalled err=-12784` and `SpringBoard: No capture application found for the dev.ide.standardcameraapp`.

Empirically, running the WPT suite on a freshly-booted iOS 26 simulator gives **3 passed / 16 failed**: only the three tests that don't call `getUserMedia({video:true})` pass (`getUserMedia exists`, `getUserMedia({}) rejects with TypeError`, `getSupportedConstraints`). Every other test fails with `NotFoundError: Requested device not found` from `pickDevice`. The mute/unmute tests in particular can't be validated on the simulator because the synthetic-interruption hook needs a `MediaStream` to be posted-against, and getUserMedia rejects before the hook can be reached.

A real device (iPhone running iOS 26) passes 19/19.

## Testing overheating (thermal pressure) end-to-end

Two layers to think about:

**Layer 1 — our `NotificationCenter` observers and event fan-out.** Covered deterministically by the `MediaStreamTrack-mute.ts` tests, which call the test-only native hook `stream._native.__simulateInterruptionForTesting(reasonCode, ended)`. That hook posts the same `AVCaptureSession.wasInterruptedNotification` iOS would post. Our observers fire identically whether the notification came from iOS or from this hook, so this fully validates the handler path — `track.muted` flips, the JS DOM `mute` event dispatches, etc.

Validating Layer 1 requires a real device, because as documented above the simulator can't even open a capture session.

**Layer 2 — iOS actually deciding to interrupt because the device is hot.** This is iOS-internal behavior; we just consume the notification. Real-device-only:

- `simctl` has no thermal-pressure subcommand in current Xcode (verified: `strings $(xcrun -f simctl) | grep -iE "thermal|pressure"` returns nothing).
- I don't have a verified claim about Xcode Simulator app GUI controls for thermal state on this Xcode build. If one is added in a future Xcode and you use it, document the exact menu path here.
- Real-device induction path: sustained GPU/CPU load (e.g. a Metal benchmark in another foreground app) until `ProcessInfo.thermalState` escalates to `.serious` or `.critical`. Observe `ProcessInfo.thermalStateDidChangeNotification` to know when iOS is in that regime; verify `track.muted` flips and the `mute` event fires while the camera session is open. This is manual; not automated.

## Implications for `bun run test:ios`

The current CLI boots a simulator, which means it can't validate anything that needs `getUserMedia` to resolve — i.e. 16 of 19 tests are unreachable without modifying the CLI to target a real device. Practical options:

1. **Accept the limitation** and treat `bun run test:ios` as a smoke test (3 tests) plus a sanity check that the JS bundle loads.
2. **Add a `--device` flag** to `scripts/test-ios.ts` that targets a connected real device via `devicectl` instead of `simctl`. The same WPT runner code runs; only the install / launch / log-stream path differs.
3. **Wait for an Xcode build that adds a simulator camera device.** Apple has shipped this in older betas; whether it returns is up to them.

Until one of those happens, the canonical green-test claim is "19/19 on iPhone 15 Pro / iOS 26"; the simulator number ("3/19") is informational only and should not be used as a release gate.

## CLI flow (`bun run test:ios`)

`scripts/test-ios.ts`:

1. Resolve an iOS 26 runtime. Prefer one already installed; error clearly otherwise.
2. Create or boot a device named `standard-camera-test` of type `iPhone 16 Pro` on that runtime.
3. Grant camera privacy: `xcrun simctl privacy <UDID> grant camera dev.ide.standardcameraapp`. (The simulator's synthetic camera will satisfy capture.)
4. Build and install the app:
   - `expo prebuild --platform ios --clean` if `ios/` directory is missing or stale (hash-tracked)
   - `xcrun simctl install <UDID> <built .app>` or `expo run:ios --device <UDID>` for the first run
5. Launch with the deep link: `xcrun simctl openurl <UDID> standardcameraapp://run-tests`.
6. Open `xcrun simctl spawn <UDID> log stream --predicate 'process == "standard-camera-app"'` (or similar).
7. Parse `WPT_RESULT:` and `WPT_DONE:` lines.
8. Pretty-print summary. Exit `0` if `failed === 0` and `timeout === 0`, else `1`.
9. **Always** shut down the simulator on exit (success, failure, or signal). Use `using` (Node 22+/Bun) for a shutdown disposer.

## Triggering

The app reads its launch URL via `expo-linking`. The `run-tests` route auto-runs on mount; the demo screen at `/` is unchanged.

For manual runs during development:

```
bun run test:ios          # the full CLI flow
# or, inside the running app, just navigate to /run-tests manually
```

## Open questions

1. Should we ship the harness as a separate publishable package once it stabilizes? Probably — other modules implementing web specs (`fetch`, `WebSocket`, …) could use it. Keep it inside `standard-camera-app` for now and extract later.
2. Should `test:ios` cache the built `.app` to avoid full rebuilds on every run? Yes; track a hash of `modules/standard-camera/**` + `package.json` and skip rebuild if unchanged.
