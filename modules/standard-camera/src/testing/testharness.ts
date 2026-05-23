// @ref LLP 0007 — testharness.js subset
//
// A port of the WPT testharness API. Tests register via test() /
// promise_test() / async_test() and the runner executes them sequentially.
// Each test receives a `t` object with the cleanup / step helpers WPT tests
// commonly use, plus access to globally-shared `video` and `audio` elements
// (mirroring the WPT pattern where elements with ids are accessible as globals).
//
// Results are emitted to console with WPT_RESULT / WPT_DONE prefixes so the
// CLI driver (scripts/test-ios.ts) can parse them out of the simulator log.

// Install the minimal browser-DOM shim before anything else in this module
// graph — including the WPT port files that side-effect-import from here —
// so top-level references to `document` / `window` / `test_driver` don't
// crash module evaluation. See dom-shim.ts for what's stubbed.
import { installDomShim } from './dom-shim';
installDomShim();

import NativeModule from '../native';
import type { HTMLVideoElement } from '../HTMLVideoElement';

// MARK: - WPT source annotation

let currentSourceFile: string | null = null;
let currentGroup: string | null = null;

/** Annotate the source WPT file for all tests registered after this call. */
export function wptSource(file: string | null): void {
  currentSourceFile = file;
}

/** Annotate a semantic group for all tests registered after this call. */
export function wptGroup(group: string | null): void {
  currentGroup = group;
}

// MARK: - t object

export interface TestHandle {
  /** Wrap a callback so an exception inside it fails the test. */
  step_func<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  /** Wrap a callback that also marks the test as done after running. */
  step_func_done<A extends unknown[]>(fn?: (...args: A) => void): (...args: A) => void;
  /** Run a function synchronously; exceptions fail the test. */
  step(fn: () => void): void;
  /** setTimeout-style scheduling that respects test bookkeeping. */
  step_timeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  /** Register a cleanup function to run after the test. */
  add_cleanup(fn: () => void | Promise<void>): void;
  /** A function that fails the test if it's ever invoked. */
  unreached_func(reason?: string): (...args: unknown[]) => never;
  /** Mark an async_test() as complete. No-op for promise_test. */
  done(): void;
  /** Poll until a predicate returns truthy. Resolves with the predicate's
   *  result; rejects on timeout. Matches the WPT testharness signature. */
  step_wait<T>(condition: () => T | Promise<T>, description?: string, timeoutMs?: number, intervalMs?: number): Promise<T>;
}

class TestHandleImpl implements TestHandle {
  cleanups: Array<() => void | Promise<void>> = [];
  doneSignal: (() => void) | null = null;
  failed: Error | null = null;

  step_func<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      try {
        fn(...args);
      } catch (e) {
        this.failed = e as Error;
        throw e;
      }
    };
  }

  step_func_done<A extends unknown[]>(fn?: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      try {
        if (fn) fn(...args);
        this.done();
      } catch (e) {
        this.failed = e as Error;
        this.done();
        throw e;
      }
    };
  }

  step(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.failed = e as Error;
      throw e;
    }
  }

  step_timeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      try {
        fn();
      } catch (e) {
        this.failed = e as Error;
      }
    }, ms);
  }

  add_cleanup(fn: () => void | Promise<void>): void {
    this.cleanups.push(fn);
  }

  unreached_func(reason = 'should not be called'): (...args: unknown[]) => never {
    return () => {
      throw new AssertionError(`unreached_func: ${reason}`);
    };
  }

  done(): void {
    this.doneSignal?.();
  }

  async step_wait<T>(
    condition: () => T | Promise<T>,
    description?: string,
    timeoutMs = 3000,
    intervalMs = 100
  ): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = await condition();
      if (v) return v;
      if (Date.now() - start >= timeoutMs) {
        throw new AssertionError(`step_wait timed out${description ? `: ${description}` : ''}`);
      }
      await new Promise<void>((r) => setTimeout(r, intervalMs));
    }
  }
}

// MARK: - Test registration

type TestFn = (t: TestHandle) => void | Promise<void>;
type TestEntry = {
  name: string;
  fn: TestFn;
  type: 'sync' | 'async-promise' | 'async-callback';
  source: string | null;
  group: string | null;
};

