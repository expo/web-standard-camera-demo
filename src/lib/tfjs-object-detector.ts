import type { GraphModel } from '@tensorflow/tfjs-converter';
import type * as TfjsModule from '@tensorflow/tfjs';
import type { File as ExpoFileSystemFile, FileHandle, FileMode as ExpoFileMode } from 'expo-file-system';

export const TFJS_OBJECT_PROBES = [
  {
    accentColor: '#60a5fa',
    id: 'workspace',
    imageUri: 'https://upload.wikimedia.org/wikipedia/commons/7/76/Arab_keyboard.jpg',
    label: 'Workspace',
  },
  {
    accentColor: '#f97316',
    id: 'cafe',
    imageUri: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/28/Meine_Tasse01.jpg/500px-Meine_Tasse01.jpg',
    label: 'Cafe table',
  },
  {
    accentColor: '#facc15',
    id: 'street',
    imageUri: 'https://upload.wikimedia.org/wikipedia/commons/a/ac/Golf_V_R32_hl_blue.jpg',
    label: 'Street',
  },
  {
    accentColor: '#34d399',
    id: 'nature',
    imageUri: 'https://upload.wikimedia.org/wikipedia/commons/2/26/YellowLabradorLooking_new.jpg',
    label: 'Outdoor',
  },
] as const;

export type ObjectProbeId = (typeof TFJS_OBJECT_PROBES)[number]['id'];

export interface TfjsRuntimeInfo {
  backend: string;
  hasNavigatorGpu: boolean;
  initMs: number;
  isWebGpu: boolean;
}

export interface TfjsObjectCacheInfo {
  cachedProbeInputs: readonly ObjectProbeId[];
  modelLoadPhase: TfjsModelLoadPhase;
  modelLoadCount: number;
  modelStatus: TfjsModelStatus;
  modelWeightSource: TfjsModelWeightSource | null;
  probeDecodeCount: number;
  runtimeInitCount: number;
}

export interface TfjsCameraFrame {
  readonly height: number;
  readonly width: number;
  readonly close?: () => void;
  readonly _data?: Uint8Array;
  readonly _format?: string;
  readonly _frameNumber?: number;
}

export interface ObjectDetectionBox {
  bbox: [number, number, number, number];
  className: string;
  score: number;
}

export interface ObjectSceneSummary {
  confidence: number;
  label: string;
  reason: string;
}

export type TfjsObjectSource =
  | { kind: 'camera'; frameFormat: string; frameNumber?: number; sourceHeight: number; sourceWidth: number }
  | { kind: 'probe'; probe: ObjectProbeId; sourceHeight: number; sourceWidth: number };

export interface TfjsObjectResult {
  backend: TfjsRuntimeInfo;
  cache: TfjsObjectCacheInfo;
  detectMs: number;
  detections: ObjectDetectionBox[];
  input: {
    height: number;
    width: number;
  };
  modelLoadMs: number;
  source: TfjsObjectSource;
  summary: ObjectSceneSummary;
  tensorMs: number;
}

export type TfjsModelWeightSource = 'metro-asset' | 'mixed' | 'native-bundle';
export type TfjsModelLoadPhase = 'idle' | 'runtime' | 'weights' | 'graph' | 'warmup' | 'ready' | 'error';
export type TfjsModelStatus = 'error' | 'idle' | 'loading' | 'ready';

type Tfjs = typeof TfjsModule;

interface ObjectRuntime {
  info: TfjsRuntimeInfo;
  tf: Tfjs;
}

interface ObjectModel {
  graph: GraphModel;
  loadMs: number;
  runtime: ObjectRuntime;
}

interface ObjectInput {
  height: number;
  sourceHeight: number;
  sourceWidth: number;
  tensor: TfjsModule.Tensor3D;
  tensorMs: number;
  width: number;
}

interface CachedProbeInput {
  height: number;
  rgb: Int32Array;
  sourceHeight: number;
  sourceWidth: number;
  width: number;
}

