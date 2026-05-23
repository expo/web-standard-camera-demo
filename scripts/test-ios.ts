#!/usr/bin/env bun
// @ref LLP 0007 — CLI: boot iOS 26 sim, run WPT tests, shut down.
//
// Usage: bun run test:ios

import { spawn } from 'bun';

const APP_BUNDLE_ID = 'dev.ide.standardcameraapp';
const URL_SCHEME = 'standardcameraapp';
const DEFAULT_DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro';
const TEST_DEVICE_NAME = 'standard-camera-test';
const LOG_TIMEOUT_MS = 120_000;
const VERBOSE = process.env.VERBOSE === '1';

interface ParsedResult {
  name: string;
  status: 'pass' | 'fail' | 'timeout' | 'skip';
  message?: string;
  durationMs: number;
}

interface ParsedSummary {
  passed: number;
  failed: number;
  timeout: number;
  skipped?: number;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error('test:ios failed:', (e as Error).message);
    process.exit(1);
  });

async function main(): Promise<number> {
  const runtimeId = await pickIOS26Runtime();
  console.log(`Using runtime: ${runtimeId}`);

  const udid = await getOrCreateDevice(runtimeId);
  console.log(`Using simulator: ${udid}`);

  const shouldShutdownOnExit = !(await isBooted(udid));

  let exitCode = 1;
  try {
    if (shouldShutdownOnExit) {
      await sh(['xcrun', 'simctl', 'boot', udid]);
      console.log('Booted simulator');
    } else {
      console.log('Simulator already booted; will leave it running on exit');
    }

    // Ensure the build is installed; bail with a clear error if not.
    await ensureAppInstalled(udid);

    // @ref LLP 0007#cli-flow — grant camera so AVCaptureDevice.requestAccess returns true
    await sh(['xcrun', 'simctl', 'privacy', udid, 'grant', 'camera', APP_BUNDLE_ID]).catch(
      () => console.warn('Could not grant camera permission (may already be granted)')
    );

    // Terminate any prior instance so launch is clean.
    await sh(['xcrun', 'simctl', 'terminate', udid, APP_BUNDLE_ID]).catch(() => undefined);

    // Start the log stream FIRST so we don't miss early WPT_RESULT lines.
    const logProc = startLogStream(udid);

    // iOS 26 simulator: `simctl openurl` does not reliably cold-launch the app.
    // Explicitly launch the bundle first, then deep-link to the test runner.
    // The launch alone navigates to `/index`; the openurl then switches the
    // tab via Expo Router's URL handler.
    await sh(['xcrun', 'simctl', 'launch', udid, APP_BUNDLE_ID]).catch(() => undefined);
    await sleep(1500);
    await sh(['xcrun', 'simctl', 'openurl', udid, `${URL_SCHEME}:///run-tests?autorun=1`]);
    console.log('Opened test URL; waiting for results…');

    const summary = await parseWPTOutput(logProc.stdout);
    try {
      logProc.kill();
    } catch {
      // ignore
    }

    console.log('');
    const skipped = summary.skipped ?? 0;
    console.log(
      `Summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.timeout} timeout` +
        (skipped > 0 ? `, ${skipped} skipped` : '')
    );
    // Skips are environment-blocked (e.g. simulator has no AVCaptureDevice), not regressions.
    exitCode = summary.failed === 0 && summary.timeout === 0 ? 0 : 1;
  } finally {
    if (shouldShutdownOnExit) {
      await sh(['xcrun', 'simctl', 'shutdown', udid]).catch(() => undefined);
      console.log('Shut down simulator');
    }
  }
  return exitCode;
}

// MARK: - Simulator helpers

async function pickIOS26Runtime(): Promise<string> {
  const out = await capture(['xcrun', 'simctl', 'list', 'runtimes', '--json']);
  const list = JSON.parse(out) as {
    runtimes: { identifier: string; version: string; isAvailable: boolean }[];
  };
  const candidates = list.runtimes.filter(
    (r) => r.isAvailable && r.identifier.includes('iOS-26')
  );
  if (candidates.length === 0) {
    throw new Error(
      'No iOS 26 runtime found. Install one via Xcode → Settings → Components.'
    );
  }
  // Prefer the highest version string.
  candidates.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return candidates[candidates.length - 1].identifier;
}

