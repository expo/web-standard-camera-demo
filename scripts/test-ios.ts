#!/usr/bin/env bun
// @ref LLP 0007 — CLI: run WPT tests on an iOS 26 simulator or a connected
// physical iPhone, then clean up.
//
// Usage:
//   bun run test:ios                    # iOS 26 simulator (default)
//   bun run test:ios --device           # first connected iPhone via devicectl
//   bun run test:ios --device <name|udid>
//
// `--device` requires the app to be pre-installed (e.g. via
// `bunx expo run:ios --device <udid>` once). The script does not build.

import { spawn } from 'bun';
import { unlink } from 'node:fs/promises';

const APP_BUNDLE_ID = 'dev.ide.standardcameraapp';
const URL_SCHEME = 'standardcameraapp';
const DEFAULT_DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro';
const TEST_DEVICE_NAME = 'standard-camera-test';
const LOG_TIMEOUT_MS = 300_000;
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
  // Added by testharness.ts: applicability breakdown. Older builds without
  // these fields still parse and display the legacy summary line.
  total?: number;
  applicable?: number;
  outOfScope?: number;
  deviceMissing?: number;
  environment?: { hasCamera: boolean; hasMicrophone: boolean };
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error('test:ios failed:', (e as Error).message);
    process.exit(1);
  });

async function main(): Promise<number> {
  const target = parseTarget(process.argv.slice(2));
  if (target.kind === 'device') {
    return runOnDevice(target.identifier);
  }
  return runOnSimulator();
}

type RunTarget =
  | { kind: 'simulator' }
  | { kind: 'device'; identifier?: string };

function parseTarget(args: string[]): RunTarget {
  const idx = args.indexOf('--device');
  if (idx < 0) return { kind: 'simulator' };
  const next = args[idx + 1];
  // `--device <id>` if the next arg isn't another flag, else "any connected".
  const identifier = next && !next.startsWith('--') ? next : undefined;
  return { kind: 'device', identifier };
}

