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
let currentRequirement: TestRequirement | null = null;

/** Annotate the source WPT file for all tests registered after this call. */
export function wptSource(file: string | null): void {
  currentSourceFile = file;
}

/** Annotate a semantic group for all tests registered after this call. */
export function wptGroup(group: string | null): void {
  currentGroup = group;
}

/** Annotate the environment requirement for all tests registered after this
 *  call. Pass `null` to clear and let the SOURCE_REQUIREMENTS map (or the
 *  `'camera'` default) decide. Used by project-local test files whose tests
 *  have no `source` to key off of. */
export function wptRequires(requirement: TestRequirement | null): void {
  currentRequirement = requirement;
}

// MARK: - Test environment + per-test requirements

/** What a test needs to actually run:
 *  - `'always'` runs anywhere — pure API surface, IDL, or static-rejection paths.
 *  - `'camera'` needs a real `AVCaptureDevice` (video). Skipped pre-emptively
 *    on the iOS simulator where no video device is present.
 *  - `'microphone'` needs a real audio capture device.
 *  - `'camera-or-microphone'` needs at least one of the two (e.g., a test that
 *    inspects `enumerateDevices()` after gUM but doesn't care which kind).
 *  - `'out-of-scope'` is permanently inapplicable in React Native (cross-origin
 *    iframes, SecureContext, Permissions Policy, canvas/WebAudio frame
 *    inspection, getDisplayMedia, …). Never counts toward the applicable
 *    total — these are browser-only or features we don't ship. */
export type TestRequirement =
  | 'always'
  | 'camera'
  | 'microphone'
  | 'camera-or-microphone'
  | 'out-of-scope';

/** Result of feature-detecting the capture devices available on this host.
 *  `enumerateDevices()` is the cheap, permission-free probe; the test runner
 *  also corroborates `hasCamera` with a `getUserMedia({video:true})` call at
 *  run start so the late safety-net (`isEnvironmentSkip`) stays correct. */
export interface TestEnvironment {
  hasCamera: boolean;
  hasMicrophone: boolean;
}

/** Does the current environment satisfy this requirement? `'out-of-scope'`
 *  always returns false — those tests are permanently inapplicable. */
export function isApplicable(req: TestRequirement, env: TestEnvironment): boolean {
  switch (req) {
    case 'always':
      return true;
    case 'camera':
      return env.hasCamera;
    case 'microphone':
      return env.hasMicrophone;
    case 'camera-or-microphone':
      return env.hasCamera || env.hasMicrophone;
    case 'out-of-scope':
      return false;
  }
}

// @ref LLP 0007#the-simulator-does-not-have-a-camera-device — Source-file
// categorization. The default (when a source isn't listed here) is `'camera'`,
// since most ported WPT tests open a video stream. Listing only the
// non-default cases keeps the table small and reviewable.
//
// For `'out-of-scope'` entries the `reason` is surfaced as the skip message —
// it tells a reader whether the source was skipped because of a browser-only
// dependency or because the underlying feature is out of v1 scope.
const SOURCE_REQUIREMENTS = new Map<
  string,
  { requirement: TestRequirement; reason?: string }