async function getOrCreateDevice(runtimeId: string): Promise<string> {
  const out = await capture(['xcrun', 'simctl', 'list', 'devices', '--json']);
  const data = JSON.parse(out) as { devices: Record<string, { udid: string; name: string }[]> };
  for (const list of Object.values(data.devices)) {
    for (const d of list) {
      if (d.name === TEST_DEVICE_NAME) return d.udid;
    }
  }
  // Create a fresh device.
  const udid = (
    await capture(['xcrun', 'simctl', 'create', TEST_DEVICE_NAME, DEFAULT_DEVICE_TYPE, runtimeId])
  ).trim();
  console.log(`Created simulator ${TEST_DEVICE_NAME} (${udid})`);
  return udid;
}

async function isBooted(udid: string): Promise<boolean> {
  const out = await capture(['xcrun', 'simctl', 'list', 'devices', '--json']);
  const data = JSON.parse(out) as { devices: Record<string, { udid: string; state: string }[]> };
  for (const list of Object.values(data.devices)) {
    for (const d of list) {
      if (d.udid === udid) return d.state === 'Booted';
    }
  }
  return false;
}

async function ensureAppInstalled(udid: string): Promise<void> {
  try {
    await capture(['xcrun', 'simctl', 'get_app_container', udid, APP_BUNDLE_ID]);
    if (VERBOSE) console.log('App already installed');
  } catch {
    throw new Error(
      `App ${APP_BUNDLE_ID} is not installed on the simulator.\n` +
        `Run 'bunx expo run:ios --device ${udid}' first to build and install.`
    );
  }
}

// MARK: - Log stream parsing

function startLogStream(udid: string): { stdout: ReadableStream<Uint8Array>; kill(): void } {
  const proc = spawn({
    cmd: [
      'xcrun',
      'simctl',
      'spawn',
      udid,
      'log',
      'stream',
      '--predicate',
      'eventMessage CONTAINS "WPT_RESULT:" OR eventMessage CONTAINS "WPT_DONE:"',
      '--style',
      'compact',
    ],
    stdout: 'pipe',
    stderr: 'inherit',
  });
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    kill: () => proc.kill(),
  };
}

async function parseWPTOutput(stream: ReadableStream<Uint8Array>): Promise<ParsedSummary> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let summary: ParsedSummary | null = null;
  const start = Date.now();

  while (Date.now() - start < LOG_TIMEOUT_MS) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ done: true }), 5_000)
      ),
    ]);
    if (done) {
      if (summary) break;
      continue; // poll again
    }
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const handled = handleLine(line);
      if (handled?.summary) {
        summary = handled.summary;
      }
    }
    if (summary) break;
  }

  if (!summary) {
    throw new Error(`Timed out after ${LOG_TIMEOUT_MS}ms waiting for WPT_DONE`);
  }
  return summary;
}

function handleLine(line: string): { summary?: ParsedSummary } | undefined {
  const resultIdx = line.indexOf('WPT_RESULT:');
  if (resultIdx >= 0) {
    const json = unescapeLogOctal(line.slice(resultIdx + 'WPT_RESULT:'.length).trim());
    try {
      const r = JSON.parse(json) as ParsedResult;
      const glyph =
        r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : r.status === 'skip' ? '↷' : '⏱';
      const tail = r.message ? `  ← ${r.message}` : '';
      console.log(`  ${glyph} ${r.name} (${r.durationMs}ms)${tail}`);
    } catch {
      if (VERBOSE) console.log('(unparseable WPT_RESULT line)', line);
    }
    return;
  }
  const doneIdx = line.indexOf('WPT_DONE:');
  if (doneIdx >= 0) {
    const json = unescapeLogOctal(line.slice(doneIdx + 'WPT_DONE:'.length).trim());
    try {
      return { summary: JSON.parse(json) as ParsedSummary };
    } catch {
      // ignore
    }
  }
  return;
}

// `log stream --style compact` encodes non-printable / quoted bytes as octal
// escapes (e.g. `\"` arrives as `\134"`). Reverse that so JSON.parse sees valid
// JSON. We only need to convert `\134` (backslash) and `\012` (newline) since
// those are what our WPT_RESULT payloads can contain.
function unescapeLogOctal(s: string): string {
  return s.replace(/\\134/g, '\\').replace(/\\012/g, '\\n');
}

// MARK: - Process helpers

async function sh(cmd: string[]): Promise<void> {
  if (VERBOSE) console.log('$', cmd.join(' '));
  const proc = spawn({ cmd, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(' ')}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(cmd: string[]): Promise<string> {
  if (VERBOSE) console.log('$', cmd.join(' '));
  const proc = spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`Command failed (${code}): ${cmd.join(' ')}\n${err}`);
  }
  return text;
}
