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
WPT_DONE: { "passed": N, "failed": N, "timeout": N, "skipped": N }
```

The `skipped` status is for tests whose preconditions can't be met by the
current environment — most commonly, a test that needs `getUserMedia` to
resolve, running on the iOS 26 simulator (which has no `AVCaptureDevice`). The
runner inspects the thrown error: if its `name` is `NotFoundError` and its
message says the device is missing, the test is reported as `skip` rather
than `fail`. Skipped tests do not cause the CLI to exit non-zero. A real
device, where `getUserMedia` succeeds, yields zero skips.

### Test categorization

Every registered test carries a `requirement` describing what it needs to
run, set at registration time from a `SOURCE_REQUIREMENTS` / `TEST_NAME_REQUIREMENTS`
table in `testharness.ts`:

- `'always'` — runs anywhere. Pure API-surface checks, IDL inspection, or
  paths where `getUserMedia` rejects synchronously (`TypeError` for invalid
  constraints, `NotAllowedError` for the synthetic-denial helper).
- `'camera'` — needs a real `AVCaptureDevice` for video. Skipped pre-emptively
  on the iOS simulator. Default for any unmapped WPT source.
- `'microphone'` — needs a real audio capture device.
- `'camera-or-microphone'` — needs at least one (e.g., tests that use both
  `gUM({video})` and `gUM({audio})`).
- `'out-of-scope'` — permanently inapplicable in React Native: cross-origin
  iframes, postMessage transfer, Permissions Policy headers, SecureContext,
  `getDisplayMedia`, canvas / WebAudio frame inspection. The runner skips
  these with the rationale from the table as the message — readers can
  distinguish "browser-only" from "feature outside our scope".

The runner derives the environment from two `gUM` probes — `{video:true}`
and `{audio:true}` — issued at run start, before any test bodies execute.
The probes serve two purposes: on a real device they trigger iOS's camera
and microphone permission prompts up front (so the user grants both before
a test body opens a stream and the prompt would otherwise appear mid-suite),
and they give an authoritative answer for whether each capture kind is
usable here. The pre-run header (rendered before the user taps Run) still
uses `detectEnvironment()` (which calls `enumerateDevices()` and is
permission-free) as a best-effort initial display, but the screen replaces
it with the probe-derived env via the runner's `onEnvironment` callback as
soon as the probes resolve. This matters for audio in particular: on iOS,
`AVCaptureDevice.default(for: .audio)` returns `nil` until AVAudioSession
has been configured, so `enumerateDevices()` reports `hasMicrophone:false`
on first launch even with mic permission already granted. Without the audio
probe, every mic-required test would be pre-skipped as "deviceMissing" and
the user would see them tallied only in the final `WPT_DONE` summary rather
than actually executed.

Tests whose requirement isn't met by the resolved env are pre-skipped with a
clear message ("skipped: requires a real camera device"). The classification
is also surfaced in `WPT_DONE` so the CLI and in-app UI can display "X
applicable on simulator / Y total" rather than "13 passed / 36 skipped" —
the latter reads as broken even though it's expected.

The runtime `NotFoundError` safety net stays in place: if a test was
misclassified as `'always'` but turns out to depend on a camera, it still
gets `skip` instead of `fail` at runtime.

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

## Static test registration

Every test must call `test()` / `promise_test()` / `async_test()` at
module-load time. The runner sets `registrationLocked = true` immediately
before the test loop begins, and `registerTest` throws if it sees a call
from within a running test body or a helper invoked from one. The throw
fails the offending test but does not corrupt the suite; the loop just
continues.

This is a deliberate deviation from upstream WPT, which permits
discover-then-register patterns where a parent test queries the device's
runtime capabilities and registers a sub-test per discovered property via
`test()` calls inside its own callback. We disallow it for two reasons:

1. The in-app runner pre-renders the full list of test rows on screen
   mount. A test that doesn't exist yet can't have a row, so the
   `applicable / total` counter drifts upward as the suite runs — the
   user-visible "total kept counting after the suite finished" symptom
   that motivated this rule.
2. TDD against a feature that doesn't work yet (audio support, in
   practice) wants every expected test to show up as `pending → fail`
   immediately, not "you have to actually open a stream before we know
   what to assert."

The one file that previously used the upstream pattern,
`MediaStreamTrack-getCapabilities.ts`, is adapted (not verbatim) to
expand `testCapabilities(capabilities, property, prefix)` into
pre-registered per-property sub-tests at module load. A single setup
`promise_test` per category (audio track / video track / audio device /
video device) opens the stream, snapshots `getCapabilities()` into
module-scope state, and the per-property sub-tests consume that
snapshot. The setup runs first by registration order; if it throws, all
dependent sub-tests rethrow the same error so they all surface the
concrete cause.

When porting a new WPT file that uses the discover-then-register pattern,
flatten it the same way. The static-registration error message points
back to this section.

## The simulator does not have a camera device

The iOS 26 simulator in current Xcode exposes no `AVCaptureDevice` to apps:

- `AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: …)` returns an empty array regardless of `position`.
- `AVCaptureDevice.default(for: .video)` returns `nil`.
- The kernel-side capture daemon logs `FigCaptureSourceSimulator signalled err=-12784` and `SpringBoard: No capture application found for the dev.ide.standardcameraapp`.

Empirically, running the WPT suite on a freshly-booted iOS 26 simulator (2026-05-22) gives **13 passed / 0 failed / 0 timeout / 36 skipped**. The 13 passing tests are the ones that don't need a camera (existence checks, supported constraints, script-only constructors, audio-rejected, legacy-API absence). The other 36 throw `NotFoundError: Requested device not found` and the harness marks them `skip` rather than `fail` because the failure is an environment limitation, not a regression — see [Status legend](#harness-surface). Skipped tests do not cause CI to fail.

A real device (iPhone running iOS 26) executes the camera path for every test and is expected to pass 49/49 (skips drop to 0).

## Testing overheating

Thermal pressure end-to-end:

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

As of 2026-05-22 the canonical green-test claim is "49/49 on iPhone 15 Pro / iOS 26" (with skip handling, simulator runs are also green: 13 pass + 36 skip + 0 fail + 0 timeout).

## CLI flow (`bun run test:ios`)

`scripts/test-ios.ts`:

1. Resolve an iOS 26 runtime. Prefer one already installed; error clearly otherwise.
2. Create or boot a device named `standard-camera-app` of type `iPhone 17 Pro` on that runtime.
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