interface ModelJson {
  convertedBy?: string;
  format?: string;
  generatedBy?: string;
  modelTopology: object;
  weightsManifest: {
    paths: string[];
    weights: TfjsModule.io.WeightsManifestEntry[];
  }[];
}

interface CocoClass {
  displayName: string;
}

type MetroAssetModule = string | number | { height: number; uri: string; width: number };
type LoadedModelAssetBuffer = { buffer: ArrayBuffer; source: TfjsModelWeightSource };
type LoadedWeightData = { buffer: ArrayBuffer; source: TfjsModelWeightSource };

const DETECTOR_MAX_EDGE = 320;
const DEFAULT_MAX_BOXES = 8;
const DEFAULT_MIN_SCORE = 0.42;
const MODEL_ASSET_TIMEOUT_MS = 20000;
const FILE_READ_CHUNK_BYTES = 1024 * 1024;
// @ref LLP 0012#demo-6-tensorflowjs-object-lens — the demo vendors COCO-SSD
// model JSON and weight shards so iOS can classify without fetching a model.
const BUNDLED_MODEL_DIR = 'coco-ssd-lite-mobilenet-v2';
const NATIVE_MODEL_ROOT = 'TfjsModels';
/* eslint-disable @typescript-eslint/no-require-imports -- Metro asset ids for bundled model shards are created with require(). */
const BUNDLED_MODEL_JSON = require('../../assets/models/coco-ssd-lite-mobilenet-v2/model.json') as ModelJson;
const BUNDLED_MODEL_SHARDS = [
  {
    filename: 'group1-shard1of5.bin',
    moduleId: require('../../assets/models/coco-ssd-lite-mobilenet-v2/group1-shard1of5.bin'),
  },
  {
    filename: 'group1-shard2of5.bin',
    moduleId: require('../../assets/models/coco-ssd-lite-mobilenet-v2/group1-shard2of5.bin'),
  },
  {
    filename: 'group1-shard3of5.bin',
    moduleId: require('../../assets/models/coco-ssd-lite-mobilenet-v2/group1-shard3of5.bin'),
  },
  {
    filename: 'group1-shard4of5.bin',
    moduleId: require('../../assets/models/coco-ssd-lite-mobilenet-v2/group1-shard4of5.bin'),
  },
  {
    filename: 'group1-shard5of5.bin',
    moduleId: require('../../assets/models/coco-ssd-lite-mobilenet-v2/group1-shard5of5.bin'),
  },
] as const;
const { CLASSES } = require('@tensorflow-models/coco-ssd/dist/classes') as {
  CLASSES: Record<number, CocoClass | undefined>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

let runtimePromise: Promise<ObjectRuntime> | null = null;
let modelPromise: Promise<ObjectModel> | null = null;
let weightDataPromise: Promise<LoadedWeightData> | null = null;
let modelLoadPhase: TfjsModelLoadPhase = 'idle';
let modelStatus: TfjsModelStatus = 'idle';
let modelWeightSource: TfjsModelWeightSource | null = null;
let modelLoadCount = 0;
let probeDecodeCount = 0;
let runtimeInitCount = 0;
const probeInputPromises = new Map<ObjectProbeId, Promise<CachedProbeInput>>();
const cacheListeners = new Set<(info: TfjsObjectCacheInfo) => void>();

export async function detectTfjsObjectProbe(
  probe: ObjectProbeId,
  options?: { maxBoxes?: number; minScore?: number }
): Promise<TfjsObjectResult> {
  const model = await loadTfjsObjectModel();
  const input = await createProbeTensor(model.runtime.tf, probe);
  try {
    return await detectTfjsObjects(
      model,
      input,
      {
        kind: 'probe',
        probe,
        sourceHeight: input.sourceHeight,
        sourceWidth: input.sourceWidth,
      },
      options
    );
  } finally {
    input.tensor.dispose();
  }
}

export async function preloadTfjsObjectModel(): Promise<TfjsObjectCacheInfo> {
  await loadTfjsObjectModel();
  return getTfjsObjectCacheInfo();
}

export function subscribeTfjsObjectCacheInfo(listener: (info: TfjsObjectCacheInfo) => void): () => void {
  cacheListeners.add(listener);
  listener(getTfjsObjectCacheInfo());
  return () => {
    cacheListeners.delete(listener);
  };
}

export async function detectTfjsCameraFrame(
  frame: TfjsCameraFrame,
  options?: { maxBoxes?: number; minScore?: number; rotateForPortrait?: boolean; signal?: AbortSignal }
): Promise<TfjsObjectResult> {
  throwIfAborted(options?.signal);
  const model = await loadTfjsObjectModel();
  throwIfAborted(options?.signal);
  const input = await createCameraFrameTensor(model.runtime.tf, frame, {
    rotateForPortrait: options?.rotateForPortrait,
  });
  try {
    throwIfAborted(options?.signal);
    return await detectTfjsObjects(
      model,
      input,
      {
        kind: 'camera',
        frameFormat: frame._format ?? (frame._data ? 'rgba8unorm' : 'external-image'),
        frameNumber: frame._frameNumber,
        sourceHeight: frame.height,
        sourceWidth: frame.width,
      },
      options
    );
  } finally {
    input.tensor.dispose();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Detection aborted');
  error.name = 'AbortError';
  throw error;
}

export function clearTfjsObjectDetectorCache(): void {
  runtimePromise = null;
  modelPromise = null;
  weightDataPromise = null;
  modelLoadPhase = 'idle';
  modelStatus = 'idle';
  modelWeightSource = null;
  modelLoadCount = 0;
  probeDecodeCount = 0;
  runtimeInitCount = 0;
  probeInputPromises.clear();
  emitTfjsObjectCacheInfo();
}

export function getTfjsObjectCacheInfo(): TfjsObjectCacheInfo {
  return {
    cachedProbeInputs: [...probeInputPromises.keys()],
    modelLoadPhase,
    modelLoadCount,
    modelStatus,
    modelWeightSource,
    probeDecodeCount,
    runtimeInitCount,
  };
}

function setModelLoadState(status: TfjsModelStatus, phase: TfjsModelLoadPhase): void {
  modelStatus = status;
  modelLoadPhase = phase;
  emitTfjsObjectCacheInfo();
}

function emitTfjsObjectCacheInfo(): void {
  if (cacheListeners.size === 0) return;
  const info = getTfjsObjectCacheInfo();
  for (const listener of cacheListeners) {
    listener(info);
  }
}

export function makeObjectSceneSummary(detections: readonly ObjectDetectionBox[]): ObjectSceneSummary {
  const scores = new Map<string, { reason: string; reasonScore: number; score: number }>();

  for (const detection of detections) {
    for (const group of OBJECT_SCENE_GROUPS) {
      if (!(group.classes as readonly string[]).includes(detection.className)) continue;
      const contribution = detection.score * group.weight;
      const previous = scores.get(group.label);
      scores.set(group.label, {
        reason: previous && previous.reasonScore >= contribution ? previous.reason : detection.className,
        reasonScore: Math.max(previous?.reasonScore ?? 0, contribution),
        score: (previous?.score ?? 0) + contribution,
      });
    }
  }

  let best: { label: string; reason: string; score: number } | null = null;
  for (const [label, value] of scores.entries()) {
    if (!best || value.score > best.score) {
      best = { label, reason: value.reason, score: value.score };
    }
  }

  if (best) {
    return {
      confidence: clamp01(best.score),
      label: best.label,
      reason: best.reason,
    };
  }

  const top = detections[0];
  return {
    confidence: clamp01(top?.score ?? 0),
    label: top ? 'Object-first scene' : 'No confident objects',
    reason: top?.className ?? 'none',
  };
}

async function loadTfjsObjectModel(): Promise<ObjectModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      setModelLoadState('loading', 'runtime');
      const runtime = await ensureTfjsRuntime();
      await yieldToUi();
      const start = Date.now();
      const graph = await loadBundledCocoSsdGraphModel(runtime);
      setModelLoadState('loading', 'warmup');
      await yieldToUi();
      const zeroTensor = runtime.tf.zeros([1, 300, 300, 3], 'int32');
      const warmup = await graph.executeAsync(zeroTensor);
      await Promise.all(asTensorArray(warmup).map((tensor) => tensor.data()));
      runtime.tf.dispose(warmup);
      zeroTensor.dispose();
      modelLoadCount += 1;
      setModelLoadState('ready', 'ready');
      return {
        graph,
        loadMs: Date.now() - start,
        runtime,
      };
    })();
  }
  try {
    return await modelPromise;
  } catch (error) {
    modelPromise = null;
    setModelLoadState('error', 'error');
    throw error;
  }
}