const tests: TestEntry[] = [];
const _harnessSetup: { [k: string]: unknown } = {};

function defaultName(): string {
  // Some WPT bodies omit the name argument. Per upstream testharness.js the
  // name defaults to a sequential "Test N" label scoped to the current file.
  const fileTests = tests.filter((t) => t.source === currentSourceFile).length;
  return currentSourceFile
    ? `${currentSourceFile} — Test ${fileTests + 1}`
    : `Test ${tests.length + 1}`;
}

export function test(fn: (t: TestHandle) => void, name?: string): void {
  tests.push({
    name: name ?? defaultName(),
    fn,
    type: 'sync',
    source: currentSourceFile,
    group: currentGroup,
  });
}

export function promise_test(
  fn: (t: TestHandle) => Promise<void>,
  name?: string
): void {
  tests.push({
    name: name ?? defaultName(),
    fn,
    type: 'async-promise',
    source: currentSourceFile,
    group: currentGroup,
  });
}

/** WPT async_test — caller invokes `t.done()` to finish; otherwise times out. */
export function async_test(fn: (t: TestHandle) => void, name?: string): void {
  tests.push({
    name: name ?? defaultName(),
    fn,
    type: 'async-callback',
    source: currentSourceFile,
    group: currentGroup,
  });
}

/** WPT helper that asks the testing infrastructure to grant or deny a media
 *  permission. We don't have a real test-driver bridge to the system prompt,
 *  but tests that *deny* a permission expect subsequent `gUM` calls of that
 *  kind to reject with `NotAllowedError`. We track the denial set here and
 *  the `MediaDevices` module consults it via `__getDeniedKindsForTesting`.
 *  Granting is the default — gUM proceeds against the simulator-granted
 *  privacy permission set up by `bun run test:ios` (LLP 0007#cli-flow). */
export async function setMediaPermission(
  state: 'granted' | 'denied' = 'granted',
  devices: string[] = ['camera']
): Promise<void> {
  if (state === 'denied') {
    for (const d of devices) deniedPermissions.add(d);
  } else {
    for (const d of devices) deniedPermissions.delete(d);
  }
}

const deniedPermissions = new Set<string>();

export function __getDeniedKindsForTesting(): { camera: boolean; microphone: boolean } {
  return {
    camera: deniedPermissions.has('camera'),
    microphone: deniedPermissions.has('microphone'),
  };
}

export function __resetDeniedPermissionsForTesting(): void {
  deniedPermissions.clear();
}

/** Match `setup()` from testharness.js — captures harness-level configuration
 *  (timeouts, etc.). We don't honor most of it; this is for source compatibility. */
export function setup(config: Record<string, unknown>): void {
  Object.assign(_harnessSetup, config);
}

// MARK: - Assertions

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assert_equals(actual: unknown, expected: unknown, msg?: string): void {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(
      `${msg ?? 'assert_equals'}: expected ${formatValue(expected)} but got ${formatValue(actual)}`
    );
  }
}

export function assert_not_equals(actual: unknown, expected: unknown, msg?: string): void {
  if (Object.is(actual, expected)) {
    throw new AssertionError(`${msg ?? 'assert_not_equals'}: got ${formatValue(actual)}`);
  }
}

export function assert_true(value: unknown, msg?: string): void {
  if (value !== true) {
    throw new AssertionError(`${msg ?? 'assert_true'}: expected true, got ${formatValue(value)}`);
  }
}

export function assert_false(value: unknown, msg?: string): void {
  if (value !== false) {
    throw new AssertionError(`${msg ?? 'assert_false'}: expected false, got ${formatValue(value)}`);
  }
}

export function assert_less_than(actual: number, expected: number, msg?: string): void {
  if (!(actual < expected)) {
    throw new AssertionError(`${msg ?? 'assert_less_than'}: ${actual} >= ${expected}`);
  }
}

export function assert_greater_than(actual: number, expected: number, msg?: string): void {
  if (!(actual > expected)) {
    throw new AssertionError(`${msg ?? 'assert_greater_than'}: ${actual} <= ${expected}`);
  }
}

export function assert_less_than_equal(actual: number, expected: number, msg?: string): void {
  if (!(actual <= expected)) {
    throw new AssertionError(`${msg ?? 'assert_less_than_equal'}: ${actual} > ${expected}`);
  }
}