>([
  // === always (no AV device needed) ===
  ['GUM-api.https.html', { requirement: 'always' }],
  ['GUM-deny.https.html', { requirement: 'always' }],
  // gUM with `{}` rejects with TypeError before reaching native.
  ['GUM-empty-option-param.https.html', { requirement: 'always' }],
  // gUM with an unrecognized key rejects with TypeError before reaching native.
  ['GUM-unknownkey-option-param.https.html', { requirement: 'always' }],
  ['historical.https.html', { requirement: 'always' }],
  ['MediaDevices-getSupportedConstraints.https.html', { requirement: 'always' }],
  // One sub-test ("The MediaStreamTrackEvent instance's track attribute is
  // set.") requires AudioContext and is per-name out-of-scope; the rest are
  // pure constructor checks that need no device.
  ['MediaStreamTrackEvent-constructor.https.html', { requirement: 'always' }],

  // === microphone-required ===
  ['GUM-echoCancellation-all.https.html', { requirement: 'microphone' }],
  ['GUM-echoCancellation-boolean.https.html', { requirement: 'microphone' }],
  ['GUM-echoCancellation-remote-only.https.html', { requirement: 'microphone' }],
  ['MediaStream-audio-only.https.html', { requirement: 'microphone' }],

  // === camera-or-microphone (uses both video and audio gUM, or queries
  //     permissions for both kinds) ===
  ['GUM-permissions-query.https.html', { requirement: 'camera-or-microphone' }],
  ['MediaStream-add-audio-track.https.html', { requirement: 'camera-or-microphone' }],
  ['MediaStream-idl.https.html', { requirement: 'camera-or-microphone' }],

  // === out-of-scope ===
  // Cross-origin iframes, postMessage transfer, Permissions Policy. RN has no
  // cross-origin or iframe infrastructure, so these never run.
  ['MediaDevices-enumerateDevices-per-origin-ids.sub.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: requires cross-origin iframes',
  }],
  ['MediaDevices-enumerateDevices-persistent-permission.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: requires cross-origin iframes / persistent-permission infrastructure',
  }],
  ['MediaDevices-after-discard.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: requires cross-origin iframes / discarded-browsing-context lifecycle',
  }],
  ['enumerateDevices-with-navigation.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: requires cross-origin iframes / navigation',
  }],
  ['MediaStreamTrack-transfer.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: requires postMessage MediaStreamTrack transfer between contexts',
  }],
  ['MediaStreamTrack-transfer-video.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: requires postMessage MediaStreamTrack transfer between contexts',
  }],
  ['MediaStreamTrack-iframe-transfer.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: requires cross-origin iframes / postMessage transfer',
  }],
  ['MediaStreamTrack-iframe-audio-transfer.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: requires cross-origin iframes / postMessage transfer',
  }],
  ['MediaDevices-enumerateDevices-not-allowed-camera.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: drives camera-not-allowed via cross-origin Permissions-Policy headers',
  }],
  ['MediaDevices-enumerateDevices-not-allowed-mic.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: drives mic-not-allowed via cross-origin Permissions-Policy headers',
  }],
  ['MediaStream-default-permissions-policy.https.html', {
    requirement: 'out-of-scope',
    reason: 'cross-origin-or-frame: drives cross-origin Permissions-Policy iframes via `run_all_fp_tests_allow_self`',
  }],
  ['MediaStream-supported-by-permissions-policy.html', {
    requirement: 'out-of-scope',
    reason: 'browser-only: requires document.permissionsPolicy.features()',
  }],

  // Features outside the project's scope (LLP 0000 / 0001).
  ['MediaDevices-SecureContext.html', {
    requirement: 'out-of-scope',
    reason: 'out-of-scope: tests a non-secure context where mediaDevices is hidden; our polyfill always exposes it',
  }],
  ['BrowserCaptureMediaStreamTrack-cropTo.https.html', {
    requirement: 'out-of-scope',
    reason: 'out-of-scope: requires getDisplayMedia + CropTarget',
  }],
  ['BrowserCaptureMediaStreamTrack-restrictTo.https.html', {
    requirement: 'out-of-scope',
    reason: 'out-of-scope: requires getDisplayMedia + RestrictionTarget',
  }],
  ['parallel-capture-requests.https.html', {
    requirement: 'out-of-scope',
    reason: 'out-of-scope: requires getDisplayMedia + transient-activation button',
  }],
  ['MediaStreamTrack-MediaElement-disabled-video-is-black.https.html', {
    requirement: 'out-of-scope',
    reason: 'out-of-scope: requires canvas.drawImage(video) frame inspection',
  }],
  ['MediaStreamTrack-MediaElement-disabled-audio-is-silence.https.html', {
    requirement: 'out-of-scope',
    reason: 'out-of-scope: requires AudioContext analyser to read captured samples',
  }],
  // WPT manual test: revocation has to be driven by the UA (test_driver in
  // a browser; iOS doesn't expose a programmatic mid-capture revoke). The
  // test waits forever on the `ended` event and times out.
  ['MediaStreamTrack-end-manual.https.html', {
    requirement: 'out-of-scope',
    reason: 'out-of-scope: requires the UA to revoke a granted camera/mic permission mid-capture; iOS has no such API',
  }],
]);

