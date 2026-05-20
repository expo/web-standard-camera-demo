// @ref LLP 0007 — testharness.js subset
//
// A minimal port of the WPT testharness API. Tests register via test() /
// promise_test() and the runner executes them sequentially. Each test
// receives a shared HTMLVideoElement-shaped ref the test screen provides.
// Results are emitted to console with WPT_RESULT / WPT_DONE prefixes so the
// CLI driver (scripts/test-ios.ts) can parse them out of the simulator log.

import type { HTMLVideoElement } from '../HTMLVideoElement';

export type TestContext = {
  video: HTMLVideoElement;
};

type TestEntry = {
  name: string;
  fn: (ctx: TestContext) => void | Promise<void>;
  type: 'sync' | 'async';
};

const tests: TestEntry[] = [];

export function test(fn: (ctx: TestContext) => void, name: string): void {
  tests.push({ name, fn, type: 'sync' });
}

export function promise_test(
  fn: (ctx: TestContext) => Promise<void>,
  name: string
): void {
  tests.push({ name, fn, type: 'async' });
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

export type TestResult = {
  name: string;
  status: 'pass' | 'fail' | 'timeout';
  message?: string;
  durationMs: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

export async function runAllTests(ctx: TestContext): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const entry of tests) {
    const start = Date.now();
    let result: TestResult;

    // Reset state between tests.
    if (ctx.video.srcObject) {
      try {
        for (const t of ctx.video.srcObject.getTracks()) t.stop();
      } catch {
        // ignore
      }
      ctx.video.srcObject = null;
    }

    try {
      await Promise.race([
        Promise.resolve().then(() => entry.fn(ctx)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), DEFAULT_TIMEOUT_MS)
        ),
      ]);
      result = { name: entry.name, status: 'pass', durationMs: Date.now() - start };
    } catch (e) {
      const err = e as Error;
      if (err.message === 'timeout') {
        result = {
          name: entry.name,
          status: 'timeout',
          message: `exceeded ${DEFAULT_TIMEOUT_MS}ms`,
          durationMs: Date.now() - start,
        };
      } else {
        result = {
          name: entry.name,
          status: 'fail',
          message: err.message || String(e),
          durationMs: Date.now() - start,
        };
      }
    }

    results.push(result);
    // @ref LLP 0007#reporter — line format the CLI parses
    console.log(`WPT_RESULT: ${JSON.stringify(result)}`);
  }

  const summary = {
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    timeout: results.filter((r) => r.status === 'timeout').length,
  };
  console.log(`WPT_DONE: ${JSON.stringify(summary)}`);
  return results;
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
      clearTimeout(t);
      resolve(e as T);
    };
    const t = setTimeout(() => {
      target.removeEventListener(type, onEvent as EventListener);
      reject(new Error(`Timed out waiting for "${type}" event after ${timeoutMs}ms`));
    }, timeoutMs);
    target.addEventListener(type, onEvent as EventListener);
  });
}