async function runOnSimulator(): Promise<number> {
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

    // @ref LLP 0007#cli-flow — grant camera + microphone so
    // AVCaptureDevice.requestAccess returns true for both kinds.
    // @ref LLP 0009#audio-permission
    await sh(['xcrun', 'simctl', 'privacy', udid, 'grant', 'camera', APP_BUNDLE_ID]).catch(
      () => console.warn('Could not grant camera permission (may already be granted)')
    );
    await sh(['xcrun', 'simctl', 'privacy', udid, 'grant', 'microphone', APP_BUNDLE_ID]).catch(
      () => console.warn('Could not grant microphone permission (may already be granted)')
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

    printSummary(summary);
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

// MARK: - Device runner (devicectl)

async function runOnDevice(requested: string | undefined): Promise<number> {
  const device = await pickConnectedDevice(requested);
  console.log(`Using device: ${device.name} (${device.identifier})`);

  await ensureAppInstalledOnDevice(device.identifier);

  // @ref LLP 0007#cli-flow — Launch with --console to stream the app's
  // stdout/stderr. The app's `emit()` writes WPT_RESULT/WPT_DONE lines via
  // `console.log` (which RN bridges to stdout in dev builds) AND `NSLog`
  // (visible in os_log). For physical devices we rely on console.log; the
  // dev build hosts a Metro bundle whose console.log surfaces here.
  // @ref LLP 0007#cli-flow — Hand the deep link via `--payload-url` so the
  // app's `useLinkingURL()` sees `?autorun=1` at cold-start and the runner
  // auto-fires.
  const payloadUrl = `${URL_SCHEME}:///run-tests?autorun=1`;
  if (VERBOSE) console.log('$', 'xcrun', 'devicectl', 'device', 'process', 'launch', '--device', device.identifier, '--terminate-existing', '--console', '--payload-url', payloadUrl, APP_BUNDLE_ID);
  const proc = spawn({
    cmd: [
      'xcrun',
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      device.identifier,
      '--terminate-existing',
      '--console',
      '--payload-url',
      payloadUrl,
      APP_BUNDLE_ID,
    ],
    stdout: 'pipe',
    stderr: 'inherit',
  });
  console.log('Launched test runner; waiting for results…');

  let summary: ParsedSummary;
  try {
    summary = await parseWPTOutput(proc.stdout as ReadableStream<Uint8Array>);
  } finally {
    // --console blocks until the app exits; SIGTERM is forwarded to the app.
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }

  printSummary(summary);
  return summary.failed === 0 && summary.timeout === 0 ? 0 : 1;
}

interface DeviceInfo {
  identifier: string;
  name: string;
}

async function pickConnectedDevice(requested: string | undefined): Promise<DeviceInfo> {
  const jsonPath = `/tmp/test-ios-devicectl-${process.pid}.json`;
  await sh(['xcrun', 'devicectl', 'list', 'devices', '--json-output', jsonPath]);
  const raw = await Bun.file(jsonPath).text();
  await unlink(jsonPath).catch(() => undefined);
  const parsed = JSON.parse(raw) as {
    result: {
      devices: {
        identifier: string;
        deviceProperties?: { name?: string };
        hardwareProperties?: { productType?: string };
      }[];
    };
  };
  // devicectl's JSON has connectionProperties.tunnelState that flips between
  // "connected"/"disconnected"/"unavailable" depending on whether a personalized
  // tunnel is open. The tunnel auto-(re)connects when we run the launch
  // command, so we don't pre-filter on it — we just need an iPhone that
  // devicectl can see. Unreachable devices fail loudly at launch time.
  const iPhones = parsed.result.devices.filter((d) =>
    (d.hardwareProperties?.productType ?? '').startsWith('iPhone')
  );
  if (iPhones.length === 0) {
    throw new Error(
      'No iPhone found in `xcrun devicectl list devices`. Plug the device in, ' +
        'trust the host, and verify it shows up.'
    );
  }
  if (requested) {
    const match = iPhones.find(
      (d) => d.identifier === requested || (d.deviceProperties?.name ?? '') === requested
    );
    if (!match) {
      const names = iPhones.map((d) => `"${d.deviceProperties?.name}" (${d.identifier})`).join(', ');
      throw new Error(`No iPhone matches "${requested}". Available: ${names}`);
    }
    return { identifier: match.identifier, name: match.deviceProperties?.name ?? match.identifier };
  }
  const first = iPhones[0];
  return { identifier: first.identifier, name: first.deviceProperties?.name ?? first.identifier };
}

async function ensureAppInstalledOnDevice(deviceId: string): Promise<void> {
  const jsonPath = `/tmp/test-ios-apps-${process.pid}.json`;
  try {
    await sh([
      'xcrun',
      'devicectl',
      'device',
      'info',
      'apps',
      '--device',
      deviceId,
      '--json-output',
      jsonPath,
    ]);
  } catch {
    throw new Error(
      `Could not query installed apps on device ${deviceId}. ` +
        `Verify the device is reachable: xcrun devicectl list devices.`
    );
  }
  const raw = await Bun.file(jsonPath).text();
  await unlink(jsonPath).catch(() => undefined);
  const parsed = JSON.parse(raw) as { result?: { apps?: { bundleIdentifier: string }[] } };
  // devicectl's `info apps` has no bundle-id filter — fetch the whole list
  // and look for ours.
  const found = parsed.result?.apps?.some((a) => a.bundleIdentifier === APP_BUNDLE_ID) ?? false;
  if (!found) {
    throw new Error(
      `App ${APP_BUNDLE_ID} is not installed on device ${deviceId}.\n` +
        `Run 'bunx expo run:ios --device ${deviceId}' to build and install.`
    );
  }
  if (VERBOSE) console.log('App is installed on the device');
}

// MARK: - Shared summary printing

function printSummary(summary: ParsedSummary): void {
  console.log('');
  // Subtract pre-skipped tests (out-of-scope + device-missing) from the
  // headline skip count so the visible "X skipped" only reflects runtime
  // skips — the in-flight NotFoundError fallback for tests we couldn't
  // pre-classify. Pre-skipped tests are surfaced separately so they read
  // as "not applicable" rather than "broken".
  const totalSkipped = summary.skipped ?? 0;
  const preSkipped = (summary.outOfScope ?? 0) + (summary.deviceMissing ?? 0);
  const runtimeSkipped = Math.max(0, totalSkipped - preSkipped);
  if (summary.total != null && summary.applicable != null) {
    const where = summary.environment
      ? describeEnvironment(summary.environment)
      : 'this host';
    console.log(
      `Summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.timeout} timeout` +
        (runtimeSkipped > 0 ? `, ${runtimeSkipped} skipped` : '') +
        ` — ${summary.applicable} applicable on ${where} / ${summary.total} total`
    );
    const parts: string[] = [];
    if ((summary.outOfScope ?? 0) > 0) parts.push(`${summary.outOfScope} out of scope`);
    if ((summary.deviceMissing ?? 0) > 0) parts.push(`${summary.deviceMissing} device-missing`);
    if (parts.length > 0) console.log(`Not applicable: ${parts.join(' · ')}`);
  } else {
    console.log(
      `Summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.timeout} timeout` +
        (totalSkipped > 0 ? `, ${totalSkipped} skipped` : '')
    );
  }
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

function describeEnvironment(env: { hasCamera: boolean; hasMicrophone: boolean }): string {
  if (env.hasCamera && env.hasMicrophone) return 'this device';
  if (env.hasCamera) return 'this device (no microphone)';
  if (env.hasMicrophone) return 'simulator (microphone only)';
  return 'simulator';
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