export function assert_greater_than_equal(actual: number, expected: number, msg?: string): void {
  if (!(actual >= expected)) {
    throw new AssertionError(`${msg ?? 'assert_greater_than_equal'}: ${actual} < ${expected}`);
  }
}

export function assert_unreached(msg?: string): never {
  throw new AssertionError(msg ?? 'assert_unreached: this code should not run');
}

export function assert_regexp_match(actual: string, pattern: RegExp, msg?: string): void {
  if (!pattern.test(actual)) {
    throw new AssertionError(
      `${msg ?? 'assert_regexp_match'}: ${JSON.stringify(actual)} did not match ${pattern}`
    );
  }
}

export function assert_array_equals(actual: unknown[], expected: unknown[], msg?: string): void {
  if (!Array.isArray(actual)) {
    throw new AssertionError(`${msg ?? 'assert_array_equals'}: actual is not an array`);
  }
  if (actual.length !== expected.length) {
    throw new AssertionError(
      `${msg ?? 'assert_array_equals'}: lengths differ — actual ${actual.length}, expected ${expected.length}`
    );
  }
  for (let i = 0; i < actual.length; i++) {
    if (!Object.is(actual[i], expected[i])) {
      throw new AssertionError(
        `${msg ?? 'assert_array_equals'}: index ${i} differs — actual ${formatValue(actual[i])}, expected ${formatValue(expected[i])}`
      );
    }
  }
}

export function assert_throws_js(
  constructor: ErrorConstructor,
  fn: () => void,
  msg?: string
): void {
  try {
    fn();
  } catch (e) {
    if (!(e instanceof constructor)) {
      throw new AssertionError(
        `${msg ?? 'assert_throws_js'}: expected ${constructor.name}, got ${(e as Error).name ?? typeof e}`
      );
    }
    return;
  }
  throw new AssertionError(`${msg ?? 'assert_throws_js'}: function did not throw`);
}

export function assert_throws_dom(
  expectedName: string,
  fn: () => void,
  msg?: string
): void {
  try {
    fn();
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name !== expectedName) {
      throw new AssertionError(
        `${msg ?? 'assert_throws_dom'}: expected error name ${expectedName}, got ${name ?? 'undefined'}`
      );
    }
    return;
  }
  throw new AssertionError(`${msg ?? 'assert_throws_dom'}: function did not throw`);
}

export async function assert_promise_rejects_dom(
  expectedName: string,
  promise: Promise<unknown>,
  msg?: string
): Promise<void> {
  try {
    await promise;
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name !== expectedName) {
      throw new AssertionError(
        `${msg ?? 'assert_promise_rejects_dom'}: expected ${expectedName}, got ${name ?? 'undefined'}`
      );
    }
    return;
  }
  throw new AssertionError(
    `${msg ?? 'assert_promise_rejects_dom'}: promise did not reject`
  );
}

export function assert_inherits(object: object, property: string, msg?: string): void {
  if (!(property in object)) {
    throw new AssertionError(
      `${msg ?? 'assert_inherits'}: ${property} is not in the prototype chain`
    );
  }
}

export function assert_idl_attribute(object: object, property: string, msg?: string): void {
  // Treat as a structural presence check; we don't carry IDL metadata.
  if (!(property in object)) {
    throw new AssertionError(
      `${msg ?? 'assert_idl_attribute'}: ${property} is not present on the object`
    );
  }
}

export function assert_class_string(object: object, className: string, msg?: string): void {
  const tag = Object.prototype.toString.call(object);
  const expected = `[object ${className}]`;
  if (tag !== expected) {
    throw new AssertionError(
      `${msg ?? 'assert_class_string'}: expected ${expected} but got ${tag}`
    );
  }
}

export function assert_between_inclusive(
  actual: number,
  lower: number,
  upper: number,
  msg?: string
): void {
  if (!(actual >= lower && actual <= upper)) {
    throw new AssertionError(
      `${msg ?? 'assert_between_inclusive'}: expected ${actual} to be in [${lower}, ${upper}]`
    );
  }
}

