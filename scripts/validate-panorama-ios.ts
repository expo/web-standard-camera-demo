#!/usr/bin/env bun
// @ref LLP 0020#testing-and-validation — Physical-device validation for the
// panoramic WebXR capture flow. The script launches the dev-client app, streams
// device logs, and succeeds only after a manual scan/capture/render/save run
// emits the required panorama telemetry.

import { spawn } from 'bun';
import { unlink, writeFile } from 'node:fs/promises';

const APP_BUNDLE_ID = 'dev.ide.standardcameraapp';
const URL_SCHEME = 'standardcameraapp';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_METRO_URL = process.env.PANORAMA_METRO_URL ?? 'http://192.168.1.181:8082';
const DEFAULT_ROUTE_URL = `${URL_SCHEME}:///panoramic-scene-capture?autorun=1`;
const DEFAULT_MAX_KEYFRAME_DEPTH_GRID_SAMPLES = 40 * 30;
const EXPECTED_CAMERA_SAMPLE_MODE = 'precomputed-axis';
const EXPECTED_DEPTH_GRID_SAMPLE_MODE = 'precomputed-identity';
const EXPECTED_KEYFRAME_DEPTH_TYPE = 'smooth';
const EXPECTED_KEYFRAME_UNPROJECTION_MODE = 'intrinsics-projection';
export const DEFAULT_VALIDATION_BUDGETS = {
  maxCaptureBuildMs: 2_000,
  maxKeyframeAppendMs: 160,
  maxKeyframeDepthGridSamples: DEFAULT_MAX_KEYFRAME_DEPTH_GRID_SAMPLES,
  maxLiveBuildMs: 750,
  maxModelUploadMs: 80,
  maxPreviewBuildMs: 2_000,
  maxRenderBuildMs: 2_000,
  minCameraColorPercent: 25,
  minLargestBoundMeters: 0.05,
  minMultiObservationPercent: 20,
  minNormalPercent: 20,
  minScanCoveragePercent: 25,
} as const satisfies PanoramaValidationBudgets;
const REQUIRED_METRICS = [
  'PANORAMIC_KEYFRAME_PROFILE',
  'PANORAMIC_CAPTURE_METRICS',
  'PANORAMIC_RENDER_METRICS',
  'PANORAMIC_EXPORT_METRICS',
] as const satisfies readonly RequiredMetricName[];
const OPTIONAL_METRICS = [
  'PANORAMIC_CAPTURE_GEOMETRY',
  'PANORAMIC_KEYFRAME_REJECTION_PROFILE',
  'PANORAMIC_LIVE_MODEL_PROFILE',
  'PANORAMIC_MODEL_UPLOAD_PROFILE',
  'PANORAMIC_MESH_PROFILE',
  'PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE',
  'PANORAMIC_NATIVE_PAYLOAD_PROFILE',
  'PANORAMIC_PREVIEW_METRICS',
  'PANORAMIC_RENDER_FRAME_PROFILE',
  'PANORAMIC_SCAN_CONFIG',
  'PANORAMIC_SCAN_STATS',
  'PANORAMIC_XR_FRAME_PUMP_PROFILE',
  'PANORAMIC_XR_SCAN_LOOP_STOP_PROFILE',
  'PANORAMIC_XR_POSE_PROFILE',
] as const satisfies readonly OptionalMetricName[];

export type RequiredMetricName =
  | 'PANORAMIC_KEYFRAME_PROFILE'
  | 'PANORAMIC_CAPTURE_METRICS'
  | 'PANORAMIC_RENDER_METRICS'
  | 'PANORAMIC_EXPORT_METRICS';
export type OptionalMetricName =
  | 'PANORAMIC_CAPTURE_GEOMETRY'
  | 'PANORAMIC_KEYFRAME_REJECTION_PROFILE'
  | 'PANORAMIC_LIVE_MODEL_PROFILE'
  | 'PANORAMIC_MODEL_UPLOAD_PROFILE'
  | 'PANORAMIC_MESH_PROFILE'
  | 'PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE'
  | 'PANORAMIC_NATIVE_PAYLOAD_PROFILE'
  | 'PANORAMIC_PREVIEW_METRICS'
  | 'PANORAMIC_RENDER_FRAME_PROFILE'
  | 'PANORAMIC_SCAN_CONFIG'
  | 'PANORAMIC_SCAN_STATS'
  | 'PANORAMIC_XR_FRAME_PUMP_PROFILE'
  | 'PANORAMIC_XR_SCAN_LOOP_STOP_PROFILE'
  | 'PANORAMIC_XR_POSE_PROFILE';
export type MetricName = RequiredMetricName | OptionalMetricName;

export type SeenMetrics = Partial<Record<MetricName, Record<string, unknown>>>;

export interface PanoramaProfileReport {
  bottleneckSummary: string[];
  generatedAt: string;
  metrics: SeenMetrics;
  missingRequiredMetrics: RequiredMetricName[];
  validated: boolean;
}

export interface PanoramaValidationBudgets {
  maxCaptureBuildMs: number;
  maxKeyframeAppendMs: number;
  maxKeyframeDepthGridSamples: number;
  maxLiveBuildMs: number;
  maxModelUploadMs: number;
  maxPreviewBuildMs: number;
  maxRenderBuildMs: number;
  minCameraColorPercent: number;
  minLargestBoundMeters: number;
  minMultiObservationPercent: number;
  minNormalPercent: number;
  minScanCoveragePercent: number;
}

interface Options {
  device?: string;
  installAppPath?: string;
  logFilePath?: string;
  metroUrl: string;
  noLaunch: boolean;
  outJsonPath?: string;
  profileOnly: boolean;
  routeUrl: string | null;
  timeoutMs: number;
  validationBudgets: PanoramaValidationBudgets;
}

interface TimingEntry {
  detail?: string;
  label: string;
  ms: number;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error('validate-panorama-ios failed:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.logFilePath) {
    const seen = parseMetricLogText(await Bun.file(options.logFilePath).text());
    if (!options.profileOnly) {
      validateRequiredMetricSet(seen, options.validationBudgets);
    }
    await writeProfileReportIfRequested(seen, {
      outJsonPath: options.outJsonPath,
      validated: !options.profileOnly,
    });
    printMetricSummary(seen, { validated: !options.profileOnly });
    return 0;
  }

  const device = await pickConnectedDevice(options.device);
  console.log(`Using device: ${device.name} (${device.identifier})`);
  console.log(
    options.profileOnly
      ? `Collecting panorama profile logs for ${(options.timeoutMs / 1000).toFixed(0)}s.`
      : `Waiting up to ${(options.timeoutMs / 1000).toFixed(0)}s for panorama telemetry.`
  );
  console.log(
    options.profileOnly
      ? 'On the phone: pan slowly after the route opens; optionally press Preview, then Capture/Save if you want final metrics.'
      : 'On the phone: pan slowly after the route opens until surfels appear, Capture, then Save.'
  );