async function ensureTfjsRuntime(): Promise<ObjectRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const start = Date.now();
      if (!isWebRuntime() && !globalThis.navigator?.gpu) {
        try {
          await import('react-native-wgpu');
          await yieldToUi();
        } catch {
          // TFJS will fall back to CPU below if the native WebGPU polyfill cannot load.
        }
      }
      const tf = await import('@tensorflow/tfjs');
      await yieldToUi();
      await import('@tensorflow/tfjs-backend-webgpu');
      const hasNavigatorGpu = Boolean(globalThis.navigator?.gpu);

      if (hasNavigatorGpu) {
        try {
          await tf.setBackend('webgpu');
          await tf.ready();
        } catch {
          await tf.setBackend('cpu');
          await tf.ready();
        }
      } else {
        await tf.setBackend('cpu');
        await tf.ready();
      }

      runtimeInitCount += 1;
      const backend = tf.getBackend();
      emitTfjsObjectCacheInfo();
      return {
        info: {
          backend,
          hasNavigatorGpu,
          initMs: Date.now() - start,
          isWebGpu: backend === 'webgpu',
        },
        tf,
      };
    })();
  }
  try {
    return await runtimePromise;
  } catch (error) {
    runtimePromise = null;
    throw error;
  }
}

async function detectTfjsObjects(
  model: ObjectModel,
  input: ObjectInput,
  source: TfjsObjectSource,
  options?: { maxBoxes?: number; minScore?: number }
): Promise<TfjsObjectResult> {
  const detectStart = Date.now();
  const tf = model.runtime.tf;
  const batched = tf.tidy(() => tf.expandDims(input.tensor));
  const output = asTensorArray(await model.graph.executeAsync(batched));
  const scoresTensor = output[0];
  const boxesTensor = output[1];
  if (!scoresTensor || !boxesTensor) {
    batched.dispose();
    tf.dispose(output);
    throw new Error('COCO-SSD graph returned an unexpected output shape');
  }
  const scoresShape = scoresTensor.shape;
  const boxesShape = boxesTensor.shape;
  const [scores, boxes] = await Promise.all([scoresTensor.data(), boxesTensor.data()]);
  batched.dispose();
  tf.dispose(output);

  const [maxScores, classes] = calculateMaxScores(scores, scoresShape[1] ?? 0, scoresShape[2] ?? 0);
  const boxes2d = tf.tensor2d(boxes, [boxesShape[1] ?? 0, boxesShape[3] ?? 4]);
  const scores1d = tf.tensor1d(maxScores);
  let indexesTensor: TfjsModule.Tensor1D | null = null;
  let indexes: number[];
  try {
    indexesTensor = await tf.image.nonMaxSuppressionAsync(
      boxes2d,
      scores1d,
      options?.maxBoxes ?? DEFAULT_MAX_BOXES,
      options?.minScore ?? DEFAULT_MIN_SCORE,
      options?.minScore ?? DEFAULT_MIN_SCORE
    );
    indexes = Array.from(await indexesTensor.data());
  } finally {
    indexesTensor?.dispose();
    boxes2d.dispose();
    scores1d.dispose();
  }

  const detections = buildDetectedObjects(
    input.width,
    input.height,
    boxes,
    maxScores,
    indexes,
    classes
  );

  return {
    backend: model.runtime.info,
    cache: getTfjsObjectCacheInfo(),
    detectMs: Date.now() - detectStart,
    detections,
    input: {
      height: input.height,
      width: input.width,
    },
    modelLoadMs: model.loadMs,
    source,
    summary: makeObjectSceneSummary(detections),
    tensorMs: input.tensorMs,
  };
}