export function assert_between_exclusive(
  actual: number,
  lower: number,
  upper: number,
  msg?: string
): void {
  if (!(actual > lower && actual < upper)) {
    throw new AssertionError(
      `${msg ?? 'assert_between_exclusive'}: expected ${actual} to be in (${lower}, ${upper})`
    );
  }
}

export function assert_in_array(actual: unknown, expected: unknown[], msg?: string): void {
  if (!expected.some((v) => Object.is(v, actual))) {
    throw new AssertionError(
      `${msg ?? 'assert_in_array'}: ${formatValue(actual)} not in ${formatValue(expected)}`
    );
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v == null) return String(v);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  return String(v);
}

// MARK: - Runner

export type TestStatus = 'pass' | 'fail' | 'timeout' | 'skip';

export type TestResult = {
  name: string;
  status: TestStatus;
  message?: string;
  durationMs: number;
  source: string | null;
  group: string | null;
};

const DEFAULT_TIMEOUT_MS = 15_000;

// @ref LLP 0007#the-simulator-does-not-have-a-camera-device — `getUserMedia`-
// dependent tests can't run when there's no AVCaptureDevice. We report these
// as `skip` rather than `fail` because the failure is an environment limit.
//
// Some WPT bodies catch the gUM rejection and re-throw `assert_unreached(...)`
// with a sentinel message rather than letting the original `NotFoundError`
// propagate; we recognize those sentinels too so they don't show up as
// regressions on the camera-less simulator.
function isEnvironmentSkip(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const name = (e as { name?: string }).name;
  if (name === 'NotFoundError' && /Requested device not found|no.*camera|no.*device/i.test(e.message)) {
    return true;
  }
  // Only honor these sentinels when no camera is actually present — checked
  // at test-runner startup; see `noCameraEnvironment` below.
  if (noCameraEnvironment && name === 'AssertionError') {
    return (
      /getUserMedia error callback was invoked|an optional constraint can't stop us from obtaining a video stream|a Video stream of minimally zero width can always be created/i.test(
        e.message
      )
    );
  }
  return false;
}

// Set once at runAllTests start by a probe call to `getUserMedia({video:true})`.
// When the probe rejects with NotFoundError we know we're running on the
// camera-less simulator. The flag is consulted by `isEnvironmentSkip` to
// recognize assert_unreached sentinels emitted by WPT bodies that themselves
// swallow the original NotFoundError.
let noCameraEnvironment = false;