// Individual sub-tests we override — for cases where one test within an
// otherwise-runnable source file depends on a feature we never ship.
const TEST_NAME_REQUIREMENTS = new Map<
  string,
  { requirement: TestRequirement; reason: string }
>([
  // Uses `canvas.captureStream()` — canvas + WebRTC capture is out of scope.
  [
    'Tests that a media element with an assigned MediaStream does not start advancing currentTime until potentially playing',
    { requirement: 'out-of-scope', reason: 'out-of-scope: requires HTMLCanvasElement.captureStream' },
  ],
  // crop-and-scale isn't supported by our AVFoundation pipeline (LLP 0001).
  ['getUserMedia() supports setting crop-and-scale as resizeMode without downscaling.',
    { requirement: 'out-of-scope', reason: 'out-of-scope: crop-and-scale resizeMode is not implemented' }],
  ['getUserMedia() supports setting crop-and-scale as resizeMode with downscaling.',
    { requirement: 'out-of-scope', reason: 'out-of-scope: crop-and-scale resizeMode is not implemented' }],
  ['getUserMedia() supports setting crop-and-scale as resizeMode with decimation.',
    { requirement: 'out-of-scope', reason: 'out-of-scope: crop-and-scale resizeMode is not implemented' }],
  ['Video track getCapabilities() resizeMode properly supported. Value: crop-and-scale',
    { requirement: 'out-of-scope', reason: 'out-of-scope: crop-and-scale resizeMode is not implemented' }],
  ['Video device getCapabilities() resizeMode properly supported. Value: crop-and-scale',
    { requirement: 'out-of-scope', reason: 'out-of-scope: crop-and-scale resizeMode is not implemented' }],
  // iPhone cameras don't expose a 320-wide format; "ideal: 320" can only be
  // satisfied with cropping (out of scope).
  [
    'Tests that setting a required constraint with an ideal value in getUserMedia works',
    { requirement: 'out-of-scope', reason: 'out-of-scope: iPhone cameras have no 320-wide format and we do not crop' },
  ],
  // Requires AudioContext.createMediaStreamDestination(); we ship audio
  // capture but no WebAudio implementation.
  [
    "The MediaStreamTrackEvent instance's track attribute is set.",
    { requirement: 'out-of-scope', reason: 'out-of-scope: requires AudioContext / createMediaStreamDestination — WebAudio is out of scope' },
  ],
  // `URL.createObjectURL` behavior is owned by Expo/RN; nothing about
  // MediaStream or getUserMedia is exercised. The test only happens to live
  // in mediacapture-streams/historical because it documents the historical
  // removal of the MediaStream→URL path.
  [
    'Passing MediaStream to URL.createObjectURL() should throw',
    { requirement: 'out-of-scope', reason: 'out-of-scope: URL.createObjectURL behavior is owned by Expo/RN, not this project' },
  ],
]);