async function loadBundledCocoSsdGraphModel(runtime: ObjectRuntime): Promise<GraphModel> {
  setModelLoadState('loading', 'weights');
  const weightData = await loadBundledWeightData();
  await yieldToUi();
  setModelLoadState('loading', 'graph');
  const tfconv = await import('@tensorflow/tfjs-converter');
  await yieldToUi();
  const handler = runtime.tf.io.fromMemory({
    convertedBy: BUNDLED_MODEL_JSON.convertedBy,
    format: BUNDLED_MODEL_JSON.format,
    generatedBy: BUNDLED_MODEL_JSON.generatedBy,
    modelTopology: BUNDLED_MODEL_JSON.modelTopology,
    weightData: weightData.buffer,
    weightSpecs: BUNDLED_MODEL_JSON.weightsManifest.flatMap((group) => group.weights),
  });
  return await withTimeout(
    tfconv.loadGraphModel(handler, undefined, runtime.tf.io),
    MODEL_ASSET_TIMEOUT_MS,
    'COCO-SSD graph load'
  );
}

async function loadBundledWeightData(): Promise<LoadedWeightData> {
  if (!weightDataPromise) {
    weightDataPromise = (async () => {
      const buffers: ArrayBuffer[] = [];
      const sources = new Set<TfjsModelWeightSource>();
      for (let i = 0; i < BUNDLED_MODEL_SHARDS.length; i += 1) {
        const shard = BUNDLED_MODEL_SHARDS[i];
        const asset = await withTimeout(
          readBundledAssetArrayBuffer(shard.filename, shard.moduleId as MetroAssetModule),
          MODEL_ASSET_TIMEOUT_MS,
          `COCO-SSD weight shard ${i + 1}`
        );
        buffers.push(asset.buffer);
        sources.add(asset.source);
        await yieldToUi();
      }
      const source = sources.size === 1
        ? [...sources][0] ?? 'metro-asset'
        : 'mixed';
      modelWeightSource = source;
      emitTfjsObjectCacheInfo();
      return {
        buffer: await concatArrayBuffers(buffers),
        source,
      };
    })();
  }
  try {
    return await weightDataPromise;
  } catch (error) {
    weightDataPromise = null;
    modelWeightSource = null;
    throw error;
  }
}