// Sources whose tests fundamentally require browser features that don't exist
// in React Native (cross-origin iframes, postMessage transfer of MediaStreamTrack,
// secure-context boundaries, Permissions Policy). We pre-mark them as skipped
// so they don't timeout-wait for events that never fire.
// Sources where every test depends on a feature outside the v1 subset. Map
// values are the rationale we surface to the runner so a reader can
// distinguish "we chose not to support this" from "we have a regression".
const ENV_SKIPPED_SOURCES = new Map<string, string>([
  // === Cross-origin contexts and frames ===
  // Per the project goal, these are the only kinds of tests we accept as
  // permanently skipped. RN has no cross-origin or iframe infrastructure,
  // and `postMessage` transfer of MediaStreamTrack between contexts depends
  // on cross-context messaging that doesn't exist here.
  ['MediaDevices-enumerateDevices-per-origin-ids.sub.https.html', 'cross-origin-or-frame: requires cross-origin iframes'],
  ['MediaDevices-enumerateDevices-persistent-permission.https.html', 'cross-origin-or-frame: requires cross-origin iframes / persistent-permission infrastructure'],
  ['MediaDevices-after-discard.https.html', 'cross-origin-or-frame: requires cross-origin iframes / discarded-browsing-context lifecycle'],
  ['enumerateDevices-with-navigation.https.html', 'cross-origin-or-frame: requires cross-origin iframes / navigation'],
  ['MediaStreamTrack-transfer.https.html', 'cross-origin-or-frame: requires postMessage MediaStreamTrack transfer between contexts'],
  ['MediaStreamTrack-transfer-video.https.html', 'cross-origin-or-frame: requires postMessage MediaStreamTrack transfer between contexts'],
  ['MediaStreamTrack-iframe-transfer.https.html', 'cross-origin-or-frame: requires cross-origin iframes / postMessage transfer'],
  ['MediaStreamTrack-iframe-audio-transfer.https.html', 'cross-origin-or-frame: requires cross-origin iframes / postMessage transfer'],
  ['MediaDevices-enumerateDevices-not-allowed-camera.https.html', 'cross-origin-or-frame: drives camera-not-allowed via cross-origin Permissions-Policy headers'],
  ['MediaDevices-enumerateDevices-not-allowed-mic.https.html', 'cross-origin-or-frame: drives mic-not-allowed via cross-origin Permissions-Policy headers'],
  ['MediaStream-default-permissions-policy.https.html', 'cross-origin-or-frame: drives cross-origin Permissions-Policy iframes via `run_all_fp_tests_allow_self`'],

  // === Tests that fundamentally clash with the project's scope ===
  // (LLP 0000 lists `getDisplayMedia`, canvas/WebAudio access, and a
  //  non-secure-context probe as out of scope.)
  // SecureContext: a non-secure context that hides `mediaDevices`. Our entire
  // project polyfills `mediaDevices`, so we can't honor the assert_false's.
  ['MediaDevices-SecureContext.html', 'out-of-scope: tests a non-secure context where mediaDevices is hidden; our polyfill always exposes it'],
  // getDisplayMedia + CropTarget / RestrictionTarget / transient activation
  ['BrowserCaptureMediaStreamTrack-cropTo.https.html', 'out-of-scope: requires getDisplayMedia + CropTarget'],
  ['BrowserCaptureMediaStreamTrack-restrictTo.https.html', 'out-of-scope: requires getDisplayMedia + RestrictionTarget'],
  ['parallel-capture-requests.https.html', 'out-of-scope: requires getDisplayMedia + transient-activation button'],
  // Disabled-track-renders-{black,silence}: need canvas.drawImage(video) /
  // AudioContext analyser respectively. Reading raw samples back into JS is
  // explicitly out of scope (LLP 0005#consequences).
  ['MediaStreamTrack-MediaElement-disabled-video-is-black.https.html', 'out-of-scope: requires canvas.drawImage(video) frame inspection'],
  ['MediaStreamTrack-MediaElement-disabled-audio-is-silence.https.html', 'out-of-scope: requires AudioContext analyser to read captured samples'],

  // Audio capture is in scope as of 2026-05-22 (LLP 0001, LLP 0009).
  // The previous source-level skips for audio-only test files are removed
  // here so the audio tests actually run against the iOS implementation.
]);

// Individual tests we skip because they depend on a browser feature that's
// out of scope per LLP 0001 (canvas.captureStream, multi-camera devices,
// crop-and-scale, AudioContext, etc.) and that we have no path to ship.
const ENV_SKIPPED_TEST_NAMES = new Map<string, string>([
  // Uses `canvas.captureStream()` — canvas + WebRTC capture is out of scope.
  [
    'Tests that a media element with an assigned MediaStream does not start advancing currentTime until potentially playing',
    'out-of-scope: requires HTMLCanvasElement.captureStream',
  ],
  // (Previously env-skipped: `deviceId and groupId are correctly reported by
  // getSettings() for all input devices` — required >1 camera. Now runnable
  // since enumerateDevices() returns every built-in camera.)
  // crop-and-scale isn't supported by our AVFoundation pipeline (LLP 0001).
  [
    'getUserMedia() supports setting crop-and-scale as resizeMode without downscaling.',
    'out-of-scope: crop-and-scale resizeMode is not implemented',
  ],
  [
    'getUserMedia() supports setting crop-and-scale as resizeMode with downscaling.',
    'out-of-scope: crop-and-scale resizeMode is not implemented',
  ],
  [
    'getUserMedia() supports setting crop-and-scale as resizeMode with decimation.',
    'out-of-scope: crop-and-scale resizeMode is not implemented',
  ],
  [
    'Video track getCapabilities() resizeMode properly supported. Value: crop-and-scale',
    'out-of-scope: crop-and-scale resizeMode is not implemented',
  ],
  [
    'Video device getCapabilities() resizeMode properly supported. Value: crop-and-scale',
    'out-of-scope: crop-and-scale resizeMode is not implemented',
  ],
  // iPhone cameras don't expose a 320-wide format; "ideal: 320" can only be
  // satisfied with cropping (out of scope).
  [
    'Tests that setting a required constraint with an ideal value in getUserMedia works',
    'out-of-scope: iPhone cameras have no 320-wide format and we do not crop',
  ],
  // Requires AudioContext.createMediaStreamDestination(); we ship audio
  // capture but no WebAudio implementation.
  [
    "The MediaStreamTrackEvent instance's track attribute is set.",
    'out-of-scope: requires AudioContext / createMediaStreamDestination — WebAudio is out of scope',
  ],
]);

