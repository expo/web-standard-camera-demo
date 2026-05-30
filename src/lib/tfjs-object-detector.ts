import type { GraphModel } from '@tensorflow/tfjs-converter';
import type * as TfjsModule from '@tensorflow/tfjs';
import type { File as ExpoFileSystemFile, FileHandle, FileMode as ExpoFileMode } from 'expo-file-system';

import { nowMs, round, traceNeuralLens } from './neural-lens-trace';

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
export type TfjsObjectDetectionStage =
  | 'model'
  | 'tensor'
  | 'graph'
  | 'output-data'
  | 'nms'
  | 'postprocess';

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
type BundledModelShard = { filename: string; moduleId: MetroAssetModule };
type AbortableOptions = { signal?: AbortSignal };

const DETECTOR_MAX_EDGE = 256;
const DEFAULT_MAX_BOXES = 8;
const DEFAULT_MIN_SCORE = 0.42;
const MODEL_ASSET_TIMEOUT_MS = 20000;
const FILE_READ_CHUNK_BYTES = 1024 * 1024;
const ARRAY_BUFFER_COPY_CHUNK_BYTES = 1024 * 1024;
const CAMERA_SAMPLE_ROWS_PER_YIELD = 8;
// @ref LLP 0012#demo-6-tensorflowjs-object-lens — the demo vendors COCO-SSD
// model JSON and weight shards so iOS can classify without fetching a model.
const BUNDLED_MODEL_DIR = 'coco-ssd-lite-mobilenet-v2';
const NATIVE_MODEL_ROOT = 'TfjsModels';
let runtimePromise: Promise<ObjectRuntime> | null = null;
let modelPromise: Promise<ObjectModel> | null = null;
let weightDataPromise: Promise<LoadedWeightData> | null = null;
let bundledModelJson: ModelJson | null = null;
let bundledModelShards: readonly BundledModelShard[] | null = null;
let cocoClasses: Record<number, CocoClass | undefined> | null = null;
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
  options?: {
    maxBoxes?: number;
    minScore?: number;
    onStage?: (stage: TfjsObjectDetectionStage) => void;
    signal?: AbortSignal;
  }
): Promise<TfjsObjectResult> {
  throwIfAborted(options?.signal);
  options?.onStage?.('model');
  const model = await loadTfjsObjectModel(options);
  throwIfAborted(options?.signal);
  options?.onStage?.('tensor');
  const input = await createProbeTensor(model.runtime.tf, probe);
  try {
    throwIfAborted(options?.signal);
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

export async function preloadTfjsObjectModel(options?: AbortableOptions): Promise<TfjsObjectCacheInfo> {
  await loadTfjsObjectModel(options);
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
  options?: {
    maxBoxes?: number;
    minScore?: number;
    onStage?: (stage: TfjsObjectDetectionStage) => void;
    rotateForPortrait?: boolean;
    signal?: AbortSignal;
  }
): Promise<TfjsObjectResult> {
  throwIfAborted(options?.signal);
  options?.onStage?.('model');
  const model = await loadTfjsObjectModel(options);
  throwIfAborted(options?.signal);
  options?.onStage?.('tensor');
  const input = await createCameraFrameTensor(model.runtime.tf, frame, {
    rotateForPortrait: options?.rotateForPortrait,
    signal: options?.signal,
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
  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error('Detection aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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
  traceNeuralLens('tfjs-model-state', {
    modelLoadCount,
    phase,
    runtimeInitCount,
    status,
  });
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

async function loadTfjsObjectModel(options?: AbortableOptions): Promise<ObjectModel> {
  throwIfAborted(options?.signal);
  traceNeuralLens('tfjs-model-request', {
    hasModelPromise: modelPromise !== null,
    modelLoadCount,
    modelLoadPhase,
    modelStatus,
  });
  if (!modelPromise) {
    modelPromise = (async () => {
      const modelStartedAt = nowMs();
      traceNeuralLens('tfjs-model-build-start', {
        modelLoadCount,
      });
      setModelLoadState('loading', 'runtime');
      const runtime = await ensureTfjsRuntime();
      throwIfAborted(options?.signal);
      await yieldToUi();
      throwIfAborted(options?.signal);
      const start = Date.now();
      let graph: GraphModel | null = await loadBundledCocoSsdGraphModel(runtime, options);
      try {
        throwIfAborted(options?.signal);
        setModelLoadState('loading', 'warmup');
        await yieldToUi();
        throwIfAborted(options?.signal);
        const warmupStartedAt = nowMs();
        traceNeuralLens('tfjs-model-warmup-start', {
          backend: runtime.info.backend,
        });
        const zeroTensor = runtime.tf.zeros([1, 300, 300, 3], 'int32');
        let warmup: TfjsModule.Tensor | TfjsModule.Tensor[] | null = null;
        try {
          warmup = await graph.executeAsync(zeroTensor);
          throwIfAborted(options?.signal);
          await Promise.all(asTensorArray(warmup).map((tensor) => tensor.data()));
          throwIfAborted(options?.signal);
        } finally {
          if (warmup) runtime.tf.dispose(warmup);
          zeroTensor.dispose();
        }
        traceNeuralLens('tfjs-model-warmup-done', {
          durationMs: round(nowMs() - warmupStartedAt),
        });
        modelLoadCount += 1;
        setModelLoadState('ready', 'ready');
        traceNeuralLens('tfjs-model-build-done', {
          backend: runtime.info.backend,
          modelLoadCount,
          totalMs: round(nowMs() - modelStartedAt),
        });
        const loadedGraph = graph;
        graph = null;
        return {
          graph: loadedGraph,
          loadMs: Date.now() - start,
          runtime,
        };
      } finally {
        graph?.dispose();
      }
    })();
  }
  try {
    return await modelPromise;
  } catch (error) {
    modelPromise = null;
    if (isAbortError(error)) {
      setModelLoadState('idle', 'idle');
      traceNeuralLens('tfjs-model-build-abort');
    } else {
      setModelLoadState('error', 'error');
      traceNeuralLens('tfjs-model-build-error', {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
    throw error;
  }
}

async function ensureTfjsRuntime(): Promise<ObjectRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const start = nowMs();
      traceNeuralLens('tfjs-runtime-start');
      if (!isWebRuntime() && !globalThis.navigator?.gpu) {
        try {
          const nativeWgpuStartedAt = nowMs();
          await import('react-native-wgpu');
          traceNeuralLens('tfjs-runtime-native-wgpu-import-done', {
            durationMs: round(nowMs() - nativeWgpuStartedAt),
          });
          await yieldToUi();
        } catch (error) {
          traceNeuralLens('tfjs-runtime-native-wgpu-import-error', {
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
          // TFJS will fall back to CPU below if the native WebGPU polyfill cannot load.
        }
      }
      const tfImportStartedAt = nowMs();
      const tf = await import('@tensorflow/tfjs');
      traceNeuralLens('tfjs-runtime-tf-import-done', {
        durationMs: round(nowMs() - tfImportStartedAt),
      });
      await yieldToUi();
      const backendImportStartedAt = nowMs();
      await import('@tensorflow/tfjs-backend-webgpu');
      traceNeuralLens('tfjs-runtime-webgpu-backend-import-done', {
        durationMs: round(nowMs() - backendImportStartedAt),
      });
      const hasNavigatorGpu = Boolean(globalThis.navigator?.gpu);

      if (hasNavigatorGpu) {
        try {
          const backendStartedAt = nowMs();
          await tf.setBackend('webgpu');
          await tf.ready();
          traceNeuralLens('tfjs-runtime-backend-ready', {
            backend: tf.getBackend(),
            durationMs: round(nowMs() - backendStartedAt),
          });
        } catch (error) {
          traceNeuralLens('tfjs-runtime-webgpu-backend-error', {
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
          const backendStartedAt = nowMs();
          await tf.setBackend('cpu');
          await tf.ready();
          traceNeuralLens('tfjs-runtime-backend-ready', {
            backend: tf.getBackend(),
            durationMs: round(nowMs() - backendStartedAt),
          });
        }
      } else {
        const backendStartedAt = nowMs();
        await tf.setBackend('cpu');
        await tf.ready();
        traceNeuralLens('tfjs-runtime-backend-ready', {
          backend: tf.getBackend(),
          durationMs: round(nowMs() - backendStartedAt),
        });
      }

      runtimeInitCount += 1;
      const backend = tf.getBackend();
      emitTfjsObjectCacheInfo();
      traceNeuralLens('tfjs-runtime-done', {
        backend,
        hasNavigatorGpu,
        totalMs: round(nowMs() - start),
      });
      return {
        info: {
          backend,
          hasNavigatorGpu,
          initMs: Math.round(nowMs() - start),
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
  options?: { maxBoxes?: number; minScore?: number; onStage?: (stage: TfjsObjectDetectionStage) => void; signal?: AbortSignal }
): Promise<TfjsObjectResult> {
  const detectStart = nowMs();
  const tf = model.runtime.tf;
  throwIfAborted(options?.signal);
  options?.onStage?.('graph');
  traceNeuralLens('tfjs-detect-graph-start', {
    backend: model.runtime.info.backend,
    inputHeight: input.height,
    inputWidth: input.width,
    source: source.kind,
  });
  const batched = tf.tidy(() => tf.expandDims(input.tensor));
  let output: TfjsModule.Tensor[] | null = null;
  let disposedGraphTensors = false;
  let scores: Float32Array | Int32Array | Uint8Array = new Float32Array();
  let boxes: Float32Array | Int32Array | Uint8Array = new Float32Array();
  let scoresShape: readonly number[] = [];
  let boxesShape: readonly number[] = [];

  try {
    output = asTensorArray(await model.graph.executeAsync(batched));
    traceNeuralLens('tfjs-detect-graph-done', {
      durationMs: round(nowMs() - detectStart),
      source: source.kind,
    });
    throwIfAborted(options?.signal);
    const scoresTensor = output[0];
    const boxesTensor = output[1];
    if (!scoresTensor || !boxesTensor) {
      throw new Error('COCO-SSD graph returned an unexpected output shape');
    }
    scoresShape = scoresTensor.shape;
    boxesShape = boxesTensor.shape;
    options?.onStage?.('output-data');
    const dataStartedAt = nowMs();
    [scores, boxes] = await Promise.all([scoresTensor.data(), boxesTensor.data()]);
    traceNeuralLens('tfjs-detect-output-data-done', {
      durationMs: round(nowMs() - dataStartedAt),
      source: source.kind,
    });
    throwIfAborted(options?.signal);
    batched.dispose();
    tf.dispose(output);
    disposedGraphTensors = true;
    output = null;
  } finally {
    if (!disposedGraphTensors) {
      batched.dispose();
      if (output) tf.dispose(output);
    }
  }

  options?.onStage?.('nms');
  const nmsStartedAt = nowMs();
  const [maxScores, classes] = calculateMaxScores(scores, scoresShape[1] ?? 0, scoresShape[2] ?? 0);
  throwIfAborted(options?.signal);
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
    throwIfAborted(options?.signal);
    indexes = Array.from(await indexesTensor.data());
    throwIfAborted(options?.signal);
  } finally {
    indexesTensor?.dispose();
    boxes2d.dispose();
    scores1d.dispose();
  }
  traceNeuralLens('tfjs-detect-nms-done', {
    durationMs: round(nowMs() - nmsStartedAt),
    indexes: indexes.length,
    source: source.kind,
  });

  options?.onStage?.('postprocess');
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
    detectMs: Math.round(nowMs() - detectStart),
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

async function loadBundledCocoSsdGraphModel(
  runtime: ObjectRuntime,
  options?: AbortableOptions
): Promise<GraphModel> {
  throwIfAborted(options?.signal);
  setModelLoadState('loading', 'weights');
  const weightsStartedAt = nowMs();
  const weightData = await loadBundledWeightData(options);
  throwIfAborted(options?.signal);
  traceNeuralLens('tfjs-model-weights-ready', {
    bytes: weightData.buffer.byteLength,
    durationMs: round(nowMs() - weightsStartedAt),
    source: weightData.source,
  });
  const modelJson = getBundledModelJson();
  await yieldToUi();
  throwIfAborted(options?.signal);
  setModelLoadState('loading', 'graph');
  const converterStartedAt = nowMs();
  const tfconv = await import('@tensorflow/tfjs-converter');
  throwIfAborted(options?.signal);
  traceNeuralLens('tfjs-model-converter-import-done', {
    durationMs: round(nowMs() - converterStartedAt),
  });
  await yieldToUi();
  throwIfAborted(options?.signal);
  const handler = runtime.tf.io.fromMemory({
    convertedBy: modelJson.convertedBy,
    format: modelJson.format,
    generatedBy: modelJson.generatedBy,
    modelTopology: modelJson.modelTopology,
    weightData: weightData.buffer,
    weightSpecs: modelJson.weightsManifest.flatMap((group) => group.weights),
  });
  const graphStartedAt = nowMs();
  const graph = await withTimeout(
    tfconv.loadGraphModel(handler, undefined, runtime.tf.io),
    MODEL_ASSET_TIMEOUT_MS,
    'COCO-SSD graph load',
    options?.signal
  );
  throwIfAborted(options?.signal);
  traceNeuralLens('tfjs-model-graph-load-done', {
    durationMs: round(nowMs() - graphStartedAt),
  });
  return graph;
}

async function loadBundledWeightData(options?: AbortableOptions): Promise<LoadedWeightData> {
  throwIfAborted(options?.signal);
  if (weightDataPromise) {
    traceNeuralLens('tfjs-model-weights-cache-hit', {
      modelWeightSource: modelWeightSource ?? null,
    });
  }
  if (!weightDataPromise) {
    weightDataPromise = (async () => {
      const startedAt = nowMs();
      traceNeuralLens('tfjs-model-weights-load-start');
      const buffers: ArrayBuffer[] = [];
      const sources = new Set<TfjsModelWeightSource>();
      const shards = getBundledModelShards();
      for (let i = 0; i < shards.length; i += 1) {
        throwIfAborted(options?.signal);
        const shard = shards[i];
        const shardStartedAt = nowMs();
        const asset = await withTimeout(
          readBundledAssetArrayBuffer(shard.filename, shard.moduleId as MetroAssetModule, options),
          MODEL_ASSET_TIMEOUT_MS,
          `COCO-SSD weight shard ${i + 1}`,
          options?.signal
        );
        throwIfAborted(options?.signal);
        traceNeuralLens('tfjs-model-weight-shard-done', {
          bytes: asset.buffer.byteLength,
          durationMs: round(nowMs() - shardStartedAt),
          filename: shard.filename,
          index: i + 1,
          source: asset.source,
        });
        buffers.push(asset.buffer);
        sources.add(asset.source);
        await yieldToUi();
        throwIfAborted(options?.signal);
      }
      const source = sources.size === 1
        ? [...sources][0] ?? 'metro-asset'
        : 'mixed';
      modelWeightSource = source;
      emitTfjsObjectCacheInfo();
      const concatStartedAt = nowMs();
      const buffer = await concatArrayBuffers(buffers, options?.signal);
      throwIfAborted(options?.signal);
      traceNeuralLens('tfjs-model-weights-load-done', {
        bytes: buffer.byteLength,
        concatMs: round(nowMs() - concatStartedAt),
        source,
        totalMs: round(nowMs() - startedAt),
      });
      return {
        buffer,
        source,
      };
    })();
  }
  try {
    return await weightDataPromise;
  } catch (error) {
    weightDataPromise = null;
    modelWeightSource = null;
    if (isAbortError(error)) {
      traceNeuralLens('tfjs-model-weights-load-abort');
    }
    throw error;
  }
}

async function readBundledAssetArrayBuffer(
  filename: string,
  moduleId: MetroAssetModule,
  options?: AbortableOptions
): Promise<LoadedModelAssetBuffer> {
  throwIfAborted(options?.signal);
  const nativeBuffer = await readNativeBundledModelAsset(filename, options);
  throwIfAborted(options?.signal);
  if (nativeBuffer) {
    traceNeuralLens('tfjs-model-weight-source', {
      bytes: nativeBuffer.byteLength,
      filename,
      source: 'native-bundle',
    });
    return {
      buffer: nativeBuffer,
      source: 'native-bundle',
    };
  }

  const { Asset } = await import('expo-asset');
  throwIfAborted(options?.signal);
  const asset = Asset.fromModule(moduleId);

  if (!isWebRuntime()) {
    const downloaded = await asset.downloadAsync();
    throwIfAborted(options?.signal);
    traceNeuralLens('tfjs-model-weight-source', {
      filename,
      source: 'metro-asset',
      uriKind: downloaded.localUri ? 'local' : 'remote',
    });
    return {
      buffer: await readAssetArrayBuffer(downloaded.localUri ?? downloaded.uri, options),
      source: 'metro-asset',
    };
  }

  return {
    buffer: await readAssetArrayBuffer(asset.uri, options),
    source: 'metro-asset',
  };
}

async function readNativeBundledModelAsset(
  filename: string,
  options?: AbortableOptions
): Promise<ArrayBuffer | null> {
  if (isWebRuntime()) return null;
  try {
    throwIfAborted(options?.signal);
    const { File, FileMode, Paths } = await import('expo-file-system');
    throwIfAborted(options?.signal);
    const file = new File(
      ensureFileUri(Paths.bundle.uri),
      NATIVE_MODEL_ROOT,
      BUNDLED_MODEL_DIR,
      filename
    );
    if (!file.exists) return null;
    return await readFileWithHandle(file, FileMode.ReadOnly, options?.signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
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

async function readAssetArrayBuffer(uri: string, options?: AbortableOptions): Promise<ArrayBuffer> {
  throwIfAborted(options?.signal);
  if (uri.startsWith('file://')) {
    const { File: ExpoFile, FileMode } = await import('expo-file-system');
    return await readFileWithHandle(new ExpoFile(uri), FileMode.ReadOnly, options?.signal);
  }
  const response = await fetch(uri, { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Could not load bundled model asset ${response.status}: ${uri}`);
  }
  throwIfAborted(options?.signal);
  return await response.arrayBuffer();
}

async function readFileWithHandle(
  file: Pick<ExpoFileSystemFile, 'open'>,
  readOnlyMode: ExpoFileMode,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const handle: FileHandle = file.open(readOnlyMode);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let remaining = handle.size;

  try {
    while (remaining == null || remaining > 0) {
      throwIfAborted(signal);
      const length = remaining == null
        ? FILE_READ_CHUNK_BYTES
        : Math.min(FILE_READ_CHUNK_BYTES, remaining);
      const chunk = handle.readBytes(length);
      throwIfAborted(signal);
      if (chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (remaining != null) {
        remaining -= chunk.byteLength;
      }
      await yieldToUi();
      throwIfAborted(signal);
    }
  } finally {
    handle.close();
  }

  throwIfAborted(signal);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    throwIfAborted(signal);
    out.set(chunk, offset);
    offset += chunk.byteLength;
    await yieldToEventLoop();
    throwIfAborted(signal);
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  try {
    throwIfAborted(signal);
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (signal) {
          abortListener = () => {
            reject(createAbortError());
          };
          signal.addEventListener('abort', abortListener, { once: true });
        }
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener && signal) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

async function concatArrayBuffers(buffers: readonly ArrayBuffer[], signal?: AbortSignal): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    throwIfAborted(signal);
    const source = new Uint8Array(buffer);
    for (let readOffset = 0; readOffset < source.byteLength; readOffset += ARRAY_BUFFER_COPY_CHUNK_BYTES) {
      throwIfAborted(signal);
      const end = Math.min(source.byteLength, readOffset + ARRAY_BUFFER_COPY_CHUNK_BYTES);
      const chunk = source.subarray(readOffset, end);
      out.set(chunk, offset);
      offset += chunk.byteLength;
      await yieldToEventLoop();
      throwIfAborted(signal);
    }
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
  const cocoClassesById = getCocoClasses();
  for (const index of indexes) {
    const ymin = Number(boxes[index * 4] ?? 0) * height;
    const xmin = Number(boxes[index * 4 + 1] ?? 0) * width;
    const ymax = Number(boxes[index * 4 + 2] ?? 0) * height;
    const xmax = Number(boxes[index * 4 + 3] ?? 0) * width;
    const className = cocoClassesById[(classes[index] ?? -1) + 1]?.displayName ?? 'object';
    objects.push({
      bbox: normalizeBbox([xmin, ymin, xmax - xmin, ymax - ymin], width, height),
      className,
      score: clamp01(scores[index] ?? 0),
    });
  }
  return objects;
}

function getBundledModelJson(): ModelJson {
  if (!bundledModelJson) {
    bundledModelJson = require('../../assets/models/coco-ssd-lite-mobilenet-v2/model.json') as ModelJson;
  }
  return bundledModelJson;
}

function getBundledModelShards(): readonly BundledModelShard[] {
  if (!bundledModelShards) {
    /* eslint-disable @typescript-eslint/no-require-imports -- Metro asset ids for bundled model shards are created with require(). */
    bundledModelShards = [
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
    ];
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return bundledModelShards;
}

function getCocoClasses(): Record<number, CocoClass | undefined> {
  if (!cocoClasses) {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports -- Defer class metadata until detection post-processing. */
    cocoClasses = (require('@tensorflow-models/coco-ssd/dist/classes') as {
      CLASSES: Record<number, CocoClass | undefined>;
    }).CLASSES;
  }
  return cocoClasses;
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
  options?: { rotateForPortrait?: boolean; signal?: AbortSignal }
): Promise<ObjectInput> {
  const start = nowMs();
  if (frame.width <= 0 || frame.height <= 0) {
    throw new Error(`Camera frame has invalid dimensions: ${frame.width}x${frame.height}`);
  }

  const sourceWidth = options?.rotateForPortrait ? frame.height : frame.width;
  const sourceHeight = options?.rotateForPortrait ? frame.width : frame.height;
  const target = fitWithinMaxEdge(sourceWidth, sourceHeight);
  traceNeuralLens('tfjs-camera-tensor-start', {
    frameFormat: frame._format ?? null,
    frameHeight: frame.height,
    frameNumber: frame._frameNumber ?? null,
    frameWidth: frame.width,
    rotateForPortrait: options?.rotateForPortrait ?? false,
    targetHeight: target.height,
    targetWidth: target.width,
  });
  const sampleStartedAt = nowMs();
  const rgb = frame._data
    ? await samplePackedCameraBytesToRgb(frame, target.width, target.height, options)
    : await sampleExternalImageToRgb(frame, target.width, target.height);
  throwIfAborted(options?.signal);
  traceNeuralLens('tfjs-camera-tensor-sample-done', {
    durationMs: round(nowMs() - sampleStartedAt),
    inputBytes: frame._data?.byteLength ?? null,
    rgbValues: rgb.length,
  });
  const tensorStartedAt = nowMs();
  const tensor = tf.tensor3d(rgb, [target.height, target.width, 3], 'int32');
  traceNeuralLens('tfjs-camera-tensor-created', {
    durationMs: round(nowMs() - tensorStartedAt),
    totalMs: round(nowMs() - start),
  });

  return {
    height: target.height,
    sourceHeight,
    sourceWidth,
    tensor,
    tensorMs: Math.round(nowMs() - start),
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

async function samplePackedCameraBytesToRgb(
  frame: TfjsCameraFrame,
  targetWidth: number,
  targetHeight: number,
  options?: { rotateForPortrait?: boolean; signal?: AbortSignal }
): Promise<Int32Array> {
  const source = frame._data;
  if (!source) throw new Error('Camera frame has no packed pixel data');
  const rgb = new Int32Array(targetWidth * targetHeight * 3);
  const isBgra = frame._format === 'bgra8unorm';
  const sourceByTargetX = new Int32Array(targetWidth);
  const sourceByTargetY = new Int32Array(targetHeight);

  if (options?.rotateForPortrait) {
    for (let y = 0; y < targetHeight; y += 1) {
      sourceByTargetY[y] = Math.min(
        frame.width - 1,
        Math.floor(((y + 0.5) * frame.width) / targetHeight)
      );
    }
    for (let x = 0; x < targetWidth; x += 1) {
      sourceByTargetX[x] = Math.min(
        frame.height - 1,
        Math.floor((1 - ((x + 0.5) / targetWidth)) * frame.height)
      );
    }
  } else {
    for (let y = 0; y < targetHeight; y += 1) {
      sourceByTargetY[y] = Math.min(
        frame.height - 1,
        Math.floor(((y + 0.5) * frame.height) / targetHeight)
      );
    }
    for (let x = 0; x < targetWidth; x += 1) {
      sourceByTargetX[x] = Math.min(
        frame.width - 1,
        Math.floor(((x + 0.5) * frame.width) / targetWidth)
      );
    }
  }

  for (let y = 0; y < targetHeight; y += 1) {
    if (y > 0 && y % CAMERA_SAMPLE_ROWS_PER_YIELD === 0) {
      throwIfAborted(options?.signal);
      await yieldToEventLoop();
      throwIfAborted(options?.signal);
    }
    const rotatedSourceX = sourceByTargetY[y] ?? 0;
    const sourceY = sourceByTargetY[y] ?? 0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sx = options?.rotateForPortrait
        ? rotatedSourceX
        : sourceByTargetX[x] ?? 0;
      const sy = options?.rotateForPortrait
        ? sourceByTargetX[x] ?? 0
        : sourceY;
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

  throwIfAborted(options?.signal);
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