async function readBundledAssetArrayBuffer(
  filename: string,
  moduleId: MetroAssetModule
): Promise<LoadedModelAssetBuffer> {
  const nativeBuffer = await readNativeBundledModelAsset(filename);
  if (nativeBuffer) {
    return {
      buffer: nativeBuffer,
      source: 'native-bundle',
    };
  }

  const { Asset } = await import('expo-asset');
  const asset = Asset.fromModule(moduleId);

  if (!isWebRuntime()) {
    const downloaded = await asset.downloadAsync();
    return {
      buffer: await readAssetArrayBuffer(downloaded.localUri ?? downloaded.uri),
      source: 'metro-asset',
    };
  }

  return {
    buffer: await readAssetArrayBuffer(asset.uri),
    source: 'metro-asset',
  };
}

async function readNativeBundledModelAsset(filename: string): Promise<ArrayBuffer | null> {
  if (isWebRuntime()) return null;
  try {
    const { File, FileMode, Paths } = await import('expo-file-system');
    const file = new File(
      ensureFileUri(Paths.bundle.uri),
      NATIVE_MODEL_ROOT,
      BUNDLED_MODEL_DIR,
      filename
    );
    if (!file.exists) return null;
    return await readFileWithHandle(file, FileMode.ReadOnly);
  } catch {
    return null;
  }
}