/** A test as registered, before it has run. Used by the UI to pre-list the
 *  whole suite so users can see progress through it. */
export interface PendingTest {
  name: string;
  source: string | null;
  group: string | null;
}

export interface RunOptions {
  /** Optional helper to reset shared DOM-like state between tests. */
  resetEnvironment?: () => void;
  /** Called just before each test starts running. */
  onStart?: (entry: PendingTest, index: number, total: number) => void;
  /** Called after each test produces a result. */
  onResult?: (result: TestResult, index: number, total: number) => void;
}

/** Snapshot of every test currently registered, for UI pre-rendering. */
export function getRegisteredTests(): PendingTest[] {
  return tests.map((t) => ({ name: t.name, source: t.source, group: t.group }));
}

// MARK: - Late-error capture
//
// Many WPT tests schedule callbacks via `setTimeout` or wire up event listeners
// that may fire AFTER the harness has already moved on to the next test. When
// those callbacks throw, RN's exception manager intercepts the error and
// shows a RedBox in Debug. WPT testharness.js handles this by installing
// `window.onerror` and `window.onunhandledrejection`, attributing the error to
// whichever test is currently running. We do the same — late errors annotate
// the *current* test's TestHandle so the run finishes cleanly and the test is
// marked failed rather than crashing the bundle.
let currentTestHandle: TestHandleImpl | null = null;

// Install error-catching hooks at MODULE LOAD time (not runAllTests-time) so
// the late-error path is always armed. WPT bodies often fire events whose
// listeners throw `assert_unreached` — those throws are caught by the
// EventTarget polyfill's listener try/catch but RE-THROWN via `setTimeout(() =>
// { throw err; })`. Without our hook, those setTimeout throws bubble to RN's
// exception manager and trigger a RedBox in Debug.
(function installLateErrorHooks(): void {
  const g = globalThis as unknown as {
    HermesInternal?: { enablePromiseRejectionTracker?: (opts: { allRejections: boolean; onUnhandled: (id: number, reason: unknown) => void }) => void };
    ErrorUtils?: { setGlobalHandler?: (fn: (e: Error, isFatal: boolean) => void) => void; getGlobalHandler?: () => (e: Error, isFatal: boolean) => void };
    setTimeout?: (fn: (...args: unknown[]) => void, ms?: number) => unknown;
  };

  // RN's ErrorUtils is the canonical hook for uncaught errors. Wrap the
  // existing global handler so non-test errors still surface.
  const prevGlobalHandler = g.ErrorUtils?.getGlobalHandler?.();
  g.ErrorUtils?.setGlobalHandler?.((err: Error, isFatal: boolean) => {
    if (currentTestHandle && !currentTestHandle.failed) {
      currentTestHandle.failed = err;
      return;
    }
    prevGlobalHandler?.(err, isFatal);
  });

  // Hermes promise rejection tracker. RN normally installs one in Debug that
  // shows a RedBox after a grace period; we override to forward to the
  // currently-running test.
  g.HermesInternal?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id: number, reason: unknown) => {
      if (currentTestHandle && !currentTestHandle.failed) {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        currentTestHandle.failed = err;
      }
    },
  });

  // Belt-and-suspenders: monkeypatch setTimeout so callbacks that throw
  // attribute to the current test (the event-target-polyfill uses
  // `setTimeout(() => { throw err })` to re-throw listener errors out of the
  // microtask checkpoint — without this wrap, those throws hit RN's
  // exception manager and trigger a RedBox).
  const originalSetTimeout = g.setTimeout;
  if (typeof originalSetTimeout === 'function') {
    g.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      return originalSetTimeout(function wrapped(...args: unknown[]) {
        try {
          fn(...args);
        } catch (e) {
          if (currentTestHandle && !currentTestHandle.failed) {
            currentTestHandle.failed = e as Error;
            return;
          }
          throw e;
        }
      }, ms);
    }) as typeof originalSetTimeout;
  }

  // RN 0.85 ships its own EventTarget that catches listener errors and
  // surfaces them via `console.error(error)`. In Debug, RN's LogBox renders
  // `console.error` as a red notification — visually identical to a
  // RedBox-crash, so users perceive it as one. Wrap console.error so an
  // Error instance during an active test attributes to the test rather than
  // showing the LogBox. Non-Error console.error calls (string warnings, etc.)
  // pass through unchanged.
  const consoleObj = (globalThis as unknown as { console?: { error?: (...a: unknown[]) => void } }).console;
  if (consoleObj && typeof consoleObj.error === 'function') {
    const prevConsoleError = consoleObj.error.bind(consoleObj);
    consoleObj.error = (...args: unknown[]): void => {
      const first = args[0];
      if (currentTestHandle && first instanceof Error) {
        if (!currentTestHandle.failed) {
          currentTestHandle.failed = first;
        }
        // Still log to plain console.log so the dev sees what happened.
        try {
          (globalThis as unknown as { console: { log: (m: string) => void } }).console.log(
            `[wpt: absorbed late-error from test "${'name' in (currentTestHandle as unknown as { name?: string }) ? '' : ''}"] ${first.name}: ${first.message}`
          );
        } catch {
          // ignore
        }
        return;
      }
      prevConsoleError(...args);
    };
  }
})();