  let logProc: ReturnType<typeof spawn> | null = null;
  try {
    if (options.installAppPath) {
      await sh([
        'xcrun',
        'devicectl',
        'device',
        'install',
        'app',
        '--device',
        device.identifier,
        options.installAppPath,
      ]);
      console.log(`Installed app bundle ${options.installAppPath}`);
    }
    if (!options.noLaunch) {
      const payloadUrl = buildDevelopmentClientUrl(options.metroUrl);
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

    logProc = startLogStream();
    const seen = await collectMetrics(logProc, options.timeoutMs, { requireComplete: !options.profileOnly });
    if (!options.profileOnly) {
      validateRequiredMetricSet(seen, options.validationBudgets);
    }
    await writeProfileReportIfRequested(seen, {
      outJsonPath: options.outJsonPath,
      validated: !options.profileOnly,
    });
    printMetricSummary(seen, { validated: !options.profileOnly });
    return 0;
  } finally {
    try {
      logProc?.kill();
    } catch {
      // ignore
    }
  }
}

function startLogStream(): ReturnType<typeof spawn> {
  return spawn({
    cmd: ['idevicesyslog', '-n', '-p', 'standardcameraapp', '--no-colors'],
    stdout: 'pipe',
    stderr: 'inherit',
  });
}

export function buildDevelopmentClientUrl(metroUrl: string): string {
  return `${URL_SCHEME}://expo-development-client/?${new URLSearchParams({
    disableOnboarding: '1',
    url: metroUrl,
  }).toString()}`;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    metroUrl: DEFAULT_METRO_URL,
    noLaunch: false,
    profileOnly: false,
    routeUrl: DEFAULT_ROUTE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    validationBudgets: { ...DEFAULT_VALIDATION_BUDGETS },
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--device') {
      options.device = requireValue(args, ++i, arg);
    } else if (arg === '--install-app') {
      options.installAppPath = requireValue(args, ++i, arg);
    } else if (arg === '--log-file') {
      options.logFilePath = requireValue(args, ++i, arg);
    } else if (arg === '--metro-url') {
      options.metroUrl = requireValue(args, ++i, arg);
    } else if (arg === '--max-capture-build-ms') {
      options.validationBudgets.maxCaptureBuildMs = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--max-keyframe-append-ms') {
      options.validationBudgets.maxKeyframeAppendMs = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--max-keyframe-depth-grid-samples') {
      options.validationBudgets.maxKeyframeDepthGridSamples = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--max-live-build-ms') {
      options.validationBudgets.maxLiveBuildMs = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--max-model-upload-ms') {
      options.validationBudgets.maxModelUploadMs = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--max-preview-build-ms') {
      options.validationBudgets.maxPreviewBuildMs = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--max-render-build-ms') {
      options.validationBudgets.maxRenderBuildMs = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--min-camera-color-percent') {
      options.validationBudgets.minCameraColorPercent = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--min-largest-bound-meters') {
      options.validationBudgets.minLargestBoundMeters = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--min-multi-observation-percent') {
      options.validationBudgets.minMultiObservationPercent = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--min-normal-percent') {
      options.validationBudgets.minNormalPercent = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--min-scan-coverage-percent') {
      options.validationBudgets.minScanCoveragePercent = parsePositiveNumber(requireValue(args, ++i, arg), arg);
    } else if (arg === '--no-launch') {
      options.noLaunch = true;
    } else if (arg === '--out-json') {
      options.outJsonPath = requireValue(args, ++i, arg);
    } else if (arg === '--profile-only') {
      options.profileOnly = true;
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
  if (
    options.logFilePath &&
    (options.device || options.installAppPath || options.noLaunch || options.routeUrl === null)
  ) {
    throw new Error('--log-file parses existing logs and cannot be combined with device launch/install flags');
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

function parsePositiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: bun run scripts/validate-panorama-ios.ts [options]

Options:
  --device <name|id>       CoreDevice identifier or iPhone name.
  --install-app <path>     Install a built .app before launch, for example
                           ./.build/ios-device/standardcameraapp.app.
  --log-file <path>        Parse an existing pasted/device log file instead
                           of connecting to a device.
  --metro-url <url>        Expo dev-server URL. Default: ${DEFAULT_METRO_URL}
  --route-url <url>        App route to open after Metro launch. Default: ${DEFAULT_ROUTE_URL}
  --no-route               Do not deep-link to the panorama route after launch.
  --timeout <seconds>      Validation timeout. Default: ${DEFAULT_TIMEOUT_MS / 1000}
  --no-launch              Do not launch the app; only stream logs.
  --out-json <path>        Write a structured profiling report with merged
                           metrics and bottleneck summary.
  --profile-only           Collect whatever panorama telemetry appears until
                           timeout, print a bottleneck summary, and skip the
                           required capture/render/export validation gate.
  --max-keyframe-append-ms <n>  Default: ${DEFAULT_VALIDATION_BUDGETS.maxKeyframeAppendMs}
  --max-keyframe-depth-grid-samples <n> Default: ${DEFAULT_VALIDATION_BUDGETS.maxKeyframeDepthGridSamples}
  --max-capture-build-ms <n>    Default: ${DEFAULT_VALIDATION_BUDGETS.maxCaptureBuildMs}
  --max-render-build-ms <n>     Default: ${DEFAULT_VALIDATION_BUDGETS.maxRenderBuildMs}
  --max-live-build-ms <n>       Default: ${DEFAULT_VALIDATION_BUDGETS.maxLiveBuildMs}
  --max-model-upload-ms <n>     Default: ${DEFAULT_VALIDATION_BUDGETS.maxModelUploadMs}
  --max-preview-build-ms <n>    Default: ${DEFAULT_VALIDATION_BUDGETS.maxPreviewBuildMs}
  --min-camera-color-percent <n> Default: ${DEFAULT_VALIDATION_BUDGETS.minCameraColorPercent}
  --min-multi-observation-percent <n> Default: ${DEFAULT_VALIDATION_BUDGETS.minMultiObservationPercent}
  --min-normal-percent <n>       Default: ${DEFAULT_VALIDATION_BUDGETS.minNormalPercent}
  --min-scan-coverage-percent <n> Default: ${DEFAULT_VALIDATION_BUDGETS.minScanCoveragePercent}
  --min-largest-bound-meters <n> Default: ${DEFAULT_VALIDATION_BUDGETS.minLargestBoundMeters}

Success requires these log lines from a physical run:
  PANORAMIC_KEYFRAME_PROFILE, PANORAMIC_CAPTURE_METRICS,
  PANORAMIC_RENDER_METRICS, and PANORAMIC_EXPORT_METRICS.
The required capture, render, and export metrics must describe the same model,
export telemetry must include the Files-visible .ply path, and capture/render
quality plus performance metrics must satisfy the configured budgets.

The validator also prints optional profiling telemetry when it appears:
  PANORAMIC_LIVE_MODEL_PROFILE, PANORAMIC_MODEL_UPLOAD_PROFILE,
  PANORAMIC_KEYFRAME_REJECTION_PROFILE,
  PANORAMIC_MESH_PROFILE, PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE,
  PANORAMIC_NATIVE_PAYLOAD_PROFILE, PANORAMIC_PREVIEW_METRICS,
  PANORAMIC_RENDER_FRAME_PROFILE, PANORAMIC_SCAN_CONFIG, PANORAMIC_SCAN_STATS,
  PANORAMIC_XR_FRAME_PUMP_PROFILE, PANORAMIC_XR_SCAN_LOOP_STOP_PROFILE, and
  PANORAMIC_CAPTURE_GEOMETRY, plus PANORAMIC_XR_POSE_PROFILE when WebXR
  withholds viewer poses because native tracking is not normal.`);
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
  timeoutMs: number,
  { requireComplete = true }: { requireComplete?: boolean } = {}
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
        if (requireComplete && isComplete(seen)) {
          return seen;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    if (!requireComplete) {
      return seen;
    }
    throw new Error(`Timed out waiting for: ${missingMetrics(seen).join(', ')}`);
  }
  if (!requireComplete) {
    return seen;
  }
  throw new Error(`Log stream ended before telemetry completed. Missing: ${missingMetrics(seen).join(', ')}`);
}

export function recordMetricLine(line: string, seen: SeenMetrics): void {
  const match = line.match(/(PANORAMIC_[A-Z_]+)\s+(\{.*\})/);
  if (!match) return;
  const name = match[1] as MetricName;
  if (!isObservedMetric(name)) return;
  const metric = safeParseMetric(match[2] ?? '{}');
  if (!isValidMetric(name, metric)) {
    console.warn(`Ignored invalid ${name}: ${JSON.stringify(metric)}`);
    return;
  }
  seen[name] = mergeObservedMetric(name, seen[name], metric);
  console.log(`${name} ${JSON.stringify(seen[name])}`);
}

export function parseMetricLogText(text: string): SeenMetrics {
  const seen: SeenMetrics = {};
  for (const line of text.split(/\r?\n/)) {
    recordMetricLine(line, seen);
  }
  return seen;
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

function mergeObservedMetric(
  name: MetricName,
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  if (!existing) return incoming;
  if (name === 'PANORAMIC_KEYFRAME_PROFILE') {
    const unprojectionMode = mergeKeyframeUnprojectionMode(
      stringField(existing, 'unprojectionMode'),
      stringField(incoming, 'unprojectionMode')
    );
    const cameraTransformMode = mergeTransformMode(
      stringField(existing, 'cameraTransformMode'),
      stringField(incoming, 'cameraTransformMode')
    );
    const depthTransformMode = mergeTransformMode(
      stringField(existing, 'depthTransformMode'),
      stringField(incoming, 'depthTransformMode')
    );
    const cameraSampleMode = mergeExpectedMode(
      stringField(existing, 'cameraSampleMode'),
      stringField(incoming, 'cameraSampleMode'),
      EXPECTED_CAMERA_SAMPLE_MODE
    );
    const depthGridSampleMode = mergeExpectedMode(
      stringField(existing, 'depthGridSampleMode'),
      stringField(incoming, 'depthGridSampleMode'),
      EXPECTED_DEPTH_GRID_SAMPLE_MODE
    );
    const depthType = mergeExpectedMode(
      stringField(existing, 'depthType'),
      stringField(incoming, 'depthType'),
      EXPECTED_KEYFRAME_DEPTH_TYPE
    );
    const merged = {
      ...incoming,
      appendMs: Math.max(numberField(existing, 'appendMs'), numberField(incoming, 'appendMs')),
      cameraColorPercent: Math.min(
        numberField(existing, 'cameraColorPercent'),
        numberField(incoming, 'cameraColorPercent')
      ),
      cameraPointCacheHits: Math.max(
        numberField(existing, 'cameraPointCacheHits'),
        numberField(incoming, 'cameraPointCacheHits')
      ),
      cameraPointSamples: Math.max(
        numberField(existing, 'cameraPointSamples'),
        numberField(incoming, 'cameraPointSamples')
      ),
      cameraRequested: existing.cameraRequested === true || incoming.cameraRequested === true,
      centerCameraMeters: incoming.centerCameraMeters ?? existing.centerCameraMeters,
      centerDepthMeters: incoming.centerDepthMeters ?? existing.centerDepthMeters,
      centerDepthValid: incoming.centerDepthValid ?? existing.centerDepthValid,
      centerWorldMeters: incoming.centerWorldMeters ?? existing.centerWorldMeters,
      colorSampleMs: Math.max(numberField(existing, 'colorSampleMs'), numberField(incoming, 'colorSampleMs')),
      depthAppendMs: Math.max(numberField(existing, 'depthAppendMs'), numberField(incoming, 'depthAppendMs')),
      depthGridSamples: Math.max(
        numberField(existing, 'depthGridSamples'),
        numberField(incoming, 'depthGridSamples')
      ),
      depthInitialAppendMs: Math.max(
        numberField(existing, 'depthInitialAppendMs'),
        numberField(incoming, 'depthInitialAppendMs')
      ),
      depthLookupMs: Math.max(numberField(existing, 'depthLookupMs'), numberField(incoming, 'depthLookupMs')),
      normalEstimateMs: Math.max(
        numberField(existing, 'normalEstimateMs'),
        numberField(incoming, 'normalEstimateMs')
      ),
      depthRecoveryAppendMs: Math.max(
        numberField(existing, 'depthRecoveryAppendMs'),
        numberField(incoming, 'depthRecoveryAppendMs')
      ),
      depthRecoverySkipped: existing.depthRecoverySkipped === true || incoming.depthRecoverySkipped === true,
      newVoxelPercent: mergeLowestObservedNumber(existing, incoming, 'newVoxelPercent'),
      newVoxelPreflightMs: Math.max(
        numberField(existing, 'newVoxelPreflightMs'),
        numberField(incoming, 'newVoxelPreflightMs')
      ),
      meshAppendMs: Math.max(numberField(existing, 'meshAppendMs'), numberField(incoming, 'meshAppendMs')),
      meshCameraColoredSurfels: Math.max(
        numberField(existing, 'meshCameraColoredSurfels'),
        numberField(incoming, 'meshCameraColoredSurfels')
      ),
      meshCameraColorPercent: mergeLowestPositivePercent(existing, incoming, 'meshCameraColorPercent'),
      meshCameraImageMs: Math.max(
        numberField(existing, 'meshCameraImageMs'),
        numberField(incoming, 'meshCameraImageMs')
      ),
      meshCameraRequested: existing.meshCameraRequested === true || incoming.meshCameraRequested === true,
      meshCount: Math.max(numberField(existing, 'meshCount'), numberField(incoming, 'meshCount')),
      meshFetchMs: Math.max(numberField(existing, 'meshFetchMs'), numberField(incoming, 'meshFetchMs')),
      meshMaxSurfels: Math.max(
        numberField(existing, 'meshMaxSurfels'),
        numberField(incoming, 'meshMaxSurfels')
      ),
      meshNewVoxelCount: Math.max(
        numberField(existing, 'meshNewVoxelCount'),
        numberField(incoming, 'meshNewVoxelCount')
      ),
      meshNormalCount: Math.max(
        numberField(existing, 'meshNormalCount'),
        numberField(incoming, 'meshNormalCount')
      ),
      meshNormalMode: mergeMeshNormalMode(
        stringField(existing, 'meshNormalMode'),
        stringField(incoming, 'meshNormalMode')
      ),
      meshPoseMisses: Math.max(
        numberField(existing, 'meshPoseMisses'),
        numberField(incoming, 'meshPoseMisses')
      ),
      meshPlaneProjectedSamples: Math.max(
        numberField(existing, 'meshPlaneProjectedSamples'),
        numberField(incoming, 'meshPlaneProjectedSamples')
      ),
      meshAppendReason: stringField(incoming, 'meshAppendReason') ||
        stringField(existing, 'meshAppendReason') ||
        undefined,
      meshAppendSkipped: existing.meshAppendSkipped === true || incoming.meshAppendSkipped === true,
      meshSignature: stringField(incoming, 'meshSignature') ||
        stringField(existing, 'meshSignature') ||
        undefined,
      meshPreflightEarlyStopped:
        existing.meshPreflightEarlyStopped === true || incoming.meshPreflightEarlyStopped === true,
      meshPreflightMaxSurfels: Math.max(
        numberField(existing, 'meshPreflightMaxSurfels'),
        numberField(incoming, 'meshPreflightMaxSurfels')
      ),
      meshPreflightNewVoxelCount: Math.max(
        numberField(existing, 'meshPreflightNewVoxelCount'),
        numberField(incoming, 'meshPreflightNewVoxelCount')
      ),
      meshPreflightMs: Math.max(
        numberField(existing, 'meshPreflightMs'),
        numberField(incoming, 'meshPreflightMs')
      ),
      meshPreflightProjectedSurfels: Math.max(
        numberField(existing, 'meshPreflightProjectedSurfels'),
        numberField(incoming, 'meshPreflightProjectedSurfels')
      ),
      meshPreflightSampleStride: Math.max(
        numberField(existing, 'meshPreflightSampleStride'),
        numberField(incoming, 'meshPreflightSampleStride')
      ),
      meshPreflightSkippedSurfels: Math.max(
        numberField(existing, 'meshPreflightSkippedSurfels'),
        numberField(incoming, 'meshPreflightSkippedSurfels')
      ),
      meshPreflightStrideSkippedCandidates: Math.max(
        numberField(existing, 'meshPreflightStrideSkippedCandidates'),
        numberField(incoming, 'meshPreflightStrideSkippedCandidates')
      ),
      meshPreflightStopAtNewVoxels: Math.max(
        numberField(existing, 'meshPreflightStopAtNewVoxels'),
        numberField(incoming, 'meshPreflightStopAtNewVoxels')
      ),
      meshPreflightStopAtSurfels: Math.max(
        numberField(existing, 'meshPreflightStopAtSurfels'),
        numberField(incoming, 'meshPreflightStopAtSurfels')
      ),
      meshPreflightSurfelCount: Math.max(
        numberField(existing, 'meshPreflightSurfelCount'),
        numberField(incoming, 'meshPreflightSurfelCount')
      ),
      meshProjectedSurfels: Math.max(
        numberField(existing, 'meshProjectedSurfels'),
        numberField(incoming, 'meshProjectedSurfels')
      ),
      meshRecoveredDepthGate: existing.meshRecoveredDepthGate === true || incoming.meshRecoveredDepthGate === true,
      meshSampleStride: Math.max(
        numberField(existing, 'meshSampleStride'),
        numberField(incoming, 'meshSampleStride')
      ),
      meshSkippedSurfels: Math.max(
        numberField(existing, 'meshSkippedSurfels'),
        numberField(incoming, 'meshSkippedSurfels')
      ),
      meshStrideSkippedCandidates: Math.max(
        numberField(existing, 'meshStrideSkippedCandidates'),
        numberField(incoming, 'meshStrideSkippedCandidates')
      ),
      meshSurfelCount: Math.max(
        numberField(existing, 'meshSurfelCount'),
        numberField(incoming, 'meshSurfelCount')
      ),
      meshTriangles: Math.max(numberField(existing, 'meshTriangles'), numberField(incoming, 'meshTriangles')),
      meshUpdatedVoxelCount: Math.max(
        numberField(existing, 'meshUpdatedVoxelCount'),
        numberField(incoming, 'meshUpdatedVoxelCount')
      ),
      meshVertices: Math.max(numberField(existing, 'meshVertices'), numberField(incoming, 'meshVertices')),
      matureVoxelSkips: Math.max(
        numberField(existing, 'matureVoxelSkips'),
        numberField(incoming, 'matureVoxelSkips')
      ),
      observedDepthSurfels: Math.max(
        numberField(existing, 'observedDepthSurfels'),
        numberField(incoming, 'observedDepthSurfels')
      ),
      planeProjectedSamples: Math.max(
        numberField(existing, 'planeProjectedSamples'),
        numberField(incoming, 'planeProjectedSamples')
      ),
      profiledSampleCount: Math.max(
        numberField(existing, 'profiledSampleCount'),
        numberField(incoming, 'profiledSampleCount')
      ),
      sampleConsumeMs: Math.max(numberField(existing, 'sampleConsumeMs'), numberField(incoming, 'sampleConsumeMs')),
      sampleLoopMs: Math.max(numberField(existing, 'sampleLoopMs'), numberField(incoming, 'sampleLoopMs')),
      timedSampleCount: Math.max(
        numberField(existing, 'timedSampleCount'),
        numberField(incoming, 'timedSampleCount')
      ),
      timingSampleStride: Math.max(
        numberField(existing, 'timingSampleStride'),
        numberField(incoming, 'timingSampleStride')
      ),
      unprojectMs: Math.max(numberField(existing, 'unprojectMs'), numberField(incoming, 'unprojectMs')),
    };
    if (unprojectionMode) {
      return {
        ...merged,
        cameraSampleMode,
        cameraTransformMode,
        depthGridSampleMode,
        depthType,
        depthTransformMode,
        unprojectionMode,
      };
    }
    return {
      ...merged,
      cameraSampleMode,
      cameraTransformMode,
      depthGridSampleMode,
      depthType,
      depthTransformMode,
    };
  }
  if (name === 'PANORAMIC_LIVE_MODEL_PROFILE') {
    return {
      ...incoming,
      buildMs: Math.max(numberField(existing, 'buildMs'), numberField(incoming, 'buildMs')),
      multiObservationPercent: mergeLowestPositivePercent(existing, incoming, 'multiObservationPercent'),
    };
  }
  if (name === 'PANORAMIC_PREVIEW_METRICS') {
    return {
      ...incoming,
      buildMs: Math.max(numberField(existing, 'buildMs'), numberField(incoming, 'buildMs')),
      cameraColorPercent: Math.min(
        numberField(existing, 'cameraColorPercent'),
        numberField(incoming, 'cameraColorPercent')
      ),
      normalPercent: Math.min(
        numberField(existing, 'normalPercent'),
        numberField(incoming, 'normalPercent')
      ),
      multiObservationPercent: mergeLowestPositivePercent(existing, incoming, 'multiObservationPercent'),
    };
  }
  if (name === 'PANORAMIC_RENDER_METRICS') {
    return {
      ...incoming,
      buildMs: Math.max(numberField(existing, 'buildMs'), numberField(incoming, 'buildMs')),
      cameraColorPercent: Math.min(
        numberField(existing, 'cameraColorPercent'),
        numberField(incoming, 'cameraColorPercent')
      ),
      commandEncodeMs: Math.max(
        numberField(existing, 'commandEncodeMs'),
        numberField(incoming, 'commandEncodeMs')
      ),
      multiObservationPercent: mergeLowestPositivePercent(existing, incoming, 'multiObservationPercent'),
      normalPercent: Math.min(
        numberField(existing, 'normalPercent'),
        numberField(incoming, 'normalPercent')
      ),
      renderFrameMs: Math.max(numberField(existing, 'renderFrameMs'), numberField(incoming, 'renderFrameMs')),
      submitPresentMs: Math.max(
        numberField(existing, 'submitPresentMs'),
        numberField(incoming, 'submitPresentMs')
      ),
    };
  }
  if (name === 'PANORAMIC_RENDER_FRAME_PROFILE') {
    return {
      ...incoming,
      commandEncodeMs: Math.max(
        numberField(existing, 'commandEncodeMs'),
        numberField(incoming, 'commandEncodeMs')
      ),
      renderFrameMs: Math.max(numberField(existing, 'renderFrameMs'), numberField(incoming, 'renderFrameMs')),
      submitPresentMs: Math.max(
        numberField(existing, 'submitPresentMs'),
        numberField(incoming, 'submitPresentMs')
      ),
    };
  }
  if (name === 'PANORAMIC_MODEL_UPLOAD_PROFILE') {
    return {
      ...incoming,
      uploadMs: Math.max(numberField(existing, 'uploadMs'), numberField(incoming, 'uploadMs')),
    };
  }
  if (name === 'PANORAMIC_MESH_PROFILE') {
    return {
      ...incoming,
      indexCount: Math.max(numberField(existing, 'indexCount'), numberField(incoming, 'indexCount')),
      meshCount: Math.max(numberField(existing, 'meshCount'), numberField(incoming, 'meshCount')),
      normalCount: Math.max(numberField(existing, 'normalCount'), numberField(incoming, 'normalCount')),
      triangleCount: Math.max(numberField(existing, 'triangleCount'), numberField(incoming, 'triangleCount')),
      vertexCount: Math.max(numberField(existing, 'vertexCount'), numberField(incoming, 'vertexCount')),
    };
  }
  if (name === 'PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE') {
    return {
      ...incoming,
      cachedMeshCount: Math.max(
        numberField(existing, 'cachedMeshCount'),
        numberField(incoming, 'cachedMeshCount')
      ),
      copiedMeshCount: Math.max(
        numberField(existing, 'copiedMeshCount'),
        numberField(incoming, 'copiedMeshCount')
      ),
      decimatedMeshCount: Math.max(
        numberField(existing, 'decimatedMeshCount'),
        numberField(incoming, 'decimatedMeshCount')
      ),
      indexBytes: Math.max(numberField(existing, 'indexBytes'), numberField(incoming, 'indexBytes')),
      indexCount: Math.max(numberField(existing, 'indexCount'), numberField(incoming, 'indexCount')),
      meshBytes: Math.max(numberField(existing, 'meshBytes'), numberField(incoming, 'meshBytes')),
      meshCount: Math.max(numberField(existing, 'meshCount'), numberField(incoming, 'meshCount')),
      normalBytes: Math.max(numberField(existing, 'normalBytes'), numberField(incoming, 'normalBytes')),
      normalCount: Math.max(numberField(existing, 'normalCount'), numberField(incoming, 'normalCount')),
      requestMs: Math.max(numberField(existing, 'requestMs'), numberField(incoming, 'requestMs')),
      sourceIndexCount: Math.max(numberField(existing, 'sourceIndexCount'), numberField(incoming, 'sourceIndexCount')),
      sourceTriangleCount: Math.max(
        numberField(existing, 'sourceTriangleCount'),
        numberField(incoming, 'sourceTriangleCount')
      ),
      sourceVertexCount: Math.max(
        numberField(existing, 'sourceVertexCount'),
        numberField(incoming, 'sourceVertexCount')
      ),
      triangleCount: Math.max(numberField(existing, 'triangleCount'), numberField(incoming, 'triangleCount')),
      vertexBytes: Math.max(numberField(existing, 'vertexBytes'), numberField(incoming, 'vertexBytes')),
      vertexCount: Math.max(numberField(existing, 'vertexCount'), numberField(incoming, 'vertexCount')),
    };
  }
  if (name === 'PANORAMIC_NATIVE_PAYLOAD_PROFILE') {
    const existingValidDepthPercent = numberField(existing, 'validDepthPercent');
    const incomingValidDepthPercent = numberField(incoming, 'validDepthPercent');
    const existingDepthMinMeters = numberField(existing, 'depthMinMeters');
    const incomingDepthMinMeters = numberField(incoming, 'depthMinMeters');
    return {
      ...incoming,
      cameraBytes: Math.max(numberField(existing, 'cameraBytes'), numberField(incoming, 'cameraBytes')),
      cameraPreviewMs: Math.max(numberField(existing, 'cameraPreviewMs'), numberField(incoming, 'cameraPreviewMs')),
      cameraPreviewPath:
        stringField(incoming, 'cameraPreviewPath') || stringField(existing, 'cameraPreviewPath') || undefined,
      cameraCapturedSize: incoming.cameraCapturedSize ?? existing.cameraCapturedSize,
      colorBytesPerPixel: Math.max(
        numberField(existing, 'colorBytesPerPixel'),
        numberField(incoming, 'colorBytesPerPixel')
      ),
      colorSize: incoming.colorSize ?? existing.colorSize,
      confidenceFilteredDepthCount: Math.max(
        numberField(existing, 'confidenceFilteredDepthCount'),
        numberField(incoming, 'confidenceFilteredDepthCount')
      ),
      confidenceFilteredPercent: Math.max(
        numberField(existing, 'confidenceFilteredPercent'),
        numberField(incoming, 'confidenceFilteredPercent')
      ),
      confidenceFallbackUsed: existing.confidenceFallbackUsed === true || incoming.confidenceFallbackUsed === true,
      confidenceMapUsed: existing.confidenceMapUsed === true || incoming.confidenceMapUsed === true,
      confidenceThreshold: Math.max(
        numberField(existing, 'confidenceThreshold'),
        numberField(incoming, 'confidenceThreshold')
      ),
      depthBytes: Math.max(numberField(existing, 'depthBytes'), numberField(incoming, 'depthBytes')),
      depthBytesPerPixel: Math.max(
        numberField(existing, 'depthBytesPerPixel'),
        numberField(incoming, 'depthBytesPerPixel')
      ),
      depthCopyMs: Math.max(numberField(existing, 'depthCopyMs'), numberField(incoming, 'depthCopyMs')),
      depthMaxMeters: Math.max(
        numberField(existing, 'depthMaxMeters'),
        numberField(incoming, 'depthMaxMeters')
      ),
      depthMeanMeters: numberField(incoming, 'depthMeanMeters') || numberField(existing, 'depthMeanMeters'),
      depthMinMeters:
        existingDepthMinMeters > 0 && incomingDepthMinMeters > 0
          ? Math.min(existingDepthMinMeters, incomingDepthMinMeters)
          : Math.max(existingDepthMinMeters, incomingDepthMinMeters),
      depthPixelCount: Math.max(numberField(existing, 'depthPixelCount'), numberField(incoming, 'depthPixelCount')),
      depthSize: incoming.depthSize ?? existing.depthSize,
      depthToCameraScale: incoming.depthToCameraScale ?? existing.depthToCameraScale,
      depthType: stringField(incoming, 'depthType') || stringField(existing, 'depthType') || undefined,
      highConfidenceDepthCount: Math.max(
        numberField(existing, 'highConfidenceDepthCount'),
        numberField(incoming, 'highConfidenceDepthCount')
      ),
      highConfidencePercent: mergeLowestPositivePercent(existing, incoming, 'highConfidencePercent'),
      includeCameraImage: existing.includeCameraImage === true || incoming.includeCameraImage === true,
      includeDepthData: existing.includeDepthData === true || incoming.includeDepthData === true,
      invalidDepthCount: Math.max(
        numberField(existing, 'invalidDepthCount'),
        numberField(incoming, 'invalidDepthCount')
      ),
      invalidDepthPercent: Math.max(
        numberField(existing, 'invalidDepthPercent'),
        numberField(incoming, 'invalidDepthPercent')
      ),
      lowConfidenceDepthCount: Math.max(
        numberField(existing, 'lowConfidenceDepthCount'),
        numberField(incoming, 'lowConfidenceDepthCount')
      ),
      lowConfidencePercent: Math.max(
        numberField(existing, 'lowConfidencePercent'),
        numberField(incoming, 'lowConfidencePercent')
      ),
      mediumConfidenceDepthCount: Math.max(
        numberField(existing, 'mediumConfidenceDepthCount'),
        numberField(incoming, 'mediumConfidenceDepthCount')
      ),
      mediumConfidencePercent: Math.max(
        numberField(existing, 'mediumConfidencePercent'),
        numberField(incoming, 'mediumConfidencePercent')
      ),
      payloadMs: Math.max(numberField(existing, 'payloadMs'), numberField(incoming, 'payloadMs')),
      projectionCameraImageResolution:
        incoming.projectionCameraImageResolution ?? existing.projectionCameraImageResolution,
      projectionDepthToCameraScale: incoming.projectionDepthToCameraScale ?? existing.projectionDepthToCameraScale,
      requestMs: Math.max(numberField(existing, 'requestMs'), numberField(incoming, 'requestMs')),
      validDepthCount: Math.max(
        numberField(existing, 'validDepthCount'),
        numberField(incoming, 'validDepthCount')
      ),
      validDepthPercent:
        existingValidDepthPercent > 0 && incomingValidDepthPercent > 0
          ? Math.min(existingValidDepthPercent, incomingValidDepthPercent)
          : Math.max(existingValidDepthPercent, incomingValidDepthPercent),
    };
  }
  return incoming;
}

function mergeKeyframeUnprojectionMode(existing: string, incoming: string): string {
  if (existing && existing !== EXPECTED_KEYFRAME_UNPROJECTION_MODE) return existing;
  if (incoming && incoming !== EXPECTED_KEYFRAME_UNPROJECTION_MODE) return incoming;
  return incoming || existing;
}

function mergeTransformMode(existing: string, incoming: string): string {
  const rank = (mode: string): number => {
    if (mode === 'projective') return 3;
    if (mode === 'affine') return 2;
    if (mode === 'identity') return 1;
    return 0;
  };
  return rank(existing) > rank(incoming) ? existing : incoming || existing;
}

function mergeExpectedMode(existing: string, incoming: string, expected: string): string {
  if (existing && existing !== expected) return existing;
  if (incoming && incoming !== expected) return incoming;
  return incoming || existing;
}

function mergeMeshNormalMode(existing: string, incoming: string): string {
  const existingMode = existing || 'none';
  const incomingMode = incoming || 'none';
  if (existingMode === incomingMode) return incomingMode;
  if (existingMode === 'mixed' || incomingMode === 'mixed') return 'mixed';
  if (existingMode === 'none') return incomingMode;
  if (incomingMode === 'none') return existingMode;
  return 'mixed';
}

function mergeLowestPositivePercent(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  field: string
): number {
  const existingValue = numberField(existing, field);
  const incomingValue = numberField(incoming, field);
  return existingValue > 0 && incomingValue > 0
    ? Math.min(existingValue, incomingValue)
    : Math.max(existingValue, incomingValue);
}

function mergeLowestObservedNumber(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  field: string
): number {
  const existingRaw = existing[field];
  const incomingRaw = incoming[field];
  const hasExisting = typeof existingRaw === 'number' && Number.isFinite(existingRaw);
  const hasIncoming = typeof incomingRaw === 'number' && Number.isFinite(incomingRaw);
  if (hasExisting && hasIncoming) return Math.min(existingRaw, incomingRaw);
  if (hasIncoming) return incomingRaw;
  if (hasExisting) return existingRaw;
  return 0;
}

export function isValidMetric(name: MetricName, metric: Record<string, unknown>): boolean {
  if (name === 'PANORAMIC_NATIVE_PAYLOAD_PROFILE') {
    return numberField(metric, 'frameNumber') > 0 && numberField(metric, 'requestMs') >= 0;
  }
  if (name === 'PANORAMIC_SCAN_STATS') {
    return numberField(metric, 'frameCount') >= numberField(metric, 'acceptedKeyframes') &&
      numberField(metric, 'elapsedMs') >= 0;
  }
  if (name === 'PANORAMIC_SCAN_CONFIG') {
    return Array.isArray(metric.depthTypeRequest) &&
      metric.depthTypeRequest.every((entry) => entry === 'raw' || entry === 'smooth') &&
      typeof metric.meshRequested === 'boolean' &&
      stringField(metric, 'depthPreference').length > 0;
  }
  if (name === 'PANORAMIC_KEYFRAME_REJECTION_PROFILE') {
    return stringField(metric, 'reason').length > 0 &&
      numberField(metric, 'frameCount') >= 0 &&
      numberField(metric, 'keyframes') >= 0;
  }
  if (name === 'PANORAMIC_XR_FRAME_PUMP_PROFILE') {
    return numberField(metric, 'lastDeliveredFrameNumber') >= 0 &&
      numberField(metric, 'latestFrameNumber') >= 0 &&
      stringField(metric, 'reason').length > 0;
  }
  if (name === 'PANORAMIC_XR_SCAN_LOOP_STOP_PROFILE') {
    return stringField(metric, 'reason').length > 0 &&
      numberField(metric, 'frameCount') >= numberField(metric, 'acceptedKeyframes') &&
      numberField(metric, 'keyframes') >= 0;
  }
  if (name === 'PANORAMIC_MESH_PROFILE') {
    return (numberField(metric, 'frameNumber') > 0 || numberField(metric, 'frameTimeMs') >= 0) &&
      numberField(metric, 'meshCount') > 0;
  }
  if (name === 'PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE') {
    return numberField(metric, 'frameNumber') > 0 &&
      numberField(metric, 'requestMs') >= 0 &&
      numberField(metric, 'meshCount') >= 0;
  }
  if (name === 'PANORAMIC_XR_POSE_PROFILE') {
    return numberField(metric, 'frameNumber') > 0 &&
      typeof metric.returnedPose === 'boolean' &&
      stringField(metric, 'trackingState').length > 0;
  }
  if (name === 'PANORAMIC_CAPTURE_GEOMETRY') {
    return numberField(metric, 'keyframes') > 0 &&
      numberField(metric, 'surfelCount') > 0 &&
      hasNonzeroBounds(metric, 'boundsMeters');
  }
  if (name === 'PANORAMIC_PREVIEW_METRICS') {
    return numberField(metric, 'keyframes') > 0 &&
      numberField(metric, 'surfelCount') > 0 &&
      numberField(metric, 'rawSampleCount') >= numberField(metric, 'surfelCount') &&
      numberField(metric, 'buildMs') >= 0;
  }
  if (name === 'PANORAMIC_RENDER_FRAME_PROFILE') {
    return numberField(metric, 'keyframes') > 0 &&
      numberField(metric, 'surfelCount') > 0 &&
      numberField(metric, 'canvasWidth') > 0 &&
      numberField(metric, 'canvasHeight') > 0 &&
      numberField(metric, 'renderFrameMs') >= 0;
  }
  const surfels = numberField(metric, 'surfelCount');
  if (surfels <= 0) return false;
  if (name !== 'PANORAMIC_MODEL_UPLOAD_PROFILE' && numberField(metric, 'keyframes') <= 0) return false;
  if (name === 'PANORAMIC_KEYFRAME_PROFILE') {
    const rawSamples = Math.max(
      numberField(metric, 'rawSampleCount'),
      numberField(metric, 'retainedSamples')
    );
    const fusedSurfels = numberField(metric, 'fusedSurfelCount');
    return rawSamples >= surfels && (fusedSurfels <= 0 || rawSamples >= fusedSurfels);
  }
  if (name === 'PANORAMIC_CAPTURE_METRICS') {
    return numberField(metric, 'rawSampleCount') >= surfels &&
      numberField(metric, 'cameraColorPercent') > 0 &&
      hasNonzeroBounds(metric, 'boundsMeters');
  }
  if (name === 'PANORAMIC_RENDER_METRICS') {
    return numberField(metric, 'canvasWidth') > 0 &&
      numberField(metric, 'canvasHeight') > 0 &&
      numberField(metric, 'rawSampleCount') >= surfels;
  }
  if (name === 'PANORAMIC_EXPORT_METRICS') {
    const filename = String(metric.filename ?? '');
    return numberField(metric, 'bytes') > 0 &&
      filename.endsWith('.ply') &&
      String(metric.filesVisiblePath ?? '') === `standard-camera-app/${filename}` &&
      String(metric.uri ?? '').length > 0;
  }
  if (name === 'PANORAMIC_MODEL_UPLOAD_PROFILE') {
    return numberField(metric, 'surfelBytes') > 0 && numberField(metric, 'uploadMs') >= 0;
  }
  return true;
}

function hasNonzeroBounds(metric: Record<string, unknown>, field: string): boolean {
  const value = metric[field];
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) &&
    value.some((entry) => entry > 0);
}

function numberField(metric: Record<string, unknown>, field: string): number {
  const value = metric[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function fusedSurfelDetail(metric: Record<string, unknown>): string {
  return typeof metric.fusedSurfelCount === 'number' && Number.isFinite(metric.fusedSurfelCount)
    ? `, fused ${metric.fusedSurfelCount} surfels`
    : '';
}

function stringField(metric: Record<string, unknown>, field: string): string {
  const value = metric[field];
  return typeof value === 'string' ? value : '';
}

function tupleField(metric: Record<string, unknown>, field: string): [number, number] | null {
  const value = metric[field];
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = value[0];
  const y = value[1];
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
    ? [x, y]
    : null;
}

export function isComplete(seen: SeenMetrics): boolean {
  return missingMetrics(seen).length === 0;
}

export function missingMetrics(seen: SeenMetrics): RequiredMetricName[] {
  return REQUIRED_METRICS.filter((name) => !seen[name]);
}

export function metricSetValidationError(
  seen: SeenMetrics,
  budgets: PanoramaValidationBudgets = DEFAULT_VALIDATION_BUDGETS
): string | null {
  const missing = missingMetrics(seen);
  if (missing.length > 0) {
    return `Missing required metrics: ${missing.join(', ')}`;
  }
  const keyframe = seen.PANORAMIC_KEYFRAME_PROFILE!;
  const capture = seen.PANORAMIC_CAPTURE_METRICS!;
  const render = seen.PANORAMIC_RENDER_METRICS!;
  const exported = seen.PANORAMIC_EXPORT_METRICS!;
  const captureKeyframes = numberField(capture, 'keyframes');
  const captureSurfels = numberField(capture, 'surfelCount');
  const captureRawSamples = numberField(capture, 'rawSampleCount');
  const keyframeRawSamples = Math.max(
    numberField(keyframe, 'rawSampleCount'),
    numberField(keyframe, 'retainedSamples')
  );
  const keyframeFusedSurfels = numberField(keyframe, 'fusedSurfelCount');

  if (numberField(keyframe, 'keyframes') !== captureKeyframes) {
    return `Keyframe/capture telemetry mismatch: keyframes ${numberField(keyframe, 'keyframes')} !== ${captureKeyframes}`;
  }
  if (keyframeRawSamples !== captureRawSamples) {
    return `Keyframe/capture telemetry mismatch: accepted raw samples ${keyframeRawSamples} !== ${captureRawSamples}`;
  }
  if (keyframeFusedSurfels > 0 && keyframeFusedSurfels !== captureSurfels) {
    return `Keyframe/capture telemetry mismatch: fused surfels ${keyframeFusedSurfels} !== ${captureSurfels}`;
  }
  for (const [label, metric] of [
    ['render', render],
    ['export', exported],
  ] as const) {
    if (numberField(metric, 'keyframes') !== captureKeyframes) {
      return `Capture/${label} telemetry mismatch: keyframes ${captureKeyframes} !== ${numberField(metric, 'keyframes')}`;
    }
    if (numberField(metric, 'surfelCount') !== captureSurfels) {
      return `Capture/${label} telemetry mismatch: surfels ${captureSurfels} !== ${numberField(metric, 'surfelCount')}`;
    }
  }
  if (numberField(render, 'rawSampleCount') !== captureRawSamples) {
    return `Capture/render telemetry mismatch: raw samples ${captureRawSamples} !== ${numberField(render, 'rawSampleCount')}`;
  }
  const keyframeAppendMs = numberField(keyframe, 'appendMs');
  if (keyframeAppendMs > budgets.maxKeyframeAppendMs) {
    return `Keyframe append budget exceeded: ${keyframeAppendMs}ms > ${budgets.maxKeyframeAppendMs}ms`;
  }
  const depthGridSamples = numberField(keyframe, 'depthGridSamples');
  if (depthGridSamples > budgets.maxKeyframeDepthGridSamples) {
    return `Keyframe depth-grid sample budget exceeded: ${depthGridSamples} > ${budgets.maxKeyframeDepthGridSamples}`;
  }
  const unprojectionMode = stringField(keyframe, 'unprojectionMode');
  if (unprojectionMode && unprojectionMode !== EXPECTED_KEYFRAME_UNPROJECTION_MODE) {
    return `Keyframe unprojection fast path missed: ${unprojectionMode}`;
  }
  const depthType = stringField(keyframe, 'depthType');
  if (depthType && depthType !== EXPECTED_KEYFRAME_DEPTH_TYPE) {
    return `Keyframe depth type was not smooth: ${depthType}`;
  }
  const depthGridSampleMode = stringField(keyframe, 'depthGridSampleMode');
  if (depthGridSampleMode && depthGridSampleMode !== EXPECTED_DEPTH_GRID_SAMPLE_MODE) {
    return `Keyframe depth-grid fast path missed: ${depthGridSampleMode}`;
  }
  const cameraSampleMode = stringField(keyframe, 'cameraSampleMode');
  if (cameraSampleMode && cameraSampleMode !== EXPECTED_CAMERA_SAMPLE_MODE) {
    return `Keyframe camera-color fast path missed: ${cameraSampleMode}`;
  }
  const captureBuildMs = numberField(capture, 'buildMs');
  if (captureBuildMs > budgets.maxCaptureBuildMs) {
    return `Capture build budget exceeded: ${captureBuildMs}ms > ${budgets.maxCaptureBuildMs}ms`;
  }
  const renderBuildMs = numberField(render, 'buildMs');
  if (renderBuildMs > budgets.maxRenderBuildMs) {
    return `Render build budget exceeded: ${renderBuildMs}ms > ${budgets.maxRenderBuildMs}ms`;
  }
  const cameraColorPercent = Math.min(
    numberField(capture, 'cameraColorPercent'),
    numberField(render, 'cameraColorPercent')
  );
  if (cameraColorPercent < budgets.minCameraColorPercent) {
    return `Camera-color quality budget missed: ${cameraColorPercent}% < ${budgets.minCameraColorPercent}%`;
  }
  const normalPercent = Math.min(
    numberField(capture, 'normalPercent'),
    numberField(render, 'normalPercent')
  );
  if (normalPercent < budgets.minNormalPercent) {
    return `Normal quality budget missed: ${normalPercent}% < ${budgets.minNormalPercent}%`;
  }
  const multiObservationPercent = Math.min(
    numberField(capture, 'multiObservationPercent'),
    numberField(render, 'multiObservationPercent')
  );
  if (multiObservationPercent < budgets.minMultiObservationPercent) {
    return `Stable-surface quality budget missed: ${multiObservationPercent}% < ${budgets.minMultiObservationPercent}%`;
  }
  const largestBound = largestBoundsMeter(capture);
  if (largestBound < budgets.minLargestBoundMeters) {
    return `Scene bounds quality budget missed: ${largestBound}m < ${budgets.minLargestBoundMeters}m`;
  }
  const liveProfile = seen.PANORAMIC_LIVE_MODEL_PROFILE;
  if (liveProfile && numberField(liveProfile, 'buildMs') > budgets.maxLiveBuildMs) {
    return `Live model build budget exceeded: ${numberField(liveProfile, 'buildMs')}ms > ${budgets.maxLiveBuildMs}ms`;
  }
  const uploadProfile = seen.PANORAMIC_MODEL_UPLOAD_PROFILE;
  if (uploadProfile && numberField(uploadProfile, 'uploadMs') > budgets.maxModelUploadMs) {
    return `Model upload budget exceeded: ${numberField(uploadProfile, 'uploadMs')}ms > ${budgets.maxModelUploadMs}ms`;
  }
  const previewProfile = seen.PANORAMIC_PREVIEW_METRICS;
  if (previewProfile && numberField(previewProfile, 'buildMs') > budgets.maxPreviewBuildMs) {
    return `Preview build budget exceeded: ${numberField(previewProfile, 'buildMs')}ms > ${budgets.maxPreviewBuildMs}ms`;
  }
  if (previewProfile && numberField(previewProfile, 'cameraColorPercent') < budgets.minCameraColorPercent) {
    return `Preview camera-color quality budget missed: ${numberField(previewProfile, 'cameraColorPercent')}% < ${budgets.minCameraColorPercent}%`;
  }
  if (previewProfile && numberField(previewProfile, 'normalPercent') < budgets.minNormalPercent) {
    return `Preview normal quality budget missed: ${numberField(previewProfile, 'normalPercent')}% < ${budgets.minNormalPercent}%`;
  }
  const scanStats = seen.PANORAMIC_SCAN_STATS;
  if (scanStats && numberField(scanStats, 'coveragePercent') < budgets.minScanCoveragePercent) {
    return `Scan coverage budget missed: ${numberField(scanStats, 'coveragePercent')}% < ${budgets.minScanCoveragePercent}%`;
  }
  return null;
}

function largestBoundsMeter(metric: Record<string, unknown>): number {
  const value = metric.boundsMeters;
  return Array.isArray(value)
    ? Math.max(0, ...value.map((entry) => typeof entry === 'number' && Number.isFinite(entry) ? entry : 0))
    : 0;
}

export function validateRequiredMetricSet(
  seen: SeenMetrics,
  budgets: PanoramaValidationBudgets = DEFAULT_VALIDATION_BUDGETS
): void {
  const error = metricSetValidationError(seen, budgets);
  if (error) {
    throw new Error(error);
  }
}

export function panoramaBottleneckSummary(seen: SeenMetrics, limit = 8): string[] {
  const timings = panoramaTimingEntries(seen)
    .filter((entry) => entry.ms > 0)
    .sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label));
  const lines: string[] = [];
  const selectedTimings = timings.slice(0, Math.max(1, Math.floor(limit)));
  if (selectedTimings.length > 0) {
    lines.push(`Top timings: ${selectedTimings.map(formatTimingEntry).join('; ')}`);
  }

  const scanConfig = seen.PANORAMIC_SCAN_CONFIG;
  if (scanConfig) {
    const requestedDepthTypes = Array.isArray(scanConfig.depthTypeRequest)
      ? scanConfig.depthTypeRequest.filter((entry) => typeof entry === 'string').join(',')
      : 'unknown';
    lines.push(
      `Scan config: depth preference ${stringField(scanConfig, 'depthPreference') || 'unknown'}, ` +
      `request [${requestedDepthTypes}], session depth ${stringField(scanConfig, 'sessionDepthType') || 'unknown'}, ` +
      `mesh ${scanConfig.meshRequested === true ? 'requested' : 'off'}`
    );
  }

  const keyframe = seen.PANORAMIC_KEYFRAME_PROFILE;
  if (keyframe) {
    lines.push([
      `Fast paths: unprojection ${stringField(keyframe, 'unprojectionMode') || 'unknown'}`,
      `depth grid ${stringField(keyframe, 'depthGridSampleMode') || 'unknown'}`,
      `camera color ${stringField(keyframe, 'cameraSampleMode') || 'unknown'}`,
    ].join(', '));
    lines.push(`Depth mode: ${stringField(keyframe, 'depthType') || 'unknown'}`);
    const sampleLoopMs = numberField(keyframe, 'sampleLoopMs');
    const appendMs = numberField(keyframe, 'appendMs');
    if (sampleLoopMs > 0 && appendMs > 0) {
      const timingSampleStride = numberField(keyframe, 'timingSampleStride');
      const timedSampleCount = numberField(keyframe, 'timedSampleCount');
      const timingDetail = timingSampleStride > 1 && timedSampleCount > 0
        ? `, timed ${timedSampleCount} at stride ${timingSampleStride}`
        : '';
      lines.push(
        `Keyframe sample loop: ${formatMs(sampleLoopMs)} of ${formatMs(appendMs)} append, ` +
        `${numberField(keyframe, 'profiledSampleCount')} profiled samples${timingDetail}`
      );
    }
    if (
      numberField(keyframe, 'newVoxelCount') > 0 ||
      numberField(keyframe, 'updatedVoxelCount') > 0 ||
      numberField(keyframe, 'newVoxelPercent') > 0
    ) {
      lines.push(
        `Keyframe fusion contribution: ${formatPercent(numberField(keyframe, 'newVoxelPercent'))} new voxels, ` +
        `${numberField(keyframe, 'observedDepthSurfels')} observed depth surfels, ` +
        `${numberField(keyframe, 'newVoxelCount')} new / ${numberField(keyframe, 'updatedVoxelCount')} updated` +
        optionalCountSuffix(numberField(keyframe, 'planeProjectedSamples'), 'plane-projected samples') +
        optionalCountSuffix(numberField(keyframe, 'matureVoxelSkips'), 'mature overlap skipped')
      );
    }
    if (
      numberField(keyframe, 'meshSurfelCount') > 0 ||
      numberField(keyframe, 'meshPreflightSurfelCount') > 0
    ) {
      const meshNormalMode = stringField(keyframe, 'meshNormalMode') || 'none';
      lines.push(
        `Keyframe mesh supplement: ${numberField(keyframe, 'meshSurfelCount')} fused surfels, ` +
        `${numberField(keyframe, 'meshProjectedSurfels')} projected, ` +
        `${numberField(keyframe, 'meshSkippedSurfels')} skipped` +
        optionalCountSuffix(numberField(keyframe, 'meshStrideSkippedCandidates'), 'stride candidates skipped') +
        optionalCountSuffix(numberField(keyframe, 'meshPlaneProjectedSamples'), 'plane-projected samples') +
        `, ` +
        `${numberField(keyframe, 'meshNewVoxelCount')} new voxels, ` +
        `normals ${meshNormalMode} (${numberField(keyframe, 'meshNormalCount')}), ` +
        `preflight ${numberField(keyframe, 'meshPreflightSurfelCount')} surfels / ` +
        `${numberField(keyframe, 'meshPreflightNewVoxelCount')} new voxels` +
        optionalCountSuffix(
          numberField(keyframe, 'meshPreflightStrideSkippedCandidates'),
          'preflight stride candidates skipped'
        ) +
        `, ` +
        `early stop ${keyframe.meshPreflightEarlyStopped === true ? 'yes' : 'no'}, ` +
        `depth gate recovered ${keyframe.meshRecoveredDepthGate === true ? 'yes' : 'no'}`
      );
    }
    if (numberField(keyframe, 'meshFetchMs') > 0) {
      lines.push(`Keyframe mesh fetch: ${formatMs(numberField(keyframe, 'meshFetchMs'))}`);
    }
    if (keyframe.meshAppendSkipped === true) {
      lines.push(`Keyframe mesh append skipped: ${stringField(keyframe, 'meshAppendReason') || 'unknown'}`);
    }
    if (
      numberField(keyframe, 'meshPreflightMs') > 0 ||
      numberField(keyframe, 'depthRecoveryAppendMs') > 0 ||
      keyframe.meshRecoveredDepthGate === true
    ) {
      lines.push(
        `Keyframe gate recovery: initial depth ${formatMs(numberField(keyframe, 'depthInitialAppendMs'))}, ` +
        `mesh preflight ${formatMs(numberField(keyframe, 'meshPreflightMs'))}, ` +
        `depth recovery ${formatMs(numberField(keyframe, 'depthRecoveryAppendMs'))}`
      );
    }
    if (keyframe.depthRecoverySkipped === true) {
      lines.push('Keyframe depth recovery append skipped because mesh geometry carried the keyframe');
    }
    const focalPixels = tupleField(keyframe, 'projectionFocalPixels');
    const principalPixel = tupleField(keyframe, 'projectionPrincipalPixel');
    if (focalPixels && principalPixel) {
      lines.push(
        `Projection pixels: focal ${formatNumber(focalPixels[0], 1)}x${formatNumber(focalPixels[1], 1)}, ` +
        `principal ${formatNumber(principalPixel[0], 1)},${formatNumber(principalPixel[1], 1)}`
      );
    }
  }

  const capture = seen.PANORAMIC_CAPTURE_METRICS;
  if (capture) {
    lines.push(
      `Capture quality: camera color ${formatPercent(numberField(capture, 'cameraColorPercent'))}, ` +
      `normals ${formatPercent(numberField(capture, 'normalPercent'))}, ` +
      `stable ${formatPercent(numberField(capture, 'multiObservationPercent'))}, ` +
      `fusion ${formatPercent(numberField(capture, 'fusionPercent'))}, ` +
      `largest bound ${formatMeters(largestBoundsMeter(capture))}`
    );
  }

  const nativePayload = seen.PANORAMIC_NATIVE_PAYLOAD_PROFILE;
  if (nativePayload) {
    lines.push(
      `Depth payload: valid ${formatPercent(numberField(nativePayload, 'validDepthPercent'))}, ` +
      `invalid ${formatPercent(numberField(nativePayload, 'invalidDepthPercent'))}, ` +
      `low confidence ${formatPercent(numberField(nativePayload, 'lowConfidencePercent'))}, ` +
      `confidence-filtered ${formatPercent(numberField(nativePayload, 'confidenceFilteredPercent'))}, ` +
      `confidence map ${nativePayload.confidenceMapUsed === true ? 'yes' : 'no'}, ` +
      `fallback ${nativePayload.confidenceFallbackUsed === true ? 'yes' : 'no'}`
    );
    if (
      numberField(nativePayload, 'depthMinMeters') > 0 ||
      numberField(nativePayload, 'depthMeanMeters') > 0 ||
      numberField(nativePayload, 'depthMaxMeters') > 0
    ) {
      lines.push(
        `Depth range: min ${formatMeters(numberField(nativePayload, 'depthMinMeters'))}, ` +
        `mean ${formatMeters(numberField(nativePayload, 'depthMeanMeters'))}, ` +
        `max ${formatMeters(numberField(nativePayload, 'depthMaxMeters'))}`
      );
    }
    const depthSize = tupleField(nativePayload, 'depthSize');
    const cameraCapturedSize = tupleField(nativePayload, 'cameraCapturedSize');
    const depthToCameraScale = tupleField(nativePayload, 'depthToCameraScale');
    const projectionCameraImageResolution = tupleField(nativePayload, 'projectionCameraImageResolution');
    const projectionDepthToCameraScale = tupleField(nativePayload, 'projectionDepthToCameraScale');
    if (depthSize && cameraCapturedSize && depthToCameraScale) {
      lines.push(
        `Native geometry: depth ${formatNumber(depthSize[0], 0)}x${formatNumber(depthSize[1], 0)}, ` +
        `captured ${formatNumber(cameraCapturedSize[0], 0)}x${formatNumber(cameraCapturedSize[1], 0)}, ` +
        `depth/camera scale ${formatNumber(depthToCameraScale[0], 4)}x${formatNumber(depthToCameraScale[1], 4)}`
      );
    }
    if (projectionCameraImageResolution && projectionDepthToCameraScale) {
      lines.push(
        `Native projection basis: camera image ${formatNumber(projectionCameraImageResolution[0], 0)}x` +
        `${formatNumber(projectionCameraImageResolution[1], 0)}, depth/projection scale ` +
        `${formatNumber(projectionDepthToCameraScale[0], 4)}x${formatNumber(projectionDepthToCameraScale[1], 4)}`
      );
    }
    const cameraPreviewPath = stringField(nativePayload, 'cameraPreviewPath');
    if (cameraPreviewPath) {
      lines.push(`Native camera preview path: ${cameraPreviewPath}`);
    }
  }

  const meshProfile = seen.PANORAMIC_MESH_PROFILE;
  if (meshProfile) {
    const vertexCount = numberField(meshProfile, 'vertexCount');
    const triangleCount = numberField(meshProfile, 'triangleCount');
    lines.push(vertexCount > 0 || triangleCount > 0
      ? `AR mesh: ${numberField(meshProfile, 'meshCount')} anchors, ` +
        `${vertexCount} vertices, ${triangleCount} triangles`
      : `AR mesh: ${numberField(meshProfile, 'meshCount')} anchors`);
  }

  const nativeMeshPayload = seen.PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE;
  if (nativeMeshPayload) {
    const triangleCount = numberField(nativeMeshPayload, 'triangleCount');
    const sourceTriangleCount = numberField(nativeMeshPayload, 'sourceTriangleCount');
    const decimationDetail = sourceTriangleCount > triangleCount
      ? ` from ${sourceTriangleCount} source triangles, ${numberField(nativeMeshPayload, 'decimatedMeshCount')} decimated`
      : '';
    lines.push(
      `Native mesh payload: ${numberField(nativeMeshPayload, 'meshCount')} meshes, ` +
      `${numberField(nativeMeshPayload, 'vertexCount')} vertices, ` +
      `${triangleCount} triangles${decimationDetail}, ` +
      `${numberField(nativeMeshPayload, 'normalCount')} normals, ` +
      `${numberField(nativeMeshPayload, 'meshBytes')} bytes, ` +
      `${numberField(nativeMeshPayload, 'cachedMeshCount')} cached / ` +
      `${numberField(nativeMeshPayload, 'copiedMeshCount')} copied`
    );
  }

  const geometry = seen.PANORAMIC_CAPTURE_GEOMETRY;
  if (geometry) {
    lines.push(
      `Geometry: normal-projected span ${formatMeters(numberField(geometry, 'normalProjectedSpanMeters'))}, ` +
      `rms ${formatMeters(numberField(geometry, 'normalProjectedRmsMeters'))}, ` +
      `normal coherence ${formatPercent(numberField(geometry, 'normalCoherencePercent'))}`
    );
  }

  const scan = seen.PANORAMIC_SCAN_STATS;
  if (scan) {
    lines.push(
      `Scan loop: ${numberField(scan, 'acceptedKeyframes')}/${numberField(scan, 'frameCount')} frames accepted, ` +
      `coverage ${formatPercent(numberField(scan, 'coveragePercent'))}, ` +
      `scan ${formatNumber(numberField(scan, 'scanFps'), 1)} fps, ` +
      `accepted ${formatNumber(numberField(scan, 'acceptedKeyframeFps'), 2)} fps, ` +
      `new voxels ${formatPercent(numberField(scan, 'newVoxelPercent'))}, ` +
      `retained ${numberField(scan, 'retainedSamples')} samples${fusedSurfelDetail(scan)}, ` +
      `avg pose ${formatMs(numberField(scan, 'avgPoseMs'))}, ` +
      `avg depth ${formatMs(numberField(scan, 'avgDepthInfoMs'))}, ` +
      `avg append ${formatMs(numberField(scan, 'avgAppendMs'))}`
    );
    const rejectionSummary = scanRejectionSummary(scan);
    if (rejectionSummary) {
      lines.push(
        `Scan misses: pose ${numberField(scan, 'poseMisses')}, depth ${numberField(scan, 'depthMisses')}, ` +
        `precheck skips ${numberField(scan, 'depthPrecheckSkips')}, rejected ${rejectionSummary}`
      );
    }
  }

  const poseProfile = seen.PANORAMIC_XR_POSE_PROFILE;
  if (poseProfile) {
    const worldMapping = stringField(poseProfile, 'worldMappingStatus');
    const returnedPose = poseProfile.returnedPose === true;
    lines.push(
      `Viewer pose ${returnedPose ? 'degraded' : 'unavailable'}: ` +
      `tracking ${stringField(poseProfile, 'trackingState') || 'unknown'}, ` +
      `world mapping ${worldMapping || 'unknown'}, frame ${numberField(poseProfile, 'frameNumber')}`
    );
  }

  const rejectionProfile = seen.PANORAMIC_KEYFRAME_REJECTION_PROFILE;
  if (rejectionProfile) {
    const observedDepthSurfels = numberField(rejectionProfile, 'observedDepthSurfels');
    const combinedSurfels = numberField(rejectionProfile, 'combinedPreflightSurfels');
    const surfelDetail = combinedSurfels > 0
      ? `, observed depth ${observedDepthSurfels}, depth+mesh ${combinedSurfels}`
      : observedDepthSurfels > 0
        ? `, observed depth ${observedDepthSurfels}`
        : '';
    const errorMessage = stringField(rejectionProfile, 'errorMessage');
    const errorDetail = errorMessage
      ? `, error ${stringField(rejectionProfile, 'errorName') || 'Error'}: ${errorMessage}`
      : '';
    lines.push(
      `Keyframe rejection: ${stringField(rejectionProfile, 'reason') || 'unknown'}, ` +
      `${numberField(rejectionProfile, 'keyframes')} keyframes, frame ${numberField(rejectionProfile, 'frameCount')}, ` +
      `retained ${numberField(rejectionProfile, 'retainedSamples')} samples${fusedSurfelDetail(rejectionProfile)}, ` +
      `translation ${formatMeters(numberField(rejectionProfile, 'translationM'))}, ` +
      `rotation ${formatNumber(numberField(rejectionProfile, 'rotationDeg'), 1)}deg${errorDetail}${surfelDetail}`
    );
  }

  const framePump = seen.PANORAMIC_XR_FRAME_PUMP_PROFILE;
  if (framePump) {
    const arFrameNumber = numberField(framePump, 'arFrameNumber');
    const depthFrameArFrameNumber = numberField(framePump, 'depthFrameArFrameNumber');
    const depthFrameLag = arFrameNumber > 0 && depthFrameArFrameNumber > 0
      ? Math.max(0, arFrameNumber - depthFrameArFrameNumber)
      : 0;
    const depthARFrameDetail = depthFrameArFrameNumber > 0
      ? `, depth AR frame ${depthFrameArFrameNumber} lag ${depthFrameLag}`
      : '';
    lines.push(
      `XR frame pump: ${stringField(framePump, 'reason') || 'unknown'}, ` +
      `depth frame ${numberField(framePump, 'latestFrameNumber')} delivered ${numberField(framePump, 'lastDeliveredFrameNumber')}, ` +
      `AR frame ${arFrameNumber} (+${numberField(framePump, 'arFrameDelta')})${depthARFrameDetail}, ` +
      `depth misses ${numberField(framePump, 'depthMisses')} consecutive ${numberField(framePump, 'consecutiveDepthMisses')}, ` +
      optionalErrorDetail(framePump) +
      `delivered polls ${numberField(framePump, 'deliveredFramePolls')}, ` +
      `native errors ${numberField(framePump, 'nativeFrameErrorPolls')}, ` +
      `stale polls ${numberField(framePump, 'staleFramePolls')}`
    );
  }

  const loopStop = seen.PANORAMIC_XR_SCAN_LOOP_STOP_PROFILE;
  if (loopStop) {
    lines.push(
      `XR scan loop stopped: ${stringField(loopStop, 'reason') || 'unknown'}, ` +
      `status ${stringField(loopStop, 'status') || 'unknown'}, ` +
      `${numberField(loopStop, 'acceptedKeyframes')}/${numberField(loopStop, 'frameCount')} frames accepted, ` +
      `retained ${numberField(loopStop, 'retainedSamples')} samples${fusedSurfelDetail(loopStop)}, ` +
      `captureInFlight ${loopStop.captureInFlight === true ? 'yes' : 'no'}, ` +
      `sessionEnded ${loopStop.sessionEnded === true ? 'yes' : 'no'}, ` +
      `sessionMatches ${loopStop.sessionMatches === false ? 'no' : 'yes'}`
    );
  }

  const firstFrameDiagnosis = panoramaFirstFrameDiagnosis(seen);
  if (firstFrameDiagnosis) {
    lines.push(firstFrameDiagnosis);
  }

  return lines;
}

function panoramaFirstFrameDiagnosis(seen: SeenMetrics): string {
  const keyframeProfile = seen.PANORAMIC_KEYFRAME_PROFILE;
  const scan = seen.PANORAMIC_SCAN_STATS;
  const rejectionProfile = seen.PANORAMIC_KEYFRAME_REJECTION_PROFILE;
  const framePump = seen.PANORAMIC_XR_FRAME_PUMP_PROFILE;
  const loopStop = seen.PANORAMIC_XR_SCAN_LOOP_STOP_PROFILE;
  const acceptedKeyframes = Math.max(
    numberField(keyframeProfile ?? {}, 'keyframes'),
    numberField(scan ?? {}, 'acceptedKeyframes'),
    numberField(rejectionProfile ?? {}, 'keyframes')
  );
  if (acceptedKeyframes > 1) {
    const latestKeyframeSamples = numberField(keyframeProfile ?? {}, 'surfelCount');
    const rawSamples = Math.max(
      numberField(keyframeProfile ?? {}, 'rawSampleCount'),
      numberField(keyframeProfile ?? {}, 'retainedSamples')
    );
    const displayedSurfels = Math.max(
      numberField(keyframeProfile ?? {}, 'fusedSurfelCount'),
      numberField(seen.PANORAMIC_LIVE_MODEL_PROFILE ?? {}, 'surfelCount'),
      numberField(seen.PANORAMIC_PREVIEW_METRICS ?? {}, 'surfelCount'),
      numberField(seen.PANORAMIC_RENDER_FRAME_PROFILE ?? {}, 'surfelCount')
    );
    if (latestKeyframeSamples > 0 && rawSamples > latestKeyframeSamples && displayedSurfels > 0 && displayedSurfels <= latestKeyframeSamples) {
      return `Displayed-surfels diagnosis: ${acceptedKeyframes} keyframes accepted and ${rawSamples} raw samples observed, but only ${displayedSurfels} fused/displayed surfels remain; this points to voxel fusion collapsing later samples or stale model publication rather than frame delivery`;
    }
    return '';
  }

  if (stringField(rejectionProfile ?? {}, 'reason') === 'scan-loop-error') {
    const errorName = stringField(rejectionProfile ?? {}, 'errorName') || 'Error';
    const errorMessage = stringField(rejectionProfile ?? {}, 'errorMessage') || 'see keyframe rejection profile';
    return `First-frame diagnosis: scan loop callback threw after ${acceptedKeyframes} keyframe(s): ${errorName}: ${errorMessage}`;
  }

  if (loopStop) {
    const reason = stringField(loopStop, 'reason') || 'unknown';
    const status = stringField(loopStop, 'status') || 'unknown';
    return `First-frame diagnosis: XR scan loop stopped after ${numberField(loopStop, 'frameCount')} frame(s) and ${acceptedKeyframes} keyframe(s) because ${humanizeScanLoopStopReason(reason)}; status ${status}, captureInFlight ${loopStop.captureInFlight === true ? 'yes' : 'no'}, sessionEnded ${loopStop.sessionEnded === true ? 'yes' : 'no'}, sessionMatches ${loopStop.sessionMatches === false ? 'no' : 'yes'}`;
  }

  if (framePump) {
    const deliveredFramePolls = numberField(framePump, 'deliveredFramePolls');
    const noFramePolls = numberField(framePump, 'noFramePolls');
    const staleFramePolls = numberField(framePump, 'staleFramePolls');
    const reason = stringField(framePump, 'reason') || 'unknown';
    if (reason === 'native-frame-error') {
      const errorName = stringField(framePump, 'errorName') || 'Error';
      const errorMessage = stringField(framePump, 'errorMessage') || 'see frame pump profile';
      return `First-frame diagnosis: WebXR native frame fetch threw after ${acceptedKeyframes} keyframe(s): ${errorName}: ${errorMessage}`;
    }
    if (deliveredFramePolls <= 1 && (noFramePolls > 0 || staleFramePolls > 0)) {
      const arFrameDelta = numberField(framePump, 'arFrameDelta');
      const depthFrameDelta = numberField(framePump, 'depthFrameDelta');
      if (staleFramePolls > 0 && arFrameDelta > 0 && depthFrameDelta <= 1) {
        const arFrameNumber = numberField(framePump, 'arFrameNumber');
        const depthFrameArFrameNumber = numberField(framePump, 'depthFrameArFrameNumber');
        const latestFrameNumber = numberField(framePump, 'latestFrameNumber');
        const depthFrameLag = arFrameNumber > 0 && depthFrameArFrameNumber > 0
          ? Math.max(0, arFrameNumber - depthFrameArFrameNumber)
          : 0;
        const depthSourceDetail = depthFrameArFrameNumber > 0
          ? `; last depth came from AR frame ${depthFrameArFrameNumber}, lag ${depthFrameLag}`
          : '';
        const depthMissDetail = numberField(framePump, 'depthMisses') > 0 || numberField(framePump, 'consecutiveDepthMisses') > 0
          ? `, depth misses ${numberField(framePump, 'depthMisses')} consecutive ${numberField(framePump, 'consecutiveDepthMisses')}`
          : '';
        if (latestFrameNumber <= 0) {
          return `First-frame diagnosis: ARKit camera frames are arriving (+${arFrameDelta}), but WebXR scene-depth snapshots have not been produced yet${depthMissDetail}; this points to native scene-depth starvation before JS can add surfels`;
        }
        return `First-frame diagnosis: ARKit camera frames are still arriving (+${arFrameDelta}), but WebXR scene-depth snapshots are stuck on depth frame ${latestFrameNumber}${depthSourceDetail}${depthMissDetail}; this points to native scene-depth starvation rather than JS keyframe rejection`;
      }
      return `First-frame diagnosis: WebXR native frame delivery stalled (${reason}; no-frame ${noFramePolls}, stale ${staleFramePolls}) before the app could add more surfels`;
    }
    if (deliveredFramePolls > 1) {
      const rejected = scan ? scanRejectionSummary(scan) : stringField(rejectionProfile ?? {}, 'reason');
      const detail = rejected ? `; rejected ${rejected}` : '';
      const gateDiagnosis = scan ? dominantKeyframeGateDiagnosis(scan) : '';
      return `First-frame diagnosis: WebXR frames are still being delivered (${deliveredFramePolls} polls), but post-first frames are not accepted by the panorama keyframe gates${detail}${gateDiagnosis}`;
    }
  }

  if (scan && numberField(scan, 'frameCount') > 1) {
    const rejected = scanRejectionSummary(scan);
    const gateDiagnosis = dominantKeyframeGateDiagnosis(scan);
    return `First-frame diagnosis: scan loop ran ${numberField(scan, 'frameCount')} frames but accepted ${acceptedKeyframes}; ${rejected ? `rejected ${rejected}` : 'check pose/depth rejection profiles'}${gateDiagnosis}`;
  }

  return '';
}

function scanRejectionSummary(scan: Record<string, unknown>): string {
  return scanRejectionEntries(scan)
    .map((entry) => `${entry.reason} ${formatNumber(entry.count, 0)}`)
    .join(', ');
}

function dominantKeyframeGateDiagnosis(scan: Record<string, unknown>): string {
  const entries = scanRejectionEntries(scan);
  if (entries.length <= 0) return '';
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  const dominant = entries[0];
  if (dominant.reason === 'too-fast' && dominant.count >= Math.max(3, total * 0.5)) {
    return '; dominant gate too-fast means delivered frames exceeded the pose-speed limit before depth/camera sampling';
  }
  return '';
}

function scanRejectionEntries(scan: Record<string, unknown>): Array<{ count: number; reason: string }> {
  const rejectedByReason = scan.rejectedByReason;
  if (!rejectedByReason || typeof rejectedByReason !== 'object' || Array.isArray(rejectedByReason)) {
    return [];
  }
  return Object.entries(rejectedByReason)
    .map(([reason, count]) => ({
      count: typeof count === 'number' && Number.isFinite(count) ? count : 0,
      reason,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function humanizeScanLoopStopReason(reason: string): string {
  if (reason === 'capture-in-flight') return 'capture was in flight';
  if (reason === 'session-ended') return 'the XR session ended';
  if (reason === 'session-mismatch') return 'a different XR session became current';
  if (reason.startsWith('status-')) return `capture status became ${reason.slice('status-'.length) || 'unknown'}`;
  return reason || 'unknown';
}

function panoramaTimingEntries(seen: SeenMetrics): TimingEntry[] {
  const entries: TimingEntry[] = [];
  const keyframe = seen.PANORAMIC_KEYFRAME_PROFILE;
  if (keyframe) {
    addTiming(entries, keyframe, 'appendMs', 'keyframe append', `${numberField(keyframe, 'surfelCount')} surfels`);
    addTiming(entries, keyframe, 'depthAppendMs', 'depth append segment');
    addTiming(entries, keyframe, 'depthInitialAppendMs', 'initial depth append');
    addTiming(entries, keyframe, 'depthRecoveryAppendMs', 'depth recovery append');
    addTiming(entries, keyframe, 'sampleLoopMs', 'keyframe sample loop');
    addTiming(entries, keyframe, 'depthPreflightMs', 'depth preflight');
    addTiming(entries, keyframe, 'newVoxelPreflightMs', 'new voxel preflight');
    addTiming(entries, keyframe, 'cameraImageMs', 'camera image request');
    addTiming(
      entries,
      keyframe,
      'meshAppendMs',
      'mesh append',
      `${numberField(keyframe, 'meshSurfelCount')} mesh surfels`
    );
    addTiming(entries, keyframe, 'meshFetchMs', 'mesh fetch');
    addTiming(entries, keyframe, 'meshPreflightMs', 'mesh preflight');
    addTiming(entries, keyframe, 'meshCameraImageMs', 'mesh camera image request');
    addTiming(entries, keyframe, 'depthDataMs', 'depth data view');
    addTiming(entries, keyframe, 'normalEstimateMs', 'normal estimation');
    addTiming(entries, keyframe, 'unprojectMs', 'unprojection');
    addTiming(entries, keyframe, 'sampleConsumeMs', 'surfel fusion');
    addTiming(entries, keyframe, 'depthLookupMs', 'depth lookup');
    addTiming(entries, keyframe, 'colorSampleMs', 'camera color sample');
    addTiming(entries, keyframe, 'livePublishMs', 'live publish');
    addTiming(entries, keyframe, 'preSampleMs', 'pose precheck');
  }
  const live = seen.PANORAMIC_LIVE_MODEL_PROFILE;
  if (live) {
    addTiming(entries, live, 'buildMs', 'live model build', `${numberField(live, 'surfelCount')} surfels`);
  }
  const preview = seen.PANORAMIC_PREVIEW_METRICS;
  if (preview) {
    addTiming(entries, preview, 'buildMs', 'preview build', `${numberField(preview, 'surfelCount')} surfels`);
  }
  const capture = seen.PANORAMIC_CAPTURE_METRICS;
  if (capture) {
    addTiming(entries, capture, 'buildMs', 'capture build', `${numberField(capture, 'surfelCount')} surfels`);
  }
  const render = seen.PANORAMIC_RENDER_METRICS;
  if (render) {
    addTiming(entries, render, 'buildMs', 'render model build', `${numberField(render, 'surfelCount')} surfels`);
    addTiming(entries, render, 'renderFrameMs', 'captured render frame', `${numberField(render, 'surfelCount')} surfels`);
    addTiming(entries, render, 'commandEncodeMs', 'captured render encode');
    addTiming(entries, render, 'submitPresentMs', 'captured render submit');
  }
  const renderFrame = seen.PANORAMIC_RENDER_FRAME_PROFILE;
  if (renderFrame) {
    addTiming(
      entries,
      renderFrame,
      'renderFrameMs',
      'WebGPU render frame',
      `${stringField(renderFrame, 'reason') || stringField(renderFrame, 'status') || 'unknown'} ` +
      `${numberField(renderFrame, 'surfelCount')} surfels`
    );
    addTiming(entries, renderFrame, 'commandEncodeMs', 'WebGPU render encode');
    addTiming(entries, renderFrame, 'submitPresentMs', 'WebGPU render submit');
  }
  const upload = seen.PANORAMIC_MODEL_UPLOAD_PROFILE;
  if (upload) {
    addTiming(entries, upload, 'uploadMs', 'WebGPU upload', `${numberField(upload, 'surfelBytes')} bytes`);
  }
  const nativePayload = seen.PANORAMIC_NATIVE_PAYLOAD_PROFILE;
  if (nativePayload) {
    const payloadDetail = [
      nativePayload.includeDepthData === true ? 'depth' : '',
      nativePayload.includeCameraImage === true ? 'camera' : '',
    ].filter(Boolean).join('+') || 'metadata';
    addTiming(entries, nativePayload, 'requestMs', 'native bridge request', payloadDetail);
    addTiming(entries, nativePayload, 'payloadMs', 'native payload build', payloadDetail);
    addTiming(entries, nativePayload, 'depthCopyMs', 'native depth copy');
    addTiming(entries, nativePayload, 'cameraPreviewMs', 'native camera preview');
  }
  const nativeMeshPayload = seen.PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE;
  if (nativeMeshPayload) {
    addTiming(
      entries,
      nativeMeshPayload,
      'requestMs',
      'native mesh bridge request',
      `${numberField(nativeMeshPayload, 'meshBytes')} bytes`
    );
  }
  const scan = seen.PANORAMIC_SCAN_STATS;
  if (scan) {
    addTiming(entries, scan, 'maxAppendMs', 'max keyframe append');
    addTiming(entries, scan, 'avgLivePublishMs', 'avg live publish');
    addTiming(entries, scan, 'avgDepthInfoMs', 'avg depth request');
    addTiming(entries, scan, 'avgPoseMs', 'avg pose request');
  }
  return entries;
}

function addTiming(
  entries: TimingEntry[],
  metric: Record<string, unknown>,
  field: string,
  label: string,
  detail?: string
): void {
  const ms = numberField(metric, field);
  if (ms > 0) {
    entries.push({ detail, label, ms });
  }
}

function formatTimingEntry(entry: TimingEntry): string {
  const detail = entry.detail ? ` (${entry.detail})` : '';
  return `${entry.label} ${formatMs(entry.ms)}${detail}`;
}

function formatMs(value: number): string {
  return `${formatNumber(value, 2)}ms`;
}

function formatPercent(value: number): string {
  return `${formatNumber(value, 1)}%`;
}

function optionalCountSuffix(count: number, label: string): string {
  return count > 0 ? `, ${count} ${label}` : '';
}

function optionalErrorDetail(metric: Record<string, unknown>): string {
  const errorName = stringField(metric, 'errorName');
  const errorMessage = stringField(metric, 'errorMessage');
  return errorName || errorMessage ? `error ${errorName || 'Error'}: ${errorMessage || 'unknown'}, ` : '';
}

function formatMeters(value: number): string {
  return `${formatNumber(value, 3)}m`;
}

function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number(value.toFixed(digits)).toString();
}

export function panoramaProfileReport(
  seen: SeenMetrics,
  { generatedAt = new Date().toISOString(), validated }: { generatedAt?: string; validated: boolean }
): PanoramaProfileReport {
  return {
    bottleneckSummary: panoramaBottleneckSummary(seen),
    generatedAt,
    metrics: seen,
    missingRequiredMetrics: missingMetrics(seen),
    validated,
  };
}

async function writeProfileReportIfRequested(
  seen: SeenMetrics,
  { outJsonPath, validated }: { outJsonPath?: string; validated: boolean }
): Promise<void> {
  if (!outJsonPath) return;
  const report = panoramaProfileReport(seen, { validated });
  await writeFile(outJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Wrote panorama profile report: ${outJsonPath}`);
}

function printMetricSummary(seen: SeenMetrics, { validated }: { validated: boolean }): void {
  console.log(validated ? 'Panorama physical validation passed.' : 'Panorama profile collection complete.');
  const bottleneckLines = panoramaBottleneckSummary(seen);
  if (bottleneckLines.length > 0) {
    console.log('Bottleneck summary:');
    for (const line of bottleneckLines) {
      console.log(`  ${line}`);
    }
  }
  const missing = missingMetrics(seen);
  if (!validated && missing.length > 0) {
    console.log(`Missing required validation metrics: ${missing.join(', ')}`);
  }
  for (const name of REQUIRED_METRICS) {
    if (seen[name]) {
      console.log(`  ${name}: ${JSON.stringify(seen[name])}`);
    }
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