function ensureFileUri(uri: string): string {
  if (uri.startsWith('file://')) return uri;
  return `file://${uri.startsWith('/') ? '' : '/'}${uri}`;
}

function isWebRuntime(): boolean {
  return process.env.EXPO_OS === 'web';
}

async function readAssetArrayBuffer(uri: string): Promise<ArrayBuffer> {
  if (uri.startsWith('file://')) {
    const { File: ExpoFile, FileMode } = await import('expo-file-system');
    return await readFileWithHandle(new ExpoFile(uri), FileMode.ReadOnly);
  }
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Could not load bundled model asset ${response.status}: ${uri}`);
  }
  return await response.arrayBuffer();
}

async function readFileWithHandle(
  file: Pick<ExpoFileSystemFile, 'open'>,
  readOnlyMode: ExpoFileMode
): Promise<ArrayBuffer> {
  const handle: FileHandle = file.open(readOnlyMode);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let remaining = handle.size;

  try {
    while (remaining == null || remaining > 0) {
      const length = remaining == null
        ? FILE_READ_CHUNK_BYTES
        : Math.min(FILE_READ_CHUNK_BYTES, remaining);
      const chunk = handle.readBytes(length);
      if (chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (remaining != null) {
        remaining -= chunk.byteLength;
      }
      await yieldToUi();
    }
  } finally {
    handle.close();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
      return;
    }
    setTimeout(resolve, 0);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function concatArrayBuffers(buffers: readonly ArrayBuffer[]): Promise<ArrayBuffer> {
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    out.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
    await yieldToUi();
  }
  return out.buffer;
}

function asTensorArray(value: TfjsModule.Tensor | TfjsModule.Tensor[]): TfjsModule.Tensor[] {
  return Array.isArray(value) ? value : [value];
}

function calculateMaxScores(
  scores: ArrayLike<number>,
  numBoxes: number,
  numClasses: number
): [number[], number[]] {
  const maxScores: number[] = [];
  const classes: number[] = [];
  for (let i = 0; i < numBoxes; i += 1) {
    let maxScore = Number.MIN_VALUE;
    let classIndex = -1;
    for (let j = 0; j < numClasses; j += 1) {
      const score = Number(scores[i * numClasses + j] ?? 0);
      if (score > maxScore) {
        maxScore = score;
        classIndex = j;
      }
    }
    maxScores[i] = maxScore;
    classes[i] = classIndex;
  }
  return [maxScores, classes];
}

function buildDetectedObjects(
  width: number,
  height: number,
  boxes: ArrayLike<number>,
  scores: readonly number[],
  indexes: readonly number[],
  classes: readonly number[]
): ObjectDetectionBox[] {
  const objects: ObjectDetectionBox[] = [];
  for (const index of indexes) {
    const ymin = Number(boxes[index * 4] ?? 0) * height;
    const xmin = Number(boxes[index * 4 + 1] ?? 0) * width;
    const ymax = Number(boxes[index * 4 + 2] ?? 0) * height;
    const xmax = Number(boxes[index * 4 + 3] ?? 0) * width;
    const className = CLASSES[(classes[index] ?? -1) + 1]?.displayName ?? 'object';
    objects.push({
      bbox: normalizeBbox([xmin, ymin, xmax - xmin, ymax - ymin], width, height),
      className,
      score: clamp01(scores[index] ?? 0),
    });
  }
  return objects;
}

async function createProbeTensor(tf: Tfjs, probe: ObjectProbeId): Promise<ObjectInput> {
  const start = Date.now();
  const input = await loadProbeInput(probe);
  return {
    height: input.height,
    sourceHeight: input.sourceHeight,
    sourceWidth: input.sourceWidth,
    tensor: tf.tensor3d(input.rgb, [input.height, input.width, 3], 'int32'),
    tensorMs: Date.now() - start,
    width: input.width,
  };
}

async function loadProbeInput(probe: ObjectProbeId): Promise<CachedProbeInput> {
  let promise = probeInputPromises.get(probe);
  if (!promise) {
    promise = decodeProbeInput(probe);
    probeInputPromises.set(probe, promise);
  }
  try {
    return await promise;
  } catch (error) {
    probeInputPromises.delete(probe);
    throw error;
  }
}

async function decodeProbeInput(probe: ObjectProbeId): Promise<CachedProbeInput> {
  const source = TFJS_OBJECT_PROBES.find((candidate) => candidate.id === probe);
  if (!source) throw new Error(`Unknown object probe: ${probe}`);

  const response = await fetch(source.imageUri);
  if (!response.ok) {
    throw new Error(`Could not fetch object probe ${response.status}: ${source.imageUri}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const jpegModule = await import('jpeg-js');
  const decode = jpegModule.decode ?? jpegModule.default?.decode;
  if (!decode) throw new Error('jpeg-js decoder is unavailable');
  const decoded = decode(bytes, { useTArray: true });
  const target = fitWithinMaxEdge(decoded.width, decoded.height);
  const rgb = sampleRgbaToRgb(decoded.data, decoded.width, decoded.height, target.width, target.height);
  probeDecodeCount += 1;
  return {
    height: target.height,
    rgb,
    sourceHeight: decoded.height,
    sourceWidth: decoded.width,
    width: target.width,
  };
}

