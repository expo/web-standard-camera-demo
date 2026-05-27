#!/usr/bin/env bun
// @ref LLP 0020#testing-and-validation — Physical-device validation for the
// panoramic WebXR capture flow. The script launches the dev-client app, streams
// device logs, and succeeds only after a manual scan/capture/render/save run
// emits the required panorama telemetry.

import { spawn } from 'bun';
import { unlink } from 'node:fs/promises';

const APP_BUNDLE_ID = 'dev.ide.standardcameraapp';
const URL_SCHEME = 'standardcameraapp';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_METRO_URL = process.env.PANORAMA_METRO_URL ?? 'http://192.168.1.181:8082';
const DEFAULT_ROUTE_URL = `${URL_SCHEME}:///panoramic-scene-capture`;
const REQUIRED_METRICS = [
  'PANORAMIC_KEYFRAME_PROFILE',
  'PANORAMIC_CAPTURE_METRICS',
  'PANORAMIC_RENDER_METRICS',
  'PANORAMIC_EXPORT_METRICS',
] as const satisfies readonly RequiredMetricName[];
const OPTIONAL_METRICS = [
  'PANORAMIC_LIVE_MODEL_PROFILE',
  'PANORAMIC_MODEL_UPLOAD_PROFILE',
] as const satisfies readonly OptionalMetricName[];

type RequiredMetricName =
  | 'PANORAMIC_KEYFRAME_PROFILE'
  | 'PANORAMIC_CAPTURE_METRICS'
  | 'PANORAMIC_RENDER_METRICS'
  | 'PANORAMIC_EXPORT_METRICS';
type OptionalMetricName =
  | 'PANORAMIC_LIVE_MODEL_PROFILE'
  | 'PANORAMIC_MODEL_UPLOAD_PROFILE';
type MetricName = RequiredMetricName | OptionalMetricName;

type SeenMetrics = Partial<Record<MetricName, Record<string, unknown>>>;