export async function runAllTests(_unused?: { video: HTMLVideoElement }, options: RunOptions = {}): Promise<TestResult[]> {
  // (Late-error hooks are installed at module load — see top of file.)
  // Probe whether any camera is present so the AssertionError sentinels in
  // WPT bodies that swallow NotFoundError can still be recognized as
  // environment-skips. The probe is intentionally minimal — a single
  // gUM({video:true}) — and isolated from the test environment reset.
  try {
    const probeStream = await (
      navigator as unknown as {
        mediaDevices: { getUserMedia: (c: { video: boolean }) => Promise<{ getTracks: () => { stop: () => void }[] }> };
      }
    ).mediaDevices.getUserMedia({ video: true });
    for (const t of probeStream.getTracks()) t.stop();
    noCameraEnvironment = false;
  } catch (e) {
    noCameraEnvironment = (e as { name?: string })?.name === 'NotFoundError';
  }

  const results: TestResult[] = [];
  const total = tests.length;

  for (let i = 0; i < tests.length; i++) {
    const entry = tests[i];
    options.resetEnvironment?.();
    options.onStart?.({ name: entry.name, source: entry.source, group: entry.group }, i, total);

    // Pre-skip tests whose source needs unsupported browser features.
    const sourceSkipReason = entry.source ? ENV_SKIPPED_SOURCES.get(entry.source) : undefined;
    if (sourceSkipReason !== undefined) {
      const result: TestResult = {
        name: entry.name,
        status: 'skip',
        message: sourceSkipReason,
        durationMs: 0,
        source: entry.source,
        group: entry.group,
      };
      results.push(result);
      emit(`WPT_RESULT: ${JSON.stringify(result)}`);
      options.onResult?.(result, i, total);
      continue;
    }
    // Per-test name skip — for individual tests within a source file that
    // depend on something we never ship.
    const perTestSkipReason = ENV_SKIPPED_TEST_NAMES.get(entry.name);
    if (perTestSkipReason !== undefined) {
      const result: TestResult = {
        name: entry.name,
        status: 'skip',
        message: perTestSkipReason,
        durationMs: 0,
        source: entry.source,
        group: entry.group,
      };
      results.push(result);
      emit(`WPT_RESULT: ${JSON.stringify(result)}`);
      options.onResult?.(result, i, total);
      continue;
    }

    const t = new TestHandleImpl();
    currentTestHandle = t;
    // Restore the source file so any nested test() / promise_test() calls
    // registered from inside this test body inherit the right source. WPT
    // helpers like `testCapabilities(...)` register sub-tests inside another
    // test's callback.
    currentSourceFile = entry.source;
    currentGroup = entry.group;
    const start = Date.now();
    let result: TestResult;

    try {
      await Promise.race([
        runOne(entry, t),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), DEFAULT_TIMEOUT_MS)
        ),
      ]);
      result = {
        name: entry.name,
        status: 'pass',
        durationMs: Date.now() - start,
        source: entry.source,
        group: entry.group,
      };
    } catch (e) {
      const err = e as Error;
      if (err.message === 'timeout') {
        result = {
          name: entry.name,
          status: 'timeout',
          message: `exceeded ${DEFAULT_TIMEOUT_MS}ms`,
          durationMs: Date.now() - start,
          source: entry.source,
          group: entry.group,
        };
      } else if (isEnvironmentSkip(e)) {
        result = {
          name: entry.name,
          status: 'skip',
          message: `skipped: ${err.message}`,
          durationMs: Date.now() - start,
          source: entry.source,
          group: entry.group,
        };
      } else {
        result = {
          name: entry.name,
          status: 'fail',
          message: err.message || String(e),
          durationMs: Date.now() - start,
          source: entry.source,
          group: entry.group,
        };
      }
    }

    // Always run cleanups; a cleanup failure overrides a passing test.
    for (const cleanup of t.cleanups) {
      try {
        await cleanup();
      } catch (e) {
        if (result.status === 'pass') {
          result = { ...result, status: 'fail', message: `cleanup threw: ${(e as Error).message}` };
        }
      }
    }
    if (t.failed && result.status === 'pass') {
      result = { ...result, status: 'fail', message: t.failed.message };
    }

    results.push(result);
    emit(`WPT_RESULT: ${JSON.stringify(result)}`);
    options.onResult?.(result, i, total);
    // Yield to the host so the UI can render incremental progress and so
    // late setTimeout/event callbacks queued by the just-finished test fire
    // before the next test starts. We keep `currentTestHandle = t` during
    // the yield so the late-error hook attributes errors to this test (the
    // result is already emitted, so the attribution is just for "don't
    // RedBox" — the late error is silently absorbed into t.failed).
    await new Promise<void>((r) => setTimeout(r, 8));
    currentTestHandle = null;
  }

  const summary = {
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    timeout: results.filter((r) => r.status === 'timeout').length,
    skipped: results.filter((r) => r.status === 'skip').length,
  };
  emit(`WPT_DONE: ${JSON.stringify(summary)}`);
  return results;
}