async function createCameraFrameTensor(
  tf: Tfjs,
  frame: TfjsCameraFrame,
  options?: { rotateForPortrait?: boolean }
): Promise<ObjectInput> {
  const start = Date.now();
  if (frame.width <= 0 || frame.height <= 0) {
    throw new Error(`Camera frame has invalid dimensions: ${frame.width}x${frame.height}`);
  }

  const sourceWidth = options?.rotateForPortrait ? frame.height : frame.width;
  const sourceHeight = options?.rotateForPortrait ? frame.width : frame.height;
  const target = fitWithinMaxEdge(sourceWidth, sourceHeight);
  const rgb = frame._data
    ? samplePackedCameraBytesToRgb(frame, target.width, target.height, options)
    : await sampleExternalImageToRgb(frame, target.width, target.height);

  return {
    height: target.height,
    sourceHeight,
    sourceWidth,
    tensor: tf.tensor3d(rgb, [target.height, target.width, 3], 'int32'),
    tensorMs: Date.now() - start,
    width: target.width,
  };
}

function fitWithinMaxEdge(width: number, height: number): { height: number; width: number } {
  if (width >= height) {
    return {
      height: Math.max(1, Math.round((height / width) * DETECTOR_MAX_EDGE)),
      width: DETECTOR_MAX_EDGE,
    };
  }
  return {
    height: DETECTOR_MAX_EDGE,
    width: Math.max(1, Math.round((width / height) * DETECTOR_MAX_EDGE)),
  };
}