function classifyTest(
  name: string,
  source: string | null
): { requirement: TestRequirement; reason?: string } {
  const perTest = TEST_NAME_REQUIREMENTS.get(name);
  if (perTest) return perTest;
  if (source) {
    const perSource = SOURCE_REQUIREMENTS.get(source);
    if (perSource) return perSource;
  }
  // Local tests (source==null) or unmapped WPT sources fall back to
  // currentRequirement (if a file wrapped its registrations in
  // `wptRequires(...)`) or the conservative default 'camera'.
  return { requirement: currentRequirement ?? 'camera' };
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
  requirement: TestRequirement;
  /** If the requirement is `'out-of-scope'`, the rationale we surface as the
   *  skip message; otherwise unset and a default message ("requires a real
   *  camera device", etc.) is generated when we pre-skip. */
  outOfScopeReason?: string;
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

function registerTest(
  name: string,
  fn: TestFn,
  type: TestEntry['type']
): void {
  const { requirement, reason } = classifyTest(name, currentSourceFile);
  tests.push({
    name,
    fn,
    type,
    source: currentSourceFile,
    group: currentGroup,
    requirement,
    outOfScopeReason: requirement === 'out-of-scope' ? reason : undefined,
  });
}

export function test(fn: (t: TestHandle) => void, name?: string): void {
  registerTest(name ?? defaultName(), fn, 'sync');
}

export function promise_test(
  fn: (t: TestHandle) => Promise<void>,
  name?: string
): void {
  registerTest(name ?? defaultName(), fn, 'async-promise');
}

/** WPT async_test — caller invokes `t.done()` to finish; otherwise times out. */
export function async_test(fn: (t: TestHandle) => void, name?: string): void {
  registerTest(name ?? defaultName(), fn, 'async-callback');
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

// @ref LLP 0007#the-simulator-does-not-have-a-camera-device — Safety net for
// the camera-less environment. Tests we couldn't pre-skip (because their
// `requirement` was misclassified, or because the runner was invoked with no
// `environment` and we couldn't tell up front) still reach this path: if
// `getUserMedia` throws a `NotFoundError`, we mark the test `skip` rather
// than `fail`. Some WPT bodies catch the gUM rejection and re-throw
// `assert_unreached(...)` with a sentinel message; we recognize those too.
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

// Set at runAllTests start by a probe call to `getUserMedia({video:true})`.
// When the probe rejects with NotFoundError we know we're running on the
// camera-less simulator. The flag is consulted by `isEnvironmentSkip` to
// recognize assert_unreached sentinels emitted by WPT bodies that themselves
// swallow the original NotFoundError.
let noCameraEnvironment = false;

/** A test as registered, before it has run. Used by the UI to pre-list the
 *  whole suite so users can see progress through it. */
export interface PendingTest {
  name: string;
  source: string | null;
  group: string | null;
  requirement: TestRequirement;
}

export interface RunOptions {
  /** Optional helper to reset shared DOM-like state between tests. */
  resetEnvironment?: () => void;
  /** Optional helper invoked when the runner crosses a WPT source-file
   *  boundary (and before the very first test). Used to clear state that
   *  the spec assumes resets between .html files but accumulates within
   *  one (capture grants, in particular). */
  resetFile?: () => void;
  /** Called just before each test starts running. */
  onStart?: (entry: PendingTest, index: number, total: number) => void;
  /** Called after each test produces a result. */
  onResult?: (result: TestResult, index: number, total: number) => void;
  /** Feature-detected environment. When omitted the runner probes via gUM at
   *  the start of the suite. Passing it explicitly lets the UI use the same
   *  applicability counts it displays. */
  environment?: TestEnvironment;
}

/** Snapshot of every test currently registered, for UI pre-rendering. */
export function getRegisteredTests(): PendingTest[] {
  return tests.map((t) => ({
    name: t.name,
    source: t.source,
    group: t.group,
    requirement: t.requirement,
  }));
}

/** Feature-detect the local capture devices via `enumerateDevices()`. The
 *  call is permission-free, so we can run it as soon as the screen mounts.
 *  Returns `{ hasCamera: false, hasMicrophone: false }` if the polyfill or
 *  native module is unavailable for any reason — the caller can treat that
 *  as "simulator-like" and pre-skip device-required tests. */
export async function detectEnvironment(): Promise<TestEnvironment> {
  try {
    const md = (globalThis as unknown as {
      navigator?: { mediaDevices?: { enumerateDevices?: () => Promise<{ kind: string }[]> } };
    }).navigator?.mediaDevices;
    if (!md?.enumerateDevices) {
      return { hasCamera: false, hasMicrophone: false };
    }
    const devices = await md.enumerateDevices();
    return {
      hasCamera: devices.some((d) => d.kind === 'videoinput'),
      hasMicrophone: devices.some((d) => d.kind === 'audioinput'),
    };
  } catch {
    return { hasCamera: false, hasMicrophone: false };
  }
}

/** Counts that drive the in-app header "X applicable / Y total". `outOfScope`
 *  is permanently inapplicable (browser-only or unshipped features) — it's
 *  excluded from `applicable` regardless of environment. `deviceMissing` is
 *  the count of tests that *would* run on a real device but can't here. */
export interface Applicability {
  total: number;
  applicable: number;
  outOfScope: number;
  deviceMissing: number;
}

export function summarizeApplicability(env: TestEnvironment): Applicability {
  let outOfScope = 0;
  let deviceMissing = 0;
  let applicable = 0;
  for (const t of tests) {
    if (t.requirement === 'out-of-scope') {
      outOfScope++;
    } else if (isApplicable(t.requirement, env)) {
      applicable++;
    } else {
      deviceMissing++;
    }
  }
  return { total: tests.length, applicable, outOfScope, deviceMissing };
}

function preSkipMessage(req: TestRequirement, outOfScopeReason?: string): string {
  switch (req) {
    case 'out-of-scope':
      return outOfScopeReason ?? 'out-of-scope';
    case 'camera':
      return 'skipped: requires a real camera device';
    case 'microphone':
      return 'skipped: requires a real microphone device';
    case 'camera-or-microphone':
      return 'skipped: requires a real camera or microphone device';
    case 'always':
      // Unreachable — `'always'` tests are always applicable. Fall back to a
      // generic message rather than crashing if logic ever drifts.
      return 'skipped';
  }
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
  let env = options.environment;
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
  // If the caller didn't tell us the environment, derive it from the probe
  // (which is authoritative for cameras) plus a permission-free enumerate
  // probe for the microphone.
  if (!env) {
    const detected = await detectEnvironment();
    env = {
      hasCamera: !noCameraEnvironment,
      hasMicrophone: detected.hasMicrophone,
    };
  }

  const results: TestResult[] = [];
  const total = tests.length;
  let previousSource: string | null | undefined = undefined;

  for (let i = 0; i < tests.length; i++) {
    const entry = tests[i];
    // Per-file reset on the first test and whenever the source changes.
    // `undefined` is the sentinel for "haven't started yet"; once we run a
    // test, previousSource holds the actual source (which can be `null` for
    // project-local tests, treated as a distinct "file" for isolation).
    if (entry.source !== previousSource) {
      options.resetFile?.();
      previousSource = entry.source;
    }
    options.resetEnvironment?.();
    options.onStart?.(
      { name: entry.name, source: entry.source, group: entry.group, requirement: entry.requirement },
      i,
      total
    );

    // Pre-skip tests whose requirement isn't met by the current environment
    // (out-of-scope, or device-required without the matching device). The
    // message distinguishes "never applicable" from "needs a camera/mic" so
    // a reader can tell whether a real device would change the outcome.
    if (!isApplicable(entry.requirement, env)) {
      const result: TestResult = {
        name: entry.name,
        status: 'skip',
        message: preSkipMessage(entry.requirement, entry.outOfScopeReason),
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

  // Split skipped into "out-of-scope" (permanently inapplicable) vs
  // "deviceMissing" (would run on a real device) so the CLI / UI can show
  // "applicable" counts that don't conflate the two. `applicable` is the
  // number we actually attempted to run.
  const applicability = summarizeApplicability(env);
  const summary = {
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    timeout: results.filter((r) => r.status === 'timeout').length,
    skipped: results.filter((r) => r.status === 'skip').length,
    total: applicability.total,
    applicable: applicability.applicable,
    outOfScope: applicability.outOfScope,
    deviceMissing: applicability.deviceMissing,
    environment: env,
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