async function runOne(entry: TestEntry, t: TestHandleImpl): Promise<void> {
  switch (entry.type) {
    case 'sync': {
      const r = entry.fn(t);
      if (r instanceof Promise) {
        await r;
      }
      return;
    }
    case 'async-promise': {
      await entry.fn(t);
      return;
    }
    case 'async-callback': {
      await new Promise<void>((resolve, reject) => {
        t.doneSignal = (): void => {
          if (t.failed) {
            reject(t.failed);
          } else {
            resolve();
          }
        };
        try {
          const r = entry.fn(t);
          if (r instanceof Promise) {
            // Some async_test() variants still return a promise; let it surface
            // errors but rely on t.done() to actually complete.
            r.catch(reject);
          }
        } catch (e) {
          reject(e as Error);
        }
      });
    }
  }
}

export function getRegisteredTestCount(): number {
  return tests.length;
}

// For tests that need a one-shot await on a DOM event.
export function nextEvent<T extends Event = Event>(
  target: EventTarget,
  type: string,
  timeoutMs = 5000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onEvent = (e: Event): void => {
      target.removeEventListener(type, onEvent as EventListener);
      clearTimeout(handle);
      resolve(e as T);
    };
    const handle = setTimeout(() => {
      target.removeEventListener(type, onEvent as EventListener);
      reject(new Error(`Timed out waiting for "${type}" event after ${timeoutMs}ms`));
    }, timeoutMs);
    target.addEventListener(type, onEvent as EventListener);
  });
}

// @ref LLP 0007#harness-surface — emit one line of CLI-parseable output
// through both console.log (visible in Debug builds) and native NSLog (visible
// in Release builds, where RN's console is not bridged to os_log).
function emit(line: string): void {
  console.log(line);
  try {
    NativeModule.__systemLogForTesting(line);
  } catch {
    // ignore — native helper might not be registered in non-iOS contexts
  }
}