function sampleRgbaToRgb(
  source: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number
): Int32Array {
  const rgb = new Int32Array(targetWidth * targetHeight * 3);
  for (let y = 0; y < targetHeight; y += 1) {
    const sy = Math.min(sourceHeight - 1, Math.floor(((y + 0.5) * sourceHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor(((x + 0.5) * sourceWidth) / targetWidth));
      const sourceOffset = (sy * sourceWidth + sx) * 4;
      const targetOffset = (y * targetWidth + x) * 3;
      rgb[targetOffset] = source[sourceOffset] ?? 0;
      rgb[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
      rgb[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
    }
  }
  return rgb;
}

function samplePackedCameraBytesToRgb(
  frame: TfjsCameraFrame,
  targetWidth: number,
  targetHeight: number,
  options?: { rotateForPortrait?: boolean }
): Int32Array {
  const source = frame._data;
  if (!source) throw new Error('Camera frame has no packed pixel data');
  const rgb = new Int32Array(targetWidth * targetHeight * 3);
  const isBgra = frame._format === 'bgra8unorm';

  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const normalizedX = (x + 0.5) / targetWidth;
      const normalizedY = (y + 0.5) / targetHeight;
      const sx = options?.rotateForPortrait
        ? Math.min(frame.width - 1, Math.floor(normalizedY * frame.width))
        : Math.min(frame.width - 1, Math.floor(normalizedX * frame.width));
      const sy = options?.rotateForPortrait
        ? Math.min(frame.height - 1, Math.floor((1 - normalizedX) * frame.height))
        : Math.min(frame.height - 1, Math.floor(normalizedY * frame.height));
      const sourceOffset = (sy * frame.width + sx) * 4;
      const targetOffset = (y * targetWidth + x) * 3;
      if (isBgra) {
        rgb[targetOffset] = source[sourceOffset + 2] ?? 0;
        rgb[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
        rgb[targetOffset + 2] = source[sourceOffset] ?? 0;
      } else {
        rgb[targetOffset] = source[sourceOffset] ?? 0;
        rgb[targetOffset + 1] = source[sourceOffset + 1] ?? 0;
        rgb[targetOffset + 2] = source[sourceOffset + 2] ?? 0;
      }
    }
  }

  return rgb;
}

async function sampleExternalImageToRgb(
  frame: TfjsCameraFrame,
  targetWidth: number,
  targetHeight: number
): Promise<Int32Array> {
  if (!isWebRuntime()) {
    throw new Error('Camera frame pixels are unavailable without packed bytes or a DOM canvas');
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas context for camera frame detection');

  ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, targetWidth, targetHeight);
  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  return sampleRgbaToRgb(imageData.data, targetWidth, targetHeight, targetWidth, targetHeight);
}

function normalizeBbox(
  bbox: [number, number, number, number],
  width: number,
  height: number
): [number, number, number, number] {
  const x = Math.max(0, Math.min(width, bbox[0] ?? 0));
  const y = Math.max(0, Math.min(height, bbox[1] ?? 0));
  const w = Math.max(0, Math.min(width - x, bbox[2] ?? 0));
  const h = Math.max(0, Math.min(height - y, bbox[3] ?? 0));
  return [x, y, w, h];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

const OBJECT_SCENE_GROUPS = [
  {
    classes: ['book', 'keyboard', 'laptop', 'mouse', 'tv'],
    label: 'Workspace / study',
    weight: 1.2,
  },
  {
    classes: ['bottle', 'bowl', 'cup', 'dining table', 'fork', 'knife', 'spoon', 'wine glass'],
    label: 'Food / table',
    weight: 1.1,
  },
  {
    classes: ['bicycle', 'bus', 'car', 'motorcycle', 'parking meter', 'stop sign', 'traffic light', 'train', 'truck'],
    label: 'Street / transport',
    weight: 1.15,
  },
  {
    classes: ['bed', 'chair', 'couch', 'potted plant', 'refrigerator', 'sink', 'toilet'],
    label: 'Home interior',
    weight: 1.0,
  },
  {
    classes: ['bird', 'cat', 'cow', 'dog', 'elephant', 'horse', 'sheep', 'zebra'],
    label: 'Animal / outdoors',
    weight: 1.2,
  },
  {
    classes: ['frisbee', 'kite', 'person', 'skateboard', 'skis', 'sports ball', 'surfboard', 'tennis racket'],
    label: 'Active scene',
    weight: 0.95,
  },
] as const;
