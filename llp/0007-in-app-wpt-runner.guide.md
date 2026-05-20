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

Located in `modules/standard-camera/src/tests/wpt/`:

- `MediaDevices-getUserMedia.test.ts` — adapted from [`wpt/mediacapture-streams/MediaDevices-getUserMedia.https.html`](https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-getUserMedia.https.html). Asserts API presence and that the returned stream contains exactly one live video track with reasonable settings.
- `MediaStream-MediaElement-srcObject.test.ts` — adapted from [`wpt/mediacapture-streams/MediaStream-MediaElement-srcObject.https.html`](https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-MediaElement-srcObject.https.html). Verifies the LLP 0004 invariants.

Adding a new test: drop a file under `tests/wpt/`, import it from `tests/index.ts`, and add a one-line entry in this LLP.

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