interface Options {
  device?: string;
  metroUrl: string;
  noLaunch: boolean;
  routeUrl: string | null;
  timeoutMs: number;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error('validate-panorama-ios failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  });

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const device = await pickConnectedDevice(options.device);
  console.log(`Using device: ${device.name} (${device.identifier})`);
  console.log(`Waiting up to ${(options.timeoutMs / 1000).toFixed(0)}s for panorama telemetry.`);
  console.log('On the phone: Start Scan, pan slowly until surfels appear, Capture, then Save.');

  const logProc = spawn({
    cmd: ['idevicesyslog', '-n', '-p', 'standardcameraapp', '--no-colors'],
    stdout: 'pipe',
    stderr: 'inherit',
  });

  try {
    if (!options.noLaunch) {
      const payloadUrl = `${URL_SCHEME}://expo-development-client/?url=${encodeURIComponent(options.metroUrl)}`;
      await sh([
        'xcrun',
        'devicectl',
        'device',
        'process',
        'launch',
        '--device',
        device.identifier,
        '--terminate-existing',
        '--payload-url',
        payloadUrl,
        APP_BUNDLE_ID,
      ]);
      console.log(`Launched ${APP_BUNDLE_ID} with Metro ${options.metroUrl}`);
      if (options.routeUrl) {
        await sleep(1500);
        await sh([
          'xcrun',
          'devicectl',
          'device',
          'process',
          'launch',
          '--device',
          device.identifier,
          '--payload-url',
          options.routeUrl,
          APP_BUNDLE_ID,
        ]);
        console.log(`Opened panorama route ${options.routeUrl}`);
      }
    }

    const seen = await collectMetrics(logProc, options.timeoutMs);
    printMetricSummary(seen);
    return 0;
  } finally {
    try {
      logProc.kill();
    } catch {
      // ignore
    }
  }
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    metroUrl: DEFAULT_METRO_URL,
    noLaunch: false,
    routeUrl: DEFAULT_ROUTE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--device') {
      options.device = requireValue(args, ++i, arg);
    } else if (arg === '--metro-url') {
      options.metroUrl = requireValue(args, ++i, arg);
    } else if (arg === '--no-launch') {
      options.noLaunch = true;
    } else if (arg === '--no-route') {
      options.routeUrl = null;
    } else if (arg === '--route-url') {
      options.routeUrl = requireValue(args, ++i, arg);
    } else if (arg === '--timeout') {
      options.timeoutMs = Number(requireValue(args, ++i, arg)) * 1000;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  return options;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: bun run scripts/validate-panorama-ios.ts [options]

Options:
  --device <name|id>       CoreDevice identifier or iPhone name.
  --metro-url <url>        Expo dev-server URL. Default: ${DEFAULT_METRO_URL}
  --route-url <url>        App route to open after Metro launch. Default: ${DEFAULT_ROUTE_URL}
  --no-route               Do not deep-link to the panorama route after launch.
  --timeout <seconds>      Validation timeout. Default: ${DEFAULT_TIMEOUT_MS / 1000}
  --no-launch              Do not launch the app; only stream logs.

Success requires these log lines from a physical run:
  PANORAMIC_KEYFRAME_PROFILE, PANORAMIC_CAPTURE_METRICS,
  PANORAMIC_RENDER_METRICS, and PANORAMIC_EXPORT_METRICS.

The validator also prints optional live preview performance telemetry when it
appears: PANORAMIC_LIVE_MODEL_PROFILE and PANORAMIC_MODEL_UPLOAD_PROFILE.`);
}

interface DeviceInfo {
  identifier: string;
  name: string;
}

async function pickConnectedDevice(requested: string | undefined): Promise<DeviceInfo> {
  const jsonPath = `/tmp/validate-panorama-devices-${process.pid}.json`;
  await shQuiet(['xcrun', 'devicectl', 'list', 'devices', '--json-output', jsonPath]);
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
  const iPhones = parsed.result.devices.filter((device) =>
    (device.hardwareProperties?.productType ?? '').startsWith('iPhone')
  );
  if (iPhones.length === 0) {
    throw new Error('No iPhone found in `xcrun devicectl list devices`.');
  }
  const match = requested
    ? iPhones.find((device) => device.identifier === requested || device.deviceProperties?.name === requested)
    : iPhones[0];
  if (!match) {
    const available = iPhones
      .map((device) => `${device.deviceProperties?.name ?? device.identifier} (${device.identifier})`)
      .join(', ');
    throw new Error(`No iPhone matches "${requested}". Available: ${available}`);
  }
  return { identifier: match.identifier, name: match.deviceProperties?.name ?? match.identifier };
}

async function collectMetrics(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<SeenMetrics> {
  const seen: SeenMetrics = {};
  const decoder = new TextDecoder();
  let buffered = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        recordMetricLine(line, seen);
        if (isComplete(seen)) {
          return seen;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw new Error(`Timed out waiting for: ${missingMetrics(seen).join(', ')}`);
  }
  throw new Error(`Log stream ended before telemetry completed. Missing: ${missingMetrics(seen).join(', ')}`);
}

function recordMetricLine(line: string, seen: SeenMetrics): void {
  const match = line.match(/(PANORAMIC_[A-Z_]+)\s+(\{.*\})/);
  if (!match) return;
  const name = match[1] as MetricName;
  if (!isObservedMetric(name)) return;
  const metric = safeParseMetric(match[2] ?? '{}');
  if (!isValidMetric(name, metric)) {
    console.warn(`Ignored invalid ${name}: ${JSON.stringify(metric)}`);
    return;
  }
  seen[name] = metric;
  console.log(`${name} ${JSON.stringify(metric)}`);
}

function safeParseMetric(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isObservedMetric(name: string): name is MetricName {
  return isRequiredMetric(name) || isOptionalMetric(name);
}

function isRequiredMetric(name: string): name is RequiredMetricName {
  return (REQUIRED_METRICS as readonly string[]).includes(name);
}

function isOptionalMetric(name: string): name is OptionalMetricName {
  return (OPTIONAL_METRICS as readonly string[]).includes(name);
}

function isValidMetric(name: MetricName, metric: Record<string, unknown>): boolean {
  const surfels = numberField(metric, 'surfelCount');
  if (surfels <= 0) return false;
  if (name !== 'PANORAMIC_MODEL_UPLOAD_PROFILE' && numberField(metric, 'keyframes') <= 0) return false;
  if (name === 'PANORAMIC_CAPTURE_METRICS') {
    return numberField(metric, 'rawSampleCount') > 0;
  }
  if (name === 'PANORAMIC_RENDER_METRICS') {
    return numberField(metric, 'canvasWidth') > 0 && numberField(metric, 'canvasHeight') > 0;
  }
  if (name === 'PANORAMIC_EXPORT_METRICS') {
    return numberField(metric, 'bytes') > 0 && String(metric.filename ?? '').endsWith('.ply');
  }
  if (name === 'PANORAMIC_MODEL_UPLOAD_PROFILE') {
    return numberField(metric, 'surfelBytes') > 0 && numberField(metric, 'uploadMs') >= 0;
  }
  return true;
}

function numberField(metric: Record<string, unknown>, field: string): number {
  const value = metric[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isComplete(seen: SeenMetrics): boolean {
  return missingMetrics(seen).length === 0;
}

function missingMetrics(seen: SeenMetrics): RequiredMetricName[] {
  return REQUIRED_METRICS.filter((name) => !seen[name]);
}

function printMetricSummary(seen: SeenMetrics): void {
  console.log('Panorama physical validation passed.');
  for (const name of REQUIRED_METRICS) {
    console.log(`  ${name}: ${JSON.stringify(seen[name])}`);
  }
  for (const name of OPTIONAL_METRICS) {
    if (seen[name]) {
      console.log(`  ${name}: ${JSON.stringify(seen[name])}`);
    }
  }
}

async function sh(cmd: string[]): Promise<void> {
  const proc = spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = proc.stdout ? streamToText(proc.stdout) : Promise.resolve('');
  const stderr = proc.stderr ? streamToText(proc.stderr) : Promise.resolve('');
  const code = await proc.exited;
  const output = [await stdout, await stderr].filter(Boolean).join('\n').trim();
  if (code !== 0) {
    throw new Error(formatCommandFailure(cmd, code, output));
  }
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function formatCommandFailure(cmd: string[], code: number, output: string): string {
  const command = cmd.join(' ');
  if (/\bLocked\b|device was not, or could not be, unlocked|Unable to launch .* because .*locked/i.test(output)) {
    return [
      `Device is locked; unlock the iPhone and rerun the validator.`,
      `Command failed (${code}): ${command}`,
      output,
    ].filter(Boolean).join('\n');
  }
  return [`Command failed (${code}): ${command}`, output].filter(Boolean).join('\n');
}

async function shQuiet(cmd: string[]): Promise<void> {
  const proc = spawn({ cmd, stdout: 'pipe', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(' ')}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
