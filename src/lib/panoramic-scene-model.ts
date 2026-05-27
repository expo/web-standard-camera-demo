export const MAX_SURFELS = 48000;
export const SAMPLE_GRID_X = 40;
export const SAMPLE_GRID_Y = 30;
export const MIN_DEPTH_M = 0.35;
export const MAX_DEPTH_M = 4.8;
export const VOXEL_SIZE_M = 0.045;
export const MAX_KEYFRAMES = 18;
export const KEYFRAME_MIN_INTERVAL_MS = 360;
export const KEYFRAME_MIN_TRANSLATION_M = 0.12;
export const KEYFRAME_MIN_ROTATION_DEG = 12;
export const KEYFRAME_MAX_TRANSLATION_M_PER_SEC = 0.65;
export const KEYFRAME_MAX_ROTATION_DEG_PER_SEC = 80;
export const MIN_KEYFRAME_SURFELS = 96;
export const MIN_KEYFRAME_NEW_VOXELS = 16;
export const PANORAMIC_COVERAGE_YAW_BINS = 6;
export const PANORAMIC_COVERAGE_PITCH_BINS = 3;
export const PANORAMIC_COVERAGE_PITCH_RANGE_DEG = 60;
export const PANORAMIC_COVERAGE_YAW_RANGE_DEG = 180;
export const SURFEL_STRIDE_FLOATS = 12;
export const SURFEL_STRIDE_BYTES = SURFEL_STRIDE_FLOATS * 4;
export const LIVE_MODEL_BASE_INTERVAL_MS = 220;
export const LIVE_MODEL_10K_INTERVAL_MS = 320;
export const LIVE_MODEL_25K_INTERVAL_MS = 650;
export const LIVE_MODEL_45K_INTERVAL_MS = 1100;
export const LIVE_MODEL_MAX_BUILD_PRESSURE_INTERVAL_MS = 1800;
export const SURFEL_BUFFER_CAPACITY_GRANULARITY_BYTES = 256 * 1024;
export const MODEL_SURFEL_BASE_POINT_SCALE_PX = 3.4;
export const MODEL_SURFEL_DENSE_POINT_SCALE_MIN_PX = 1.7;
export const MODEL_SURFEL_DENSE_POINT_SCALE_THRESHOLD = 10000;
export const MESH_SURFEL_SAMPLE_BUDGET = 900;
export const DETAILED_TIMING_SAMPLE_STRIDE = 8;
export const MATURE_DEPTH_VOXEL_SKIP_MIN_OBSERVATIONS = 3;
const APPEND_SURFEL_CREATED_VOXEL = 1;
const APPEND_SURFEL_PLANE_PROJECTED = 2;
const INV_VOXEL_SIZE_M = 1 / VOXEL_SIZE_M;
const VOXEL_KEY_AXIS_OFFSET = 2048;
const VOXEL_KEY_AXIS_SIZE = VOXEL_KEY_AXIS_OFFSET * 2;

export type Vec3 = [number, number, number];

export interface CaptureModel {
  boundsMax: Vec3;
  boundsMin: Vec3;
  buildMs: number;
  cameraColoredSurfels: number;
  center: Vec3;
  colorSource: 'camera' | 'depth' | 'mixed';
  keyframes: number;
  multiObservedSurfels: number;
  normalEstimatedSurfels: number;
  rawSampleCount: number;
  surfelCount: number;
  surfels: Float32Array;
  voxelSizeMeters: number;
}

export interface CaptureGeometrySummary {
  normalCoherencePercent: number;
  normalProjectedRmsMeters: number;
  normalProjectedSpanMeters: number;
  weightedCentroid: Vec3;
}

export interface ViewerState {
  distanceScale: number;
  panX: number;
  panY: number;
  pitch: number;
  yaw: number;
}

export type PanoramicCaptureStatus =
  | 'idle'
  | 'checking'
  | 'unsupported'
  | 'requesting'
  | 'scanning'
  | 'building-model'
  | 'captured'
  | 'ending'
  | 'error';

export interface PanoramicCaptureControlInput {
  hasModel: boolean;
  liveSurfelCount: number;
  saving: boolean;
  status: PanoramicCaptureStatus;
}

export interface PanoramicCaptureControlState {
  canCapture: boolean;
  canPreview: boolean;
  canSave: boolean;
  canStart: boolean;
  capturedModelAvailable: boolean;
  transitioning: boolean;
  unsupported: boolean;
}

export interface LiveModelSnapshotPublishInput {
  hasPublishedModel: boolean;
  keyframes: number;
  lastPublishedAtMs: number;
  lastPublishedKeyframes: number;
  lastPublishedRawSampleCount: number;
  nowMs: number;
  previousBuildMs: number;
  rawSampleCount: number;
}

export interface LiveModelSnapshotPublishDecision {
  intervalMs: number;
  publish: boolean;
  reason: 'initial' | 'no-keyframes' | 'stale' | 'throttled' | 'unchanged';
}

export interface XRScanFrameSchedulingInput {
  captureInFlight: boolean;
  sessionEnded: boolean;
  sessionMatches: boolean;
  status: PanoramicCaptureStatus;
}

export interface KeyframeSnapshot {
  forward: Vec3;
  position: Vec3;
  time: number;
}

export type KeyframeRejectionReason =
  | 'max-keyframes'
  | 'max-surfels'
  | 'too-few-new-voxels'
  | 'too-few-surfels'
  | 'too-fast'
  | 'too-soon'
  | 'too-similar';

export interface KeyframeAcceptanceDecision {
  accepted: boolean;
  reason: KeyframeRejectionReason | null;
  rotationDeg: number;
  rotationSpeedDegPerSec: number;
  translationM: number;
  translationSpeedMPerSec: number;
}

export interface KeyframeAcceptanceInput {
  candidateSurfels?: number;
  existingSurfels: number;
  forward: Vec3;
  keyframes: number;
  last: KeyframeSnapshot | null;
  maxKeyframes?: number;
  maxRotationDegPerSecond?: number;
  maxSurfels?: number;
  maxTranslationMPerSecond?: number;
  minIntervalMs?: number;
  minRotationDeg?: number;
  minSurfels?: number;
  minTranslationM?: number;
  position: Vec3;
  time: number;
}

export interface CoveredSectorPrecheckInput {
  coverageSectors: ReadonlySet<string>;
  forward: Vec3;
  keyframes: number;
  minTranslationM?: number;
  scanForwardSum: Vec3;
  translationM: number;
}

export interface PanoramicCoverageOptions {
  centerForward?: Vec3;
  pitchBins?: number;
  pitchRangeDeg?: number;
  yawRangeDeg?: number;
  yawBins?: number;
}

export function derivePanoramicCaptureControls({
  hasModel,
  liveSurfelCount,
  saving,
  status,
}: PanoramicCaptureControlInput): PanoramicCaptureControlState {
  const capturedModelAvailable = status === 'captured' && hasModel;
  const transitioning = status === 'requesting' || status === 'building-model' || status === 'ending';
  return {
    canCapture: status === 'scanning' && liveSurfelCount > 0,
    canPreview: status === 'scanning' && liveSurfelCount > 0 && !transitioning,
    canSave: capturedModelAvailable && !saving,
    canStart: status === 'idle' || status === 'captured',
    capturedModelAvailable,
    transitioning,
    unsupported: status === 'unsupported',
  };
}

export function observedDepthSurfelCount(appendedSurfels: number, preflightSurfels?: number | null): number {
  const appended = Number.isFinite(appendedSurfels) ? Math.max(0, Math.floor(appendedSurfels)) : 0;
  const observed = Number.isFinite(preflightSurfels) ? Math.max(0, Math.floor(preflightSurfels ?? 0)) : 0;
  return Math.max(appended, observed);
}

export function liveModelSnapshotIntervalMs(rawSampleCount: number, previousBuildMs: number): number {
  const sampleCount = Math.max(0, rawSampleCount);
  const samplePressureInterval = sampleCount >= 45000
    ? LIVE_MODEL_45K_INTERVAL_MS
    : sampleCount >= 25000
      ? LIVE_MODEL_25K_INTERVAL_MS
      : sampleCount >= 10000
        ? LIVE_MODEL_10K_INTERVAL_MS
        : LIVE_MODEL_BASE_INTERVAL_MS;
  const buildPressureInterval = previousBuildMs > 0
    ? clamp(previousBuildMs * 3, LIVE_MODEL_BASE_INTERVAL_MS, LIVE_MODEL_MAX_BUILD_PRESSURE_INTERVAL_MS)
    : LIVE_MODEL_BASE_INTERVAL_MS;
  return Math.round(Math.max(samplePressureInterval, buildPressureInterval));
}

export function shouldPublishLiveModelSnapshot({
  hasPublishedModel,
  keyframes,
  lastPublishedAtMs,
  lastPublishedKeyframes,
  lastPublishedRawSampleCount,
  nowMs,
  previousBuildMs,
  rawSampleCount,
}: LiveModelSnapshotPublishInput): LiveModelSnapshotPublishDecision {
  const intervalMs = liveModelSnapshotIntervalMs(rawSampleCount, previousBuildMs);
  if (keyframes <= 0 || rawSampleCount <= 0) {
    return { intervalMs, publish: false, reason: 'no-keyframes' };
  }
  if (!hasPublishedModel) {
    return { intervalMs, publish: true, reason: 'initial' };
  }
  if (keyframes <= lastPublishedKeyframes && rawSampleCount <= lastPublishedRawSampleCount) {
    return { intervalMs, publish: false, reason: 'unchanged' };
  }
  if (nowMs - lastPublishedAtMs < intervalMs) {
    return { intervalMs, publish: false, reason: 'throttled' };
  }
  return { intervalMs, publish: true, reason: 'stale' };
}

export function shouldScheduleNextXRScanFrame({
  captureInFlight,
  sessionEnded,
  sessionMatches,
  status,
}: XRScanFrameSchedulingInput): boolean {
  return sessionMatches &&
    !sessionEnded &&
    !captureInFlight &&
    (status === 'scanning' || status === 'building-model');
}

export function nextSurfelBufferCapacityBytes(requiredBytes: number): number {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) return 0;
  const bytes = Math.max(SURFEL_STRIDE_BYTES, Math.ceil(requiredBytes));
  return Math.ceil(bytes / SURFEL_BUFFER_CAPACITY_GRANULARITY_BYTES) *
    SURFEL_BUFFER_CAPACITY_GRANULARITY_BYTES;
}

export function modelSurfelPointScalePx(surfelCount: number): number {
  if (!Number.isFinite(surfelCount) || surfelCount <= MODEL_SURFEL_DENSE_POINT_SCALE_THRESHOLD) {
    return MODEL_SURFEL_BASE_POINT_SCALE_PX;
  }
  const densityScale = Math.sqrt(MODEL_SURFEL_DENSE_POINT_SCALE_THRESHOLD / surfelCount);
  return clamp(
    MODEL_SURFEL_BASE_POINT_SCALE_PX * densityScale,
    MODEL_SURFEL_DENSE_POINT_SCALE_MIN_PX,
    MODEL_SURFEL_BASE_POINT_SCALE_PX
  );
}

export interface PanoramicRigidTransform {
  readonly matrix: Float32Array;
}

export interface PanoramicDepthInformation {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayBuffer;
  readonly normDepthBufferFromNormView: PanoramicRigidTransform;
  readonly rawValueToMeters: number;
}

export interface PanoramicCameraImage {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayBuffer;
  readonly format: 'bgra8unorm' | 'rgba8unorm';
  readonly normCameraImageFromNormView: PanoramicRigidTransform;
}

export type PanoramicCameraImageSource =
  | PanoramicCameraImage
  | null
  | (() => PanoramicCameraImage | null);

export interface AppendDepthSurfelsProfile {
  appendTotalMs?: number;
  cameraBytes?: number;
  cameraHeight?: number;
  cameraImageMs?: number;
  cameraSampleMode?: CameraColorSampleMode;
  cameraPointCacheHits?: number;
  cameraPointSamples?: number;
  cameraRequested?: boolean;
  cameraTransformMode?: NormalizedDepthTransformMode;
  cameraWidth?: number;
  centerCameraMeters?: Vec3;
  centerDepthMeters?: number;
  centerDepthValid?: boolean;
  centerWorldMeters?: Vec3;
  depthBytes?: number;
  depthCacheReused?: boolean;
  depthDataMs?: number;
  depthHeight?: number;
  depthLookupMs?: number;
  depthPreflightMs?: number;
  depthTransformMode?: NormalizedDepthTransformMode;
  depthWidth?: number;
  depthGridSampleCount?: number;
  depthGridSampleMode?: DepthGridSampleMode;
  detailedTiming?: boolean;
  minSurfelsForCamera?: number;
  minNewVoxelsForFusion?: number;
  matureVoxelSkips?: number;
  newVoxelPreflightMs?: number;
  normalEstimateMs?: number;
  planeProjectedSamples?: number;
  preflightNewVoxels?: number;
  preflightSurfels?: number;
  preflightUpdatedVoxels?: number;
  profiledSampleCount?: number;
  timedSampleCount?: number;
  timingSampleStride?: number;
  colorSampleMs?: number;
  sampleConsumeMs?: number;
  sampleGridX?: number;
  sampleGridY?: number;
  sampleLoopMs?: number;
  sampleOffsetX?: number;
  sampleOffsetY?: number;
  samplePhase?: number;
  unprojectMs?: number;
  unprojectionMode?: ViewSampleUnprojectionMode;
}

export interface AppendDepthSurfelsOptions {
  detailedProfile?: boolean;
  minNewVoxelsForFusion?: number;
  minSurfelsForCamera?: number;
  profile?: AppendDepthSurfelsProfile;
  samplePhase?: number;
}

export interface AppendDepthSurfelsResult {
  cameraColoredSurfels: number;
  newVoxelCount: number;
  surfelCount: number;
  updatedVoxelCount: number;
}

export interface PanoramicMeshGeometry {
  readonly indices: Uint32Array;
  readonly normals: Float32Array | null;
  readonly vertices: Float32Array;
}

export interface AppendMeshSurfelsProfile {
  appendTotalMs?: number;
  cameraBytes?: number;
  cameraColoredSurfels?: number;
  cameraHeight?: number;
  cameraImageMs?: number;
  cameraRequested?: boolean;
  cameraSampleMode?: CameraColorSampleMode;
  cameraTransformMode?: NormalizedDepthTransformMode;
  cameraWidth?: number;
  maxSurfels?: number;
  meshCount?: number;
  meshNormalCount?: number;
  meshNormalMode?: MeshNormalMode;
  meshSampleStride?: number;
  meshTriangles?: number;
  meshVertices?: number;
  planeProjectedSamples?: number;
  poseMisses?: number;
  projectedSurfels?: number;
  sampledSurfels?: number;
  skippedSurfels?: number;
  strideSkippedCandidates?: number;
}

export type MeshNormalMode = 'none' | 'face' | 'vertex' | 'mixed' | 'other';

export interface AppendMeshSurfelsOptions {
  maxSurfels?: number;
  profile?: AppendMeshSurfelsProfile;
}

export interface MeshSurfelPreflightResult {
  earlyStopped: boolean;
  maxSurfels: number;
  meshCount: number;
  meshSampleStride: number;
  meshTriangles: number;
  meshVertices: number;
  newVoxelCount: number;
  poseMisses: number;
  projectedSurfels: number;
  skippedSurfels: number;
  stopAtNewVoxels: number;
  stopAtSurfels: number;
  strideSkippedCandidates: number;
  surfelCount: number;
  updatedVoxelCount: number;
}

export interface MeshSurfelPreflightOptions {
  maxSurfels?: number;
  stopAtNewVoxels?: number;
  stopAtSurfels?: number;
}

function meshCandidateStrideSkip(
  candidateOrdinal: number,
  sampleStride: number,
  remainingCandidates: number
): number {
  // @ref LLP 0020#v2-arkit-mesh-snapshot - Dense WebXR mesh supplements are
  // sampled by stride; skipped stride candidates should not do per-triangle
  // centroid, projection, color, or fusion work on the JS scan path.
  if (sampleStride <= 1 || remainingCandidates <= 0) {
    return 0;
  }
  const remainder = candidateOrdinal % sampleStride;
  if (remainder === 0) {
    return 0;
  }
  return Math.min(sampleStride - remainder, remainingCandidates);
}

export interface SurfelVoxelAccumulator {
  cameraB: number;
  cameraG: number;
  cameraR: number;
  cameraWeight: number;
  count: number;
  fallbackB: number;
  fallbackG: number;
  fallbackR: number;
  fallbackWeight: number;
  normalEstimatedWeight: number;
  normalWeight: number;
  nx: number;
  ny: number;
  nz: number;
  radius: number;
  weight: number;
  x: number;
  y: number;
  z: number;
}

export interface SurfelFusionAccumulator {
  depthGridScratch: DepthSampleGridScratch | null;
  modelSurfelsScratch: Float32Array | null;
  preflightCameraPointScratch: Vec3;
  preflightVoxelKeysScratch: Set<SurfelVoxelKey>;
  preflightWorldScratch: Vec3;
  rawSampleCount: number;
  voxels: Map<SurfelVoxelKey, SurfelVoxelAccumulator>;
}

type SurfelVoxelKey = number | string;
type CameraColorSampleMode = 'normalized-transform' | 'precomputed-axis';
type DepthGridSampleMode = 'normalized-transform' | 'precomputed-identity';
type NormalizedDepthTransformMode = 'affine' | 'identity' | 'projective';
type ViewSampleUnprojectionMode = 'intrinsics-projection' | 'matrix-inverse';

export interface DepthSampleGridScratch {
  cameraPointSampled: Uint8Array;
  cameraPointScaleXs: Float32Array;
  cameraPointScaleYs: Float32Array;
  cameraPointXs: Float32Array;
  cameraPointYs: Float32Array;
  cameraPointZs: Float32Array;
  cameraWX0s: Float32Array;
  cameraWX1s: Float32Array;
  cameraWY0s: Float32Array;
  cameraWY1s: Float32Array;
  cameraX0s: Int32Array;
  cameraX1s: Int32Array;
  cameraXValid: Uint8Array;
  cameraY0s: Int32Array;
  cameraY1s: Int32Array;
  cameraYValid: Uint8Array;
  depthMeters: Float32Array;
  depthWX0s: Float32Array;
  depthWX1s: Float32Array;
  depthWY0s: Float32Array;
  depthWY1s: Float32Array;
  depthX0s: Int32Array;
  depthX1s: Int32Array;
  depthY0s: Int32Array;
  depthY1s: Int32Array;
  normalNeighborGXs: Int32Array;
  normalNeighborGYs: Int32Array;
  normalXSigns: Int8Array;
  normalYSigns: Int8Array;
  sampled: Uint8Array;
  viewXs: Float32Array;
  viewYs: Float32Array;
}

interface AppendDepthSurfelsInternalOptions extends AppendDepthSurfelsOptions {
  depthGridScratch?: DepthSampleGridScratch | null;
  depthGridScratchReused?: boolean;
  fusion?: SurfelFusionAccumulator;
}

type ViewSampleUnprojector =
  | {
    mode: 'intrinsics-projection';
    offsetX: number;
    offsetY: number;
    scaleX: number;
    scaleY: number;
  }
  | {
    inverseProjection: Float32Array;
    mode: 'matrix-inverse';
  };

type ConsumeSurfelSample = (
  x: number,
  y: number,
  z: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  weight: number,
  nx: number,
  ny: number,
  nz: number,
  normalConfidence: number
) => void;

interface SurfelSampleScratch {
  cameraPoint: Vec3;
  cameraPointX: Vec3;
  cameraPointY: Vec3;
  normal: Vec3;
  normalCamera: Vec3;
  pointToCamera: Vec3;
  world: Vec3;
}

interface CameraToWorldTransformCache {
  tx: number;
  ty: number;
  tz: number;
  xAxisX: number;
  xAxisY: number;
  xAxisZ: number;
  yAxisX: number;
  yAxisY: number;
  yAxisZ: number;
  zAxisX: number;
  zAxisY: number;
  zAxisZ: number;
}

interface DepthSampleGridCache {
  cameraPointCacheHits: number;
  cameraPointSampled: Uint8Array;
  cameraPointSampledCount: number;
  cameraPointScaleXs: Float32Array;
  cameraPointScaleYs: Float32Array;
  cameraPointXs: Float32Array;
  cameraPointYs: Float32Array;
  cameraPointZs: Float32Array;
  cameraWX0s: Float32Array;
  cameraWX1s: Float32Array;
  cameraWY0s: Float32Array;
  cameraWY1s: Float32Array;
  cameraX0s: Int32Array;
  cameraX1s: Int32Array;
  cameraXValid: Uint8Array;
  cameraY0s: Int32Array;
  cameraY1s: Int32Array;
  cameraYValid: Uint8Array;
  depth: PanoramicDepthInformation;
  depthMeters: Float32Array;
  depthTransform: Float32Array;
  depthTransformMode: NormalizedDepthTransformMode;
  depthGridSampleMode: DepthGridSampleMode;
  depthWX0s: Float32Array;
  depthWX1s: Float32Array;
  depthWY0s: Float32Array;
  depthWY1s: Float32Array;
  depthX0s: Int32Array;
  depthX1s: Int32Array;
  depthY0s: Int32Array;
  depthY1s: Int32Array;
  normalNeighborGXs: Int32Array;
  normalNeighborGYs: Int32Array;
  normalXSigns: Int8Array;
  normalYSigns: Int8Array;
  sampleOffsetX: number;
  sampleOffsetY: number;
  sampled: Uint8Array;
  sampledCount: number;
  values: Float32Array;
  viewXs: Float32Array;
  viewYs: Float32Array;
}

interface CameraColorSampler {
  bytes: Uint8Array;
  cameraWX0s?: Float32Array;
  cameraWX1s?: Float32Array;
  cameraWY0s?: Float32Array;
  cameraWY1s?: Float32Array;
  cameraX0s?: Int32Array;
  cameraX1s?: Int32Array;
  cameraXValid?: Uint8Array;
  cameraY0s?: Int32Array;
  cameraY1s?: Int32Array;
  cameraYValid?: Uint8Array;
  format: PanoramicCameraImage['format'];
  height: number;
  maxPixelX: number;
  maxPixelY: number;
  sampleMode: CameraColorSampleMode;
  transform: Float32Array;
  transformMode: NormalizedDepthTransformMode;
  width: number;
}

export function shouldAcceptPanoramicKeyframe({
  candidateSurfels,
  existingSurfels,
  forward,
  keyframes,
  last,
  maxKeyframes = MAX_KEYFRAMES,
  maxRotationDegPerSecond = KEYFRAME_MAX_ROTATION_DEG_PER_SEC,
  maxSurfels = MAX_SURFELS,
  maxTranslationMPerSecond = KEYFRAME_MAX_TRANSLATION_M_PER_SEC,
  minIntervalMs = KEYFRAME_MIN_INTERVAL_MS,
  minRotationDeg = KEYFRAME_MIN_ROTATION_DEG,
  minSurfels = MIN_KEYFRAME_SURFELS,
  minTranslationM = KEYFRAME_MIN_TRANSLATION_M,
  position,
  time,
}: KeyframeAcceptanceInput): KeyframeAcceptanceDecision {
  const emptyMotion = {
    rotationDeg: 0,
    rotationSpeedDegPerSec: 0,
    translationM: 0,
    translationSpeedMPerSec: 0,
  };
  if (keyframes >= maxKeyframes) {
    return { accepted: false, reason: 'max-keyframes', ...emptyMotion };
  }
  if (existingSurfels >= maxSurfels) {
    return { accepted: false, reason: 'max-surfels', ...emptyMotion };
  }
  if (candidateSurfels !== undefined && candidateSurfels < minSurfels) {
    return { accepted: false, reason: 'too-few-surfels', ...emptyMotion };
  }
  if (!last) {
    return { accepted: true, reason: null, ...emptyMotion };
  }

  const translationM = distance(position, last.position);
  const rotationDeg = angleDegrees(forward, last.forward);
  const elapsedSeconds = Math.max((time - last.time) / 1000, 1e-3);
  const translationSpeedMPerSec = translationM / elapsedSeconds;
  const rotationSpeedDegPerSec = rotationDeg / elapsedSeconds;
  const motion = {
    rotationDeg,
    rotationSpeedDegPerSec,
    translationM,
    translationSpeedMPerSec,
  };
  if (time - last.time < minIntervalMs) {
    return { accepted: false, reason: 'too-soon', ...motion };
  }
  // @ref LLP 0020#keyframe-policy - Fast camera motion increases pose/depth
  // mismatch and motion blur. Drop those frames before asking WebXR for CPU
  // depth/camera bytes, instead of fusing noisy surfels into the model.
  if (translationSpeedMPerSec > maxTranslationMPerSecond || rotationSpeedDegPerSec > maxRotationDegPerSecond) {
    return { accepted: false, reason: 'too-fast', ...motion };
  }
  if (translationM < minTranslationM && rotationDeg < minRotationDeg) {
    return { accepted: false, reason: 'too-similar', ...motion };
  }
  return { accepted: true, reason: null, ...motion };
}

export function shouldSkipCoveredPanoramicSector({
  coverageSectors,
  forward,
  keyframes,
  minTranslationM = KEYFRAME_MIN_TRANSLATION_M,
  scanForwardSum,
  translationM,
}: CoveredSectorPrecheckInput): boolean {
  // @ref LLP 0020#keyframe-policy - A deliberate 180-degree scan should spend
  // CPU depth work on new sectors or translated parallax, not rotation-only
  // revisits of a sector that already has an accepted keyframe.
  if (keyframes <= 0 || coverageSectors.size <= 0) return false;
  if (!Number.isFinite(translationM) || translationM >= minTranslationM) return false;
  const coverageSector = panoramicCoverageKey(forward, { centerForward: scanForwardSum });
  return coverageSectors.has(coverageSector);
}

export function panoramicCoverageKey(
  forward: Vec3,
  {
    centerForward,
    pitchBins = PANORAMIC_COVERAGE_PITCH_BINS,
    pitchRangeDeg = PANORAMIC_COVERAGE_PITCH_RANGE_DEG,
    yawRangeDeg = PANORAMIC_COVERAGE_YAW_RANGE_DEG,
    yawBins = PANORAMIC_COVERAGE_YAW_BINS,
  }: PanoramicCoverageOptions = {}
): string {
  const direction = normalize(forward);
  // @ref LLP 0020#model-view - Coverage for the 180-degree scan is relative
  // to the accepted scan arc, not to an arbitrary AR world yaw.
  const center = centerForward ? normalizeOrDefault(centerForward, [0, 0, -1]) : [0, 0, -1] as Vec3;
  const yaw = signedYawDelta(horizontalYaw(center), horizontalYaw(direction));
  const yawRangeRad = Math.max(1, Math.min(360, yawRangeDeg)) * Math.PI / 180;
  const yawUnit = yawRangeDeg >= 360
    ? positiveModulo(yaw / (Math.PI * 2), 1)
    : clamp((yaw + yawRangeRad / 2) / yawRangeRad, 0, 0.999999);
  const pitchRangeRad = Math.max(1, pitchRangeDeg) * Math.PI / 180;
  const pitch = Math.asin(clamp(direction[1], -1, 1));
  const pitchUnit = clamp((pitch + pitchRangeRad) / (pitchRangeRad * 2), 0, 0.999999);
  const safeYawBins = Math.max(1, Math.floor(yawBins));
  const safePitchBins = Math.max(1, Math.floor(pitchBins));
  const yawBin = Math.min(safeYawBins - 1, Math.floor(yawUnit * safeYawBins));
  const pitchBin = Math.min(safePitchBins - 1, Math.floor(pitchUnit * safePitchBins));
  return `${yawBin}:${pitchBin}`;
}

export function panoramicCoverageSectors(
  forwards: readonly Vec3[],
  options: PanoramicCoverageOptions = {}
): Set<string> {
  const centerForward = options.centerForward ?? averageForward(forwards);
  return new Set(forwards.map((forward) => panoramicCoverageKey(forward, { ...options, centerForward })));
}

export function panoramicCoveragePercent(
  sectors: ReadonlySet<string>,
  {
    pitchBins = PANORAMIC_COVERAGE_PITCH_BINS,
    yawBins = PANORAMIC_COVERAGE_YAW_BINS,
  }: Pick<PanoramicCoverageOptions, 'pitchBins' | 'yawBins'> = {}
): number {
  const totalSectors = Math.max(1, Math.floor(yawBins) * Math.floor(pitchBins));
  return clamp(sectors.size / totalSectors * 100, 0, 100);
}

export function appendDepthSurfels(
  depth: PanoramicDepthInformation,
  camera: PanoramicCameraImageSource,
  projectionMatrix: Float32Array,
  cameraToWorld: Float32Array,
  store: number[],
  existingSurfels: number,
  {
    detailedProfile = false,
    minNewVoxelsForFusion = 0,
    minSurfelsForCamera = 1,
    profile,
    samplePhase = 0,
  }: AppendDepthSurfelsOptions = {}
): AppendDepthSurfelsResult {
  return appendDepthSurfelsWithConsumer(
    depth,
    camera,
    projectionMatrix,
    cameraToWorld,
    existingSurfels,
    { detailedProfile, minNewVoxelsForFusion, minSurfelsForCamera, profile, samplePhase },
    (
      x,
      y,
      z,
      radius,
      r,
      g,
      b,
      weight,
      nx,
      ny,
      nz,
      normalConfidence
    ) => {
      store.push(
        x,
        y,
        z,
        radius,
        r,
        g,
        b,
        weight,
        nx,
        ny,
        nz,
        normalConfidence
      );
    }
  );
}

export function appendDepthSurfelsToFusion(
  depth: PanoramicDepthInformation,
  camera: PanoramicCameraImageSource,
  projectionMatrix: Float32Array,
  cameraToWorld: Float32Array,
  fusion: SurfelFusionAccumulator,
  existingSurfels: number,
  {
    detailedProfile = false,
    minNewVoxelsForFusion = 0,
    minSurfelsForCamera = 1,
    profile,
    samplePhase = 0,
  }: AppendDepthSurfelsOptions = {}
): AppendDepthSurfelsResult {
  const depthGridScratch = ensureDepthGridScratch(fusion);
  return appendDepthSurfelsWithConsumer(
    depth,
    camera,
    projectionMatrix,
    cameraToWorld,
    existingSurfels,
    {
      detailedProfile,
      depthGridScratch: depthGridScratch.scratch,
      depthGridScratchReused: depthGridScratch.reused,
      fusion,
      minNewVoxelsForFusion,
      minSurfelsForCamera,
      profile,
      samplePhase,
    },
    null
  );
}

export function appendMeshSurfelsToFusion<TMesh extends PanoramicMeshGeometry>(
  meshes: Iterable<TMesh>,
  getMeshPose: (mesh: TMesh) => PanoramicRigidTransform | null,
  camera: PanoramicCameraImageSource,
  projectionMatrix: Float32Array,
  cameraToWorld: Float32Array,
  fusion: SurfelFusionAccumulator,
  existingSurfels: number,
  {
    maxSurfels = MESH_SURFEL_SAMPLE_BUDGET,
    profile,
  }: AppendMeshSurfelsOptions = {}
): AppendDepthSurfelsResult {
  const appendStart = performanceNow();
  const meshList = Array.from(meshes);
  let faceNormalMeshCount = 0;
  let meshNormalCount = 0;
  let otherNormalMeshCount = 0;
  let vertexNormalMeshCount = 0;
  let meshTriangles = 0;
  let meshVertices = 0;
  for (const mesh of meshList) {
    const vertexCount = Math.floor(mesh.vertices.length / 3);
    const triangleCount = Math.floor(mesh.indices.length / 3);
    const normalCount = Math.floor((mesh.normals?.length ?? 0) / 3);
    meshVertices += vertexCount;
    meshTriangles += triangleCount;
    meshNormalCount += normalCount;
    if (normalCount <= 0) {
      continue;
    }
    if (normalCount === triangleCount && triangleCount > 0) {
      faceNormalMeshCount += 1;
    } else if (normalCount === vertexCount && vertexCount > 0) {
      vertexNormalMeshCount += 1;
    } else {
      otherNormalMeshCount += 1;
    }
  }
  const remainingCapacity = Math.max(0, MAX_SURFELS - existingSurfels);
  const sampleBudget = Math.max(0, Math.min(Math.floor(maxSurfels), remainingCapacity));
  const candidateCount = meshTriangles > 0 ? meshTriangles : meshVertices;
  const sampleStride = sampleBudget > 0 && candidateCount > sampleBudget
    ? Math.ceil(candidateCount / sampleBudget)
    : 1;
  if (profile) {
    profile.maxSurfels = sampleBudget;
    profile.meshCount = meshList.length;
    profile.meshNormalCount = meshNormalCount;
    profile.meshNormalMode = summarizeMeshNormalMode(
      faceNormalMeshCount,
      vertexNormalMeshCount,
      otherNormalMeshCount
    );
    profile.meshSampleStride = sampleStride;
    profile.meshTriangles = meshTriangles;
    profile.meshVertices = meshVertices;
  }
  if (sampleBudget <= 0 || candidateCount <= 0) {
    if (profile) {
      profile.appendTotalMs = performanceNow() - appendStart;
      profile.cameraRequested = false;
      profile.sampledSurfels = 0;
    }
    return { cameraColoredSurfels: 0, newVoxelCount: 0, surfelCount: 0, updatedVoxelCount: 0 };
  }

  const worldToCamera = invertMatrix4(cameraToWorld);
  const cameraPosition = extractPosition(cameraToWorld);
  if (profile) {
    profile.cameraImageMs = 0;
    profile.cameraRequested = false;
    profile.cameraWidth = undefined;
    profile.cameraHeight = undefined;
    profile.cameraBytes = undefined;
    profile.cameraSampleMode = undefined;
    profile.cameraTransformMode = undefined;
  }
  let cameraSampler: CameraColorSampler | null | undefined;
  const getCameraSampler = (): CameraColorSampler | null => {
    if (cameraSampler !== undefined) {
      return cameraSampler;
    }
    const cameraStart = performanceNow();
    const resolvedCamera = resolveCameraImage(camera);
    if (profile) {
      profile.cameraImageMs = performanceNow() - cameraStart;
      profile.cameraRequested = resolvedCamera !== null;
      profile.cameraWidth = resolvedCamera?.width;
      profile.cameraHeight = resolvedCamera?.height;
      profile.cameraBytes = resolvedCamera?.data.byteLength;
    }
    const cameraBytes = resolvedCamera ? new Uint8Array(resolvedCamera.data) : null;
    const cameraTransform = resolvedCamera?.normCameraImageFromNormView.matrix ?? null;
    cameraSampler = resolvedCamera && cameraBytes && cameraTransform
      ? createCameraColorSampler(resolvedCamera, cameraBytes, cameraTransform)
      : null;
    if (profile) {
      profile.cameraSampleMode = cameraSampler?.sampleMode;
      profile.cameraTransformMode = cameraSampler?.transformMode;
    }
    return cameraSampler;
  };

  let cameraColoredSurfels = 0;
  let candidateOrdinal = 0;
  let newVoxelCount = 0;
  let planeProjectedSamples = 0;
  let poseMisses = 0;
  let projectedSurfels = 0;
  let skippedSurfels = 0;
  let surfelCount = 0;
  let strideSkippedCandidates = 0;
  let updatedVoxelCount = 0;
  const colorScratch: Vec3 = [0, 0, 0];
  const localNormalScratch: Vec3 = [0, 0, 1];
  const localPointScratch: Vec3 = [0, 0, 0];
  const worldScratch: Vec3 = [0, 0, 0];
  const normalScratch: Vec3 = [0, 0, 1];
  const viewScratch: Vec3 = [0, 0, 0];

  for (const mesh of meshList) {
    if (surfelCount >= sampleBudget || existingSurfels + surfelCount >= MAX_SURFELS) break;
    const pose = getMeshPose(mesh);
    const meshToWorld = pose?.matrix;
    if (!meshToWorld) {
      poseMisses += 1;
      continue;
    }
    const vertices = mesh.vertices;
    const normals = mesh.normals;
    const indices = mesh.indices;
    const vertexCount = Math.floor(vertices.length / 3);
    const triangleCount = Math.floor(indices.length / 3);
    if (indices.length >= 3) {
      for (
        let i = 0;
        i + 2 < indices.length && surfelCount < sampleBudget && existingSurfels + surfelCount < MAX_SURFELS;
        i += 3
      ) {
        const strideSkip = meshCandidateStrideSkip(
          candidateOrdinal,
          sampleStride,
          Math.floor((indices.length - i) / 3)
        );
        if (strideSkip > 0) {
          candidateOrdinal += strideSkip;
          strideSkippedCandidates += strideSkip;
          i += (strideSkip - 1) * 3;
          continue;
        }
        candidateOrdinal += 1;
        const i0 = (indices[i] ?? 0) * 3;
        const i1 = (indices[i + 1] ?? 0) * 3;
        const i2 = (indices[i + 2] ?? 0) * 3;
        if (!meshTriangleCentroidInto(localPointScratch, vertices, i0, i1, i2)) {
          skippedSurfels += 1;
          continue;
        }
        transformPointInto(worldScratch, meshToWorld, localPointScratch);
        if (!meshTriangleNormalInto(
          localNormalScratch,
          vertices,
          normals,
          i0,
          i1,
          i2,
          i / 3,
          vertexCount,
          triangleCount
        )) {
          skippedSurfels += 1;
          continue;
        }
        transformDirectionInto(normalScratch, meshToWorld, localNormalScratch);
        normalizeInto(normalScratch, normalScratch);
        const appended = appendMeshSurfel(
          fusion,
          worldScratch,
          normalScratch,
          colorScratch,
          viewScratch,
          cameraPosition,
          getCameraSampler,
          projectionMatrix,
          worldToCamera
        );
        if (!appended.appended) {
          skippedSurfels += 1;
          continue;
        }
        if (appended.cameraColored) cameraColoredSurfels += 1;
        if (appended.projected) projectedSurfels += 1;
        if (appended.planeProjected) planeProjectedSamples += 1;
        if (appended.createdVoxel) newVoxelCount += 1;
        else updatedVoxelCount += 1;
        surfelCount += 1;
      }
    } else {
      for (
        let i = 0;
        i + 2 < vertices.length && surfelCount < sampleBudget && existingSurfels + surfelCount < MAX_SURFELS;
        i += 3
      ) {
        const strideSkip = meshCandidateStrideSkip(
          candidateOrdinal,
          sampleStride,
          Math.floor((vertices.length - i) / 3)
        );
        if (strideSkip > 0) {
          candidateOrdinal += strideSkip;
          strideSkippedCandidates += strideSkip;
          i += (strideSkip - 1) * 3;
          continue;
        }
        candidateOrdinal += 1;
        localPointScratch[0] = vertices[i] ?? 0;
        localPointScratch[1] = vertices[i + 1] ?? 0;
        localPointScratch[2] = vertices[i + 2] ?? 0;
        transformPointInto(worldScratch, meshToWorld, localPointScratch);
        if (normals && normals.length === vertices.length) {
          localNormalScratch[0] = normals[i] ?? 0;
          localNormalScratch[1] = normals[i + 1] ?? 0;
          localNormalScratch[2] = normals[i + 2] ?? 1;
          transformDirectionInto(normalScratch, meshToWorld, localNormalScratch);
          normalizeInto(normalScratch, normalScratch);
        } else {
          normalScratch[0] = cameraPosition[0] - worldScratch[0];
          normalScratch[1] = cameraPosition[1] - worldScratch[1];
          normalScratch[2] = cameraPosition[2] - worldScratch[2];
          normalizeInto(normalScratch, normalScratch);
        }
        const appended = appendMeshSurfel(
          fusion,
          worldScratch,
          normalScratch,
          colorScratch,
          viewScratch,
          cameraPosition,
          getCameraSampler,
          projectionMatrix,
          worldToCamera
        );
        if (!appended.appended) {
          skippedSurfels += 1;
          continue;
        }
        if (appended.cameraColored) cameraColoredSurfels += 1;
        if (appended.projected) projectedSurfels += 1;
        if (appended.planeProjected) planeProjectedSamples += 1;
        if (appended.createdVoxel) newVoxelCount += 1;
        else updatedVoxelCount += 1;
        surfelCount += 1;
      }
    }
  }

  if (profile) {
    profile.appendTotalMs = performanceNow() - appendStart;
    profile.cameraColoredSurfels = cameraColoredSurfels;
    profile.planeProjectedSamples = planeProjectedSamples;
    profile.poseMisses = poseMisses;
    profile.projectedSurfels = projectedSurfels;
    profile.sampledSurfels = surfelCount;
    profile.skippedSurfels = skippedSurfels;
    profile.strideSkippedCandidates = strideSkippedCandidates;
  }
  return { cameraColoredSurfels, newVoxelCount, surfelCount, updatedVoxelCount };
}

export function preflightMeshSurfelsForFusion<TMesh extends PanoramicMeshGeometry>(
  meshes: Iterable<TMesh>,
  getMeshPose: (mesh: TMesh) => PanoramicRigidTransform | null,
  projectionMatrix: Float32Array,
  cameraToWorld: Float32Array,
  fusion: SurfelFusionAccumulator,
  existingSurfels: number,
  options: number | MeshSurfelPreflightOptions = MESH_SURFEL_SAMPLE_BUDGET
): MeshSurfelPreflightResult {
  const {
    maxSurfels = MESH_SURFEL_SAMPLE_BUDGET,
    stopAtNewVoxels = 0,
    stopAtSurfels = 0,
  } = typeof options === 'number' ? { maxSurfels: options } : options;
  const meshList = Array.from(meshes);
  let meshTriangles = 0;
  let meshVertices = 0;
  for (const mesh of meshList) {
    meshVertices += Math.floor(mesh.vertices.length / 3);
    meshTriangles += Math.floor(mesh.indices.length / 3);
  }
  const remainingCapacity = Math.max(0, MAX_SURFELS - existingSurfels);
  const sampleBudget = Math.max(0, Math.min(Math.floor(maxSurfels), remainingCapacity));
  const candidateCount = meshTriangles > 0 ? meshTriangles : meshVertices;
  const sampleStride = sampleBudget > 0 && candidateCount > sampleBudget
    ? Math.ceil(candidateCount / sampleBudget)
    : 1;
  const result: MeshSurfelPreflightResult = {
    earlyStopped: false,
    maxSurfels: sampleBudget,
    meshCount: meshList.length,
    meshSampleStride: sampleStride,
    meshTriangles,
    meshVertices,
    newVoxelCount: 0,
    poseMisses: 0,
    projectedSurfels: 0,
    skippedSurfels: 0,
    stopAtNewVoxels: Math.max(0, Math.floor(stopAtNewVoxels)),
    stopAtSurfels: Math.max(0, Math.floor(stopAtSurfels)),
    strideSkippedCandidates: 0,
    surfelCount: 0,
    updatedVoxelCount: 0,
  };
  if (sampleBudget <= 0 || candidateCount <= 0) {
    return result;
  }
  const worldToCamera = invertMatrix4(cameraToWorld);
  const cameraPosition = extractPosition(cameraToWorld);

  const candidateNewVoxelKeys = fusion.preflightVoxelKeysScratch;
  candidateNewVoxelKeys.clear();
  let candidateOrdinal = 0;
  const localPointScratch: Vec3 = [0, 0, 0];
  const worldScratch: Vec3 = [0, 0, 0];
  const viewScratch: Vec3 = [0, 0, 0];
  for (const mesh of meshList) {
    if (result.surfelCount >= sampleBudget || existingSurfels + result.surfelCount >= MAX_SURFELS) break;
    const pose = getMeshPose(mesh);
    const meshToWorld = pose?.matrix;
    if (!meshToWorld) {
      result.poseMisses += 1;
      continue;
    }
    const vertices = mesh.vertices;
    const indices = mesh.indices;
    if (indices.length >= 3) {
      for (
        let i = 0;
        i + 2 < indices.length && result.surfelCount < sampleBudget && existingSurfels + result.surfelCount < MAX_SURFELS;
        i += 3
      ) {
        const strideSkip = meshCandidateStrideSkip(
          candidateOrdinal,
          sampleStride,
          Math.floor((indices.length - i) / 3)
        );
        if (strideSkip > 0) {
          candidateOrdinal += strideSkip;
          result.strideSkippedCandidates += strideSkip;
          i += (strideSkip - 1) * 3;
          continue;
        }
        candidateOrdinal += 1;
        const i0 = (indices[i] ?? 0) * 3;
        const i1 = (indices[i + 1] ?? 0) * 3;
        const i2 = (indices[i + 2] ?? 0) * 3;
        if (!meshTriangleCentroidInto(localPointScratch, vertices, i0, i1, i2)) {
          result.skippedSurfels += 1;
          continue;
        }
        transformPointInto(worldScratch, meshToWorld, localPointScratch);
        const projected = Boolean(
          worldToCamera &&
          projectWorldPointToViewInto(viewScratch, worldToCamera, projectionMatrix, worldScratch)
        );
        const depthMeters = projected ? viewScratch[2] : distanceBetween(worldScratch, cameraPosition);
        if (!isAcceptedMeshSurfelDepth(depthMeters)) {
          result.skippedSurfels += 1;
          continue;
        }
        countMeshPreflightVoxel(result, candidateNewVoxelKeys, fusion, worldScratch, projected);
        if (meshPreflightTargetsReached(result)) {
          result.earlyStopped = true;
          candidateNewVoxelKeys.clear();
          return result;
        }
      }
    } else {
      for (
        let i = 0;
        i + 2 < vertices.length && result.surfelCount < sampleBudget && existingSurfels + result.surfelCount < MAX_SURFELS;
        i += 3
      ) {
        const strideSkip = meshCandidateStrideSkip(
          candidateOrdinal,
          sampleStride,
          Math.floor((vertices.length - i) / 3)
        );
        if (strideSkip > 0) {
          candidateOrdinal += strideSkip;
          result.strideSkippedCandidates += strideSkip;
          i += (strideSkip - 1) * 3;
          continue;
        }
        candidateOrdinal += 1;
        localPointScratch[0] = vertices[i] ?? 0;
        localPointScratch[1] = vertices[i + 1] ?? 0;
        localPointScratch[2] = vertices[i + 2] ?? 0;
        transformPointInto(worldScratch, meshToWorld, localPointScratch);
        const projected = Boolean(
          worldToCamera &&
          projectWorldPointToViewInto(viewScratch, worldToCamera, projectionMatrix, worldScratch)
        );
        const depthMeters = projected ? viewScratch[2] : distanceBetween(worldScratch, cameraPosition);
        if (!isAcceptedMeshSurfelDepth(depthMeters)) {
          result.skippedSurfels += 1;
          continue;
        }
        countMeshPreflightVoxel(result, candidateNewVoxelKeys, fusion, worldScratch, projected);
        if (meshPreflightTargetsReached(result)) {
          result.earlyStopped = true;
          candidateNewVoxelKeys.clear();
          return result;
        }
      }
    }
  }
  candidateNewVoxelKeys.clear();
  return result;
}

function meshPreflightTargetsReached(result: MeshSurfelPreflightResult): boolean {
  // @ref LLP 0020#v2-arkit-mesh-snapshot - Mesh rescue preflight only needs
  // enough appendable mesh surfels and new voxels to decide the current gate.
  if (result.stopAtSurfels <= 0 && result.stopAtNewVoxels <= 0) {
    return false;
  }
  const surfelTargetReached = result.stopAtSurfels <= 0 || result.surfelCount >= result.stopAtSurfels;
  const newVoxelTargetReached = result.stopAtNewVoxels <= 0 || result.newVoxelCount >= result.stopAtNewVoxels;
  return surfelTargetReached && newVoxelTargetReached;
}

function summarizeMeshNormalMode(
  faceNormalMeshCount: number,
  vertexNormalMeshCount: number,
  otherNormalMeshCount: number
): MeshNormalMode {
  const modeCount =
    (faceNormalMeshCount > 0 ? 1 : 0) +
    (vertexNormalMeshCount > 0 ? 1 : 0) +
    (otherNormalMeshCount > 0 ? 1 : 0);
  if (modeCount > 1) return 'mixed';
  if (faceNormalMeshCount > 0) return 'face';
  if (vertexNormalMeshCount > 0) return 'vertex';
  if (otherNormalMeshCount > 0) return 'other';
  return 'none';
}

function ensureDepthGridScratch(
  fusion: SurfelFusionAccumulator
): { reused: boolean; scratch: DepthSampleGridScratch } {
  const existing = fusion.depthGridScratch;
  if (existing && depthGridScratchHasExpectedShape(existing)) {
    return { reused: true, scratch: existing };
  }
  const scratch = createDepthGridScratch();
  fusion.depthGridScratch = scratch;
  return { reused: false, scratch };
}

function createDepthGridScratch(): DepthSampleGridScratch {
  return {
    cameraPointSampled: new Uint8Array(SAMPLE_GRID_X * SAMPLE_GRID_Y),
    cameraPointScaleXs: new Float32Array(SAMPLE_GRID_X),
    cameraPointScaleYs: new Float32Array(SAMPLE_GRID_Y),
    cameraPointXs: new Float32Array(SAMPLE_GRID_X * SAMPLE_GRID_Y),
    cameraPointYs: new Float32Array(SAMPLE_GRID_X * SAMPLE_GRID_Y),
    cameraPointZs: new Float32Array(SAMPLE_GRID_X * SAMPLE_GRID_Y),
    cameraWX0s: new Float32Array(SAMPLE_GRID_X),
    cameraWX1s: new Float32Array(SAMPLE_GRID_X),
    cameraWY0s: new Float32Array(SAMPLE_GRID_Y),
    cameraWY1s: new Float32Array(SAMPLE_GRID_Y),
    cameraX0s: new Int32Array(SAMPLE_GRID_X),
    cameraX1s: new Int32Array(SAMPLE_GRID_X),
    cameraXValid: new Uint8Array(SAMPLE_GRID_X),
    cameraY0s: new Int32Array(SAMPLE_GRID_Y),
    cameraY1s: new Int32Array(SAMPLE_GRID_Y),
    cameraYValid: new Uint8Array(SAMPLE_GRID_Y),
    depthMeters: new Float32Array(SAMPLE_GRID_X * SAMPLE_GRID_Y),
    depthWX0s: new Float32Array(SAMPLE_GRID_X),
    depthWX1s: new Float32Array(SAMPLE_GRID_X),
    depthWY0s: new Float32Array(SAMPLE_GRID_Y),
    depthWY1s: new Float32Array(SAMPLE_GRID_Y),
    depthX0s: new Int32Array(SAMPLE_GRID_X),
    depthX1s: new Int32Array(SAMPLE_GRID_X),
    depthY0s: new Int32Array(SAMPLE_GRID_Y),
    depthY1s: new Int32Array(SAMPLE_GRID_Y),
    normalNeighborGXs: new Int32Array(SAMPLE_GRID_X),
    normalNeighborGYs: new Int32Array(SAMPLE_GRID_Y),
    normalXSigns: new Int8Array(SAMPLE_GRID_X),
    normalYSigns: new Int8Array(SAMPLE_GRID_Y),
    sampled: new Uint8Array(SAMPLE_GRID_X * SAMPLE_GRID_Y),
    viewXs: new Float32Array(SAMPLE_GRID_X),
    viewYs: new Float32Array(SAMPLE_GRID_Y),
  };
}

function depthGridScratchHasExpectedShape(scratch: DepthSampleGridScratch): boolean {
  const gridSize = SAMPLE_GRID_X * SAMPLE_GRID_Y;
  return scratch.cameraPointSampled.length === gridSize &&
    scratch.cameraPointScaleXs.length === SAMPLE_GRID_X &&
    scratch.cameraPointScaleYs.length === SAMPLE_GRID_Y &&
    scratch.cameraPointXs.length === gridSize &&
    scratch.cameraPointYs.length === gridSize &&
    scratch.cameraPointZs.length === gridSize &&
    scratch.cameraWX0s.length === SAMPLE_GRID_X &&
    scratch.cameraWX1s.length === SAMPLE_GRID_X &&
    scratch.cameraWY0s.length === SAMPLE_GRID_Y &&
    scratch.cameraWY1s.length === SAMPLE_GRID_Y &&
    scratch.cameraX0s.length === SAMPLE_GRID_X &&
    scratch.cameraX1s.length === SAMPLE_GRID_X &&
    scratch.cameraXValid.length === SAMPLE_GRID_X &&
    scratch.cameraY0s.length === SAMPLE_GRID_Y &&
    scratch.cameraY1s.length === SAMPLE_GRID_Y &&
    scratch.cameraYValid.length === SAMPLE_GRID_Y &&
    scratch.depthMeters.length === gridSize &&
    scratch.depthWX0s.length === SAMPLE_GRID_X &&
    scratch.depthWX1s.length === SAMPLE_GRID_X &&
    scratch.depthWY0s.length === SAMPLE_GRID_Y &&
    scratch.depthWY1s.length === SAMPLE_GRID_Y &&
    scratch.depthX0s.length === SAMPLE_GRID_X &&
    scratch.depthX1s.length === SAMPLE_GRID_X &&
    scratch.depthY0s.length === SAMPLE_GRID_Y &&
    scratch.depthY1s.length === SAMPLE_GRID_Y &&
    scratch.normalNeighborGXs.length === SAMPLE_GRID_X &&
    scratch.normalNeighborGYs.length === SAMPLE_GRID_Y &&
    scratch.normalXSigns.length === SAMPLE_GRID_X &&
    scratch.normalYSigns.length === SAMPLE_GRID_Y &&
    scratch.sampled.length === gridSize &&
    scratch.viewXs.length === SAMPLE_GRID_X &&
    scratch.viewYs.length === SAMPLE_GRID_Y;
}

function appendDepthSurfelsWithConsumer(
  depth: PanoramicDepthInformation,
  camera: PanoramicCameraImageSource,
  projectionMatrix: Float32Array,
  cameraToWorld: Float32Array,
  existingSurfels: number,
  {
    detailedProfile = false,
    depthGridScratch = null,
    depthGridScratchReused = false,
    fusion,
    minNewVoxelsForFusion = 0,
    minSurfelsForCamera = 1,
    profile,
    samplePhase = 0,
  }: AppendDepthSurfelsInternalOptions,
  consume: ConsumeSurfelSample | null
): AppendDepthSurfelsResult {
  const appendStart = performanceNow();
  // @ref LLP 0020#reconstruction-pipeline - Sparse keyframes phase their
  // subcell sample locations so a fixed per-frame budget still covers
  // different WebXR depth pixels across the scan.
  const sampleOffsetX = sampleGridOffsetForPhase(samplePhase, 0.6180339887498949);
  const sampleOffsetY = sampleGridOffsetForPhase(samplePhase, 0.4142135623730951);
  if (profile) {
    profile.depthCacheReused = depthGridScratchReused;
    profile.depthWidth = depth.width;
    profile.depthHeight = depth.height;
    profile.depthTransformMode = normalizedDepthTransformMode(depth.normDepthBufferFromNormView.matrix);
    profile.minNewVoxelsForFusion = minNewVoxelsForFusion;
    profile.minSurfelsForCamera = minSurfelsForCamera;
    profile.sampleGridX = SAMPLE_GRID_X;
    profile.sampleGridY = SAMPLE_GRID_Y;
    profile.sampleOffsetX = sampleOffsetX;
    profile.sampleOffsetY = sampleOffsetY;
    profile.samplePhase = Math.max(0, Math.floor(samplePhase));
  }
  const unprojector = createViewSampleUnprojector(projectionMatrix);
  if (!unprojector) {
    if (profile) profile.appendTotalMs = performanceNow() - appendStart;
    return { cameraColoredSurfels: 0, newVoxelCount: 0, surfelCount: 0, updatedVoxelCount: 0 };
  }
  if (profile) profile.unprojectionMode = unprojector.mode;
  const depthDataStart = performanceNow();
  const values = new Float32Array(depth.data);
  if (profile) {
    profile.depthBytes = values.byteLength;
    profile.depthDataMs = performanceNow() - depthDataStart;
  }
  const depthTransform = depth.normDepthBufferFromNormView.matrix;
  const depthCache = createDepthSampleGridCache(
    values,
    depth,
    depthTransform,
    profile?.depthTransformMode ?? normalizedDepthTransformMode(depthTransform),
    unprojector,
    sampleOffsetX,
    sampleOffsetY,
    depthGridScratch
  );
  if (profile) profile.depthGridSampleMode = depthCache.depthGridSampleMode;
  // @ref LLP 0020#performance-constraints - Accepted keyframes transform many
  // surfels and normal vectors through the same XRView camera-to-world matrix.
  // Cache the rigid transform axes once so the hot loop avoids repeated matrix
  // indexing and generic helper dispatch while still consuming WebXR geometry.
  const cameraToWorldCache = createCameraToWorldTransformCache(cameraToWorld);
  const cameraPosition: Vec3 = [cameraToWorldCache.tx, cameraToWorldCache.ty, cameraToWorldCache.tz];
  const lazyCamera = typeof camera === 'function';
  if (fusion && minNewVoxelsForFusion > 0) {
    const newVoxelPreflightStart = performanceNow();
    const contribution = countNewVoxelDepthSurfels(
      depthCache,
      unprojector,
      cameraToWorldCache,
      fusion,
      existingSurfels,
      minNewVoxelsForFusion,
      lazyCamera ? minSurfelsForCamera : 0
    );
    if (profile) {
      profile.newVoxelPreflightMs = performanceNow() - newVoxelPreflightStart;
      profile.preflightNewVoxels = contribution.newVoxelCount;
      profile.preflightSurfels = contribution.surfelCount;
      profile.preflightUpdatedVoxels = contribution.updatedVoxelCount;
      profile.depthGridSampleCount = depthCache.sampledCount;
    }
    if (
      contribution.newVoxelCount < minNewVoxelsForFusion ||
      (lazyCamera && contribution.surfelCount < minSurfelsForCamera)
    ) {
      if (profile) {
        profile.appendTotalMs = performanceNow() - appendStart;
        profile.cameraRequested = false;
        profile.cameraPointCacheHits = depthCache.cameraPointCacheHits;
        profile.cameraPointSamples = depthCache.cameraPointSampledCount;
        profile.depthGridSampleCount = depthCache.sampledCount;
      }
      return {
        cameraColoredSurfels: 0,
        newVoxelCount: contribution.newVoxelCount,
        surfelCount: contribution.surfelCount,
        updatedVoxelCount: contribution.updatedVoxelCount,
      };
    }
  } else if (lazyCamera && minSurfelsForCamera > 1) {
    const preflightStart = performanceNow();
    const candidateSurfels = countValidDepthSurfels(
      depthCache,
      existingSurfels,
      minSurfelsForCamera
    );
    if (profile) {
      profile.depthPreflightMs = performanceNow() - preflightStart;
      profile.preflightSurfels = candidateSurfels;
      profile.depthGridSampleCount = depthCache.sampledCount;
    }
    if (candidateSurfels < minSurfelsForCamera) {
      if (profile) {
        profile.appendTotalMs = performanceNow() - appendStart;
        profile.cameraRequested = false;
        profile.depthGridSampleCount = depthCache.sampledCount;
      }
      return { cameraColoredSurfels: 0, newVoxelCount: 0, surfelCount: candidateSurfels, updatedVoxelCount: 0 };
    }
  }
  if (profile) {
    profile.cameraImageMs = 0;
    profile.cameraRequested = false;
    profile.cameraWidth = undefined;
    profile.cameraHeight = undefined;
    profile.cameraBytes = undefined;
    profile.cameraSampleMode = undefined;
    profile.cameraTransformMode = undefined;
  }
  let cameraSampler: CameraColorSampler | null | undefined;
  const getCameraSampler = (): CameraColorSampler | null => {
    if (cameraSampler !== undefined) {
      return cameraSampler;
    }
    const cameraStart = performanceNow();
    const resolvedCamera = resolveCameraImage(camera);
    if (profile) {
      profile.cameraImageMs = performanceNow() - cameraStart;
      profile.cameraRequested = resolvedCamera !== null;
      profile.cameraWidth = resolvedCamera?.width;
      profile.cameraHeight = resolvedCamera?.height;
      profile.cameraBytes = resolvedCamera?.data.byteLength;
    }
    const cameraBytes = resolvedCamera ? new Uint8Array(resolvedCamera.data) : null;
    const cameraTransform = resolvedCamera?.normCameraImageFromNormView.matrix ?? null;
    cameraSampler = resolvedCamera && cameraBytes && cameraTransform
      ? createCameraColorSampler(resolvedCamera, cameraBytes, cameraTransform, depthCache)
      : null;
    if (profile) {
      profile.cameraSampleMode = cameraSampler?.sampleMode;
      profile.cameraTransformMode = cameraSampler?.transformMode;
    }
    return cameraSampler;
  };
  let added = 0;
  let cameraColoredSurfels = 0;
  let matureVoxelSkips = 0;
  let newVoxelCount = 0;
  let planeProjectedSamples = 0;
  let updatedVoxelCount = 0;
  const detailedTiming = Boolean(profile && detailedProfile);
  let depthLookupMs = 0;
  let unprojectMs = 0;
  let normalEstimateMs = 0;
  let colorSampleMs = 0;
  let sampleConsumeMs = 0;
  const timingSampleStride = detailedTiming ? DETAILED_TIMING_SAMPLE_STRIDE : 1;
  let depthLookupSampleCount = 0;
  let profiledSampleCount = 0;
  let timedDepthLookupSampleCount = 0;
  let timedSampleCount = 0;
  const colorScratch: Vec3 = [0, 0, 0];
  const sampleScratch: SurfelSampleScratch = {
    cameraPoint: [0, 0, 0],
    cameraPointX: [0, 0, 0],
    cameraPointY: [0, 0, 0],
    normal: [0, 0, 1],
    normalCamera: [0, 0, 1],
    pointToCamera: [0, 0, 1],
    world: [0, 0, 0],
  };
  if (profile && detailedTiming) {
    const centerDepthMeters = sampleDepthMetersWithMode(
      values,
      depth,
      depthTransform,
      depthCache.depthTransformMode,
      0.5,
      0.5
    );
    const centerDepthValid = Number.isFinite(centerDepthMeters) &&
      centerDepthMeters >= MIN_DEPTH_M &&
      centerDepthMeters <= MAX_DEPTH_M;
    profile.centerDepthMeters = centerDepthMeters;
    profile.centerDepthValid = centerDepthValid;
    if (centerDepthValid) {
      unprojectViewSampleInto(sampleScratch.cameraPoint, unprojector, 0.5, 0.5, centerDepthMeters);
      transformCameraPointToWorldInto(sampleScratch.world, cameraToWorldCache, sampleScratch.cameraPoint);
      profile.centerCameraMeters = [
        sampleScratch.cameraPoint[0],
        sampleScratch.cameraPoint[1],
        sampleScratch.cameraPoint[2],
      ];
      profile.centerWorldMeters = [
        sampleScratch.world[0],
        sampleScratch.world[1],
        sampleScratch.world[2],
      ];
    }
  }
  const sampleLoopStart = performanceNow();
  for (let gy = 0; gy < SAMPLE_GRID_Y && added + existingSurfels < MAX_SURFELS; gy += 1) {
    const viewY = depthCache.viewYs[gy];
    for (let gx = 0; gx < SAMPLE_GRID_X && added + existingSurfels < MAX_SURFELS; gx += 1) {
      const viewX = depthCache.viewXs[gx];
      const gridOrdinal = gy * SAMPLE_GRID_X + gx;
      const timeDepthLookup = detailedTiming && gridOrdinal % timingSampleStride === 0;
      let timingStart = timeDepthLookup ? performanceNow() : 0;
      const depthMeters = sampleCachedGridDepthMeters(depthCache, gx, gy);
      if (detailedTiming) depthLookupSampleCount += 1;
      if (timeDepthLookup) {
        depthLookupMs += performanceNow() - timingStart;
        timedDepthLookupSampleCount += 1;
      }
      if (!Number.isFinite(depthMeters) || depthMeters < MIN_DEPTH_M || depthMeters > MAX_DEPTH_M) {
        continue;
      }
      const timeSample = detailedTiming && profiledSampleCount % timingSampleStride === 0;
      profiledSampleCount += detailedTiming ? 1 : 0;
      if (timeSample) timedSampleCount += 1;
      // @ref LLP 0020#reconstruction-pipeline - WebXR depth samples are read
      // through normDepthBufferFromNormView, then unprojected with the
      // associated XRViewGeometry projection matrix.
      timingStart = timeSample ? performanceNow() : 0;
      const hasCameraPoint = sampleCachedGridCameraPointInto(
        sampleScratch.cameraPoint,
        depthCache,
        unprojector,
        gx,
        gy,
        depthMeters
      );
      if (!hasCameraPoint) {
        if (timeSample) unprojectMs += performanceNow() - timingStart;
        continue;
      }
      const cameraPoint = sampleScratch.cameraPoint;
      const world = transformCameraPointToWorldInto(sampleScratch.world, cameraToWorldCache, cameraPoint);
      if (timeSample) unprojectMs += performanceNow() - timingStart;
      if (!Number.isFinite(world[0]) || !Number.isFinite(world[1]) || !Number.isFinite(world[2])) {
        continue;
      }
      // @ref LLP 0020#reconstruction-pipeline - Mature camera-colored voxels
      // already carry enough overlap for preview quality. Skip later duplicate
      // depth samples before normal/color work to reduce smear and scan cost.
      // @ref LLP 0020#performance-constraints - Reuse this voxel key and map
      // lookup when the sample is fused below; accepted keyframes visit this
      // path for every valid WebXR depth sample.
      let fusionKey: SurfelVoxelKey | null = null;
      let fusionVoxel: SurfelVoxelAccumulator | undefined;
      if (fusion) {
        fusionKey = voxelKey(world[0], world[1], world[2]);
        fusionVoxel = fusion.voxels.get(fusionKey);
        if (isMatureDepthVoxel(fusionVoxel)) {
          matureVoxelSkips += 1;
          continue;
        }
      }
      timingStart = timeSample ? performanceNow() : 0;
      const normalConfidence = estimateWorldNormalInto(
        sampleScratch.normal,
        depthCache,
        unprojector,
        cameraToWorldCache,
        cameraPosition,
        world,
        gx,
        gy,
        depthMeters,
        cameraPoint,
        sampleScratch
      );
      if (timeSample) normalEstimateMs += performanceNow() - timingStart;
      const toCameraX = cameraPosition[0] - world[0];
      const toCameraY = cameraPosition[1] - world[1];
      const toCameraZ = cameraPosition[2] - world[2];
      const toCameraLengthSq = toCameraX * toCameraX + toCameraY * toCameraY + toCameraZ * toCameraZ;
      const invToCameraLength = toCameraLengthSq > 1e-12 ? 1 / Math.sqrt(toCameraLengthSq) : 0;
      const viewAlignment = invToCameraLength > 0
        ? Math.max(0, (
          sampleScratch.normal[0] * toCameraX +
          sampleScratch.normal[1] * toCameraY +
          sampleScratch.normal[2] * toCameraZ
        ) * invToCameraLength)
        : 0;
      timingStart = timeSample ? performanceNow() : 0;
      const sampler = getCameraSampler();
      const hasCameraColor = sampler?.sampleMode === 'precomputed-axis'
        ? samplePrecomputedGridCameraColorInto(colorScratch, sampler, gx, gy)
        : sampler
          ? sampleCameraColorWithSamplerInto(colorScratch, sampler, viewX, viewY)
          : false;
      if (!hasCameraColor) {
        depthPaletteInto(colorScratch, depthMeters);
      }
      if (timeSample) colorSampleMs += performanceNow() - timingStart;
      if (hasCameraColor) cameraColoredSurfels += 1;
      const radius = Math.max(0.6, 2.4 - depthMeters * 0.26);
      const weight = surfelSampleWeight(depthMeters, normalConfidence, viewAlignment) * (hasCameraColor ? 1 : -1);
      timingStart = timeSample ? performanceNow() : 0;
      if (fusion) {
        const appendResult = appendSurfelToFusionWithKnownVoxel(
          fusion,
          fusionKey!,
          fusionVoxel,
          world[0],
          world[1],
          world[2],
          radius,
          colorScratch[0],
          colorScratch[1],
          colorScratch[2],
          weight,
          sampleScratch.normal[0],
          sampleScratch.normal[1],
          sampleScratch.normal[2],
          normalConfidence
        );
        if (appendResult & APPEND_SURFEL_CREATED_VOXEL) {
          newVoxelCount += 1;
        } else {
          updatedVoxelCount += 1;
        }
        if (appendResult & APPEND_SURFEL_PLANE_PROJECTED) {
          planeProjectedSamples += 1;
        }
      } else if (consume) {
        consume(
          world[0],
          world[1],
          world[2],
          radius,
          colorScratch[0],
          colorScratch[1],
          colorScratch[2],
          weight,
          sampleScratch.normal[0],
          sampleScratch.normal[1],
          sampleScratch.normal[2],
          normalConfidence
        );
      }
      if (timeSample) sampleConsumeMs += performanceNow() - timingStart;
      added += 1;
    }
  }
  if (profile) {
    profile.cameraPointCacheHits = depthCache.cameraPointCacheHits;
    profile.cameraPointSamples = depthCache.cameraPointSampledCount;
    profile.depthGridSampleCount = depthCache.sampledCount;
    profile.detailedTiming = detailedTiming;
    profile.matureVoxelSkips = matureVoxelSkips;
    profile.planeProjectedSamples = planeProjectedSamples;
    if (detailedTiming) {
      // @ref LLP 0020#performance-constraints - Detailed keyframe profiling
      // samples timing probes instead of calling `performance.now()` several
      // times for every surfel on device. Report scaled totals so the log still
      // identifies the hot phase without making detailed frames much slower.
      const depthTimingScale = timedDepthLookupSampleCount > 0
        ? depthLookupSampleCount / timedDepthLookupSampleCount
        : 1;
      const sampleTimingScale = timedSampleCount > 0
        ? profiledSampleCount / timedSampleCount
        : 1;
      profile.depthLookupMs = depthLookupMs * depthTimingScale;
      profile.unprojectMs = unprojectMs * sampleTimingScale;
      profile.normalEstimateMs = normalEstimateMs * sampleTimingScale;
      profile.colorSampleMs = colorSampleMs * sampleTimingScale;
      profile.sampleConsumeMs = sampleConsumeMs * sampleTimingScale;
      profile.profiledSampleCount = profiledSampleCount;
      profile.timedSampleCount = timedSampleCount;
      profile.timingSampleStride = timingSampleStride;
    }
    profile.sampleLoopMs = performanceNow() - sampleLoopStart;
    profile.appendTotalMs = performanceNow() - appendStart;
  }
  return { cameraColoredSurfels, newVoxelCount, surfelCount: added, updatedVoxelCount };
}

function countNewVoxelDepthSurfels(
  depthCache: DepthSampleGridCache,
  unprojector: ViewSampleUnprojector,
  cameraToWorldCache: CameraToWorldTransformCache,
  fusion: SurfelFusionAccumulator,
  existingSurfels: number,
  stopAtNewVoxels: number,
  stopAtSurfels = 0
): { newVoxelCount: number; surfelCount: number; updatedVoxelCount: number } {
  let newVoxelCount = 0;
  let surfelCount = 0;
  let updatedVoxelCount = 0;
  const minNewVoxels = Math.max(0, Math.floor(stopAtNewVoxels));
  const minSurfels = Math.max(0, Math.floor(stopAtSurfels));
  // @ref LLP 0020#performance-constraints - Same-sector contribution preflight
  // runs on redundant frames; reuse the accumulator's scratch key set instead
  // of allocating one per rejected XR frame.
  const candidateNewVoxelKeys = fusion.preflightVoxelKeysScratch;
  candidateNewVoxelKeys.clear();
  // @ref LLP 0020#performance-constraints - Redundant-frame preflight can run
  // many times between accepted keyframes, so keep transient vectors on the
  // accumulator instead of allocating them for every rejected frame.
  const cameraPoint = fusion.preflightCameraPointScratch;
  const world = fusion.preflightWorldScratch;
  for (let gy = 0; gy < SAMPLE_GRID_Y && surfelCount + existingSurfels < MAX_SURFELS; gy += 1) {
    for (let gx = 0; gx < SAMPLE_GRID_X && surfelCount + existingSurfels < MAX_SURFELS; gx += 1) {
      const depthMeters = sampleCachedGridDepthMeters(depthCache, gx, gy);
      if (!Number.isFinite(depthMeters) || depthMeters < MIN_DEPTH_M || depthMeters > MAX_DEPTH_M) {
        continue;
      }
      if (minNewVoxels > 0 && newVoxelCount >= minNewVoxels) {
        surfelCount += 1;
        if (surfelCount >= minSurfels) {
          candidateNewVoxelKeys.clear();
          return { newVoxelCount, surfelCount, updatedVoxelCount };
        }
        continue;
      }
      if (!sampleCachedGridCameraPointInto(cameraPoint, depthCache, unprojector, gx, gy, depthMeters)) {
        continue;
      }
      transformCameraPointToWorldInto(world, cameraToWorldCache, cameraPoint);
      const key = voxelKey(world[0], world[1], world[2]);
      if (fusion.voxels.has(key) || candidateNewVoxelKeys.has(key)) {
        updatedVoxelCount += 1;
      } else {
        candidateNewVoxelKeys.add(key);
        newVoxelCount += 1;
      }
      surfelCount += 1;
      if (newVoxelCount >= minNewVoxels && surfelCount >= minSurfels) {
        candidateNewVoxelKeys.clear();
        return { newVoxelCount, surfelCount, updatedVoxelCount };
      }
    }
  }
  candidateNewVoxelKeys.clear();
  return { newVoxelCount, surfelCount, updatedVoxelCount };
}

function isMatureDepthVoxel(voxel: SurfelVoxelAccumulator | undefined): boolean {
  return Boolean(
    voxel &&
    voxel.count >= MATURE_DEPTH_VOXEL_SKIP_MIN_OBSERVATIONS &&
    voxel.cameraWeight > 0 &&
    voxel.normalWeight > 0
  );
}

function meshTriangleCentroidInto(
  out: Vec3,
  vertices: Float32Array,
  i0: number,
  i1: number,
  i2: number
): boolean {
  if (i0 < 0 || i1 < 0 || i2 < 0 || i0 + 2 >= vertices.length || i1 + 2 >= vertices.length || i2 + 2 >= vertices.length) {
    return false;
  }
  const x = ((vertices[i0] ?? 0) + (vertices[i1] ?? 0) + (vertices[i2] ?? 0)) / 3;
  const y = ((vertices[i0 + 1] ?? 0) + (vertices[i1 + 1] ?? 0) + (vertices[i2 + 1] ?? 0)) / 3;
  const z = ((vertices[i0 + 2] ?? 0) + (vertices[i1 + 2] ?? 0) + (vertices[i2 + 2] ?? 0)) / 3;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return false;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return true;
}

function meshTriangleNormalInto(
  out: Vec3,
  vertices: Float32Array,
  normals: Float32Array | null,
  i0: number,
  i1: number,
  i2: number,
  triangleOrdinal: number,
  vertexCount: number,
  triangleCount: number
): boolean {
  if (i0 < 0 || i1 < 0 || i2 < 0 || i0 + 2 >= vertices.length || i1 + 2 >= vertices.length || i2 + 2 >= vertices.length) {
    return false;
  }
  if (normals) {
    const normalCount = Math.floor(normals.length / 3);
    // @ref LLP 0020#v2-arkit-mesh-snapshot - ARKit `ARMeshGeometry.normals`
    // describes outside-facing normals for faces, while some WebXR-shaped
    // mesh test doubles use vertex normals. Select the indexing mode from the
    // buffer shape instead of assuming native normals share vertex indices.
    if (normalCount === triangleCount && triangleOrdinal >= 0 && triangleOrdinal < triangleCount) {
      const normalOffset = triangleOrdinal * 3;
      out[0] = normals[normalOffset] ?? 0;
      out[1] = normals[normalOffset + 1] ?? 0;
      out[2] = normals[normalOffset + 2] ?? 0;
      if (normalizeFiniteVectorInto(out, out)) {
        return true;
      }
    } else if (
      normalCount === vertexCount &&
      i0 + 2 < normals.length &&
      i1 + 2 < normals.length &&
      i2 + 2 < normals.length
    ) {
      out[0] = ((normals[i0] ?? 0) + (normals[i1] ?? 0) + (normals[i2] ?? 0)) / 3;
      out[1] = ((normals[i0 + 1] ?? 0) + (normals[i1 + 1] ?? 0) + (normals[i2 + 1] ?? 0)) / 3;
      out[2] = ((normals[i0 + 2] ?? 0) + (normals[i1 + 2] ?? 0) + (normals[i2 + 2] ?? 0)) / 3;
      if (normalizeFiniteVectorInto(out, out)) {
        return true;
      }
    }
  }
  const ax = (vertices[i1] ?? 0) - (vertices[i0] ?? 0);
  const ay = (vertices[i1 + 1] ?? 0) - (vertices[i0 + 1] ?? 0);
  const az = (vertices[i1 + 2] ?? 0) - (vertices[i0 + 2] ?? 0);
  const bx = (vertices[i2] ?? 0) - (vertices[i0] ?? 0);
  const by = (vertices[i2 + 1] ?? 0) - (vertices[i0 + 1] ?? 0);
  const bz = (vertices[i2 + 2] ?? 0) - (vertices[i0 + 2] ?? 0);
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  const lengthSq = out[0] * out[0] + out[1] * out[1] + out[2] * out[2];
  if (!Number.isFinite(lengthSq) || lengthSq <= 1e-12) {
    return false;
  }
  normalizeInto(out, out);
  return true;
}

function appendMeshSurfel(
  fusion: SurfelFusionAccumulator,
  world: Vec3,
  normal: Vec3,
  colorScratch: Vec3,
  viewScratch: Vec3,
  cameraPosition: Vec3,
  getCameraSampler: (() => CameraColorSampler | null) | null,
  projectionMatrix: Float32Array,
  worldToCamera: Float32Array | null
): { appended: boolean; cameraColored: boolean; createdVoxel: boolean; planeProjected: boolean; projected: boolean } {
  const projected = Boolean(
    worldToCamera &&
    projectWorldPointToViewInto(viewScratch, worldToCamera, projectionMatrix, world)
  );
  const fallbackDepthMeters = projected ? viewScratch[2] : distanceBetween(world, cameraPosition);
  if (!isAcceptedMeshSurfelDepth(fallbackDepthMeters)) {
    return { appended: false, cameraColored: false, createdVoxel: false, planeProjected: false, projected: false };
  }
  const toCameraX = cameraPosition[0] - world[0];
  const toCameraY = cameraPosition[1] - world[1];
  const toCameraZ = cameraPosition[2] - world[2];
  const toCameraLength = Math.max(Math.hypot(toCameraX, toCameraY, toCameraZ), 1e-6);
  const invToCameraLength = 1 / toCameraLength;
  if (
    normal[0] * toCameraX +
    normal[1] * toCameraY +
    normal[2] * toCameraZ < 0
  ) {
    normal[0] *= -1;
    normal[1] *= -1;
    normal[2] *= -1;
  }
  const viewAlignment = clamp(
    (normal[0] * toCameraX + normal[1] * toCameraY + normal[2] * toCameraZ) * invToCameraLength,
    0,
    1
  );
  let hasCameraColor = false;
  if (projected && getCameraSampler) {
    const cameraSampler = getCameraSampler();
    hasCameraColor = cameraSampler
      ? sampleCameraColorWithSamplerInto(colorScratch, cameraSampler, viewScratch[0], viewScratch[1])
      : false;
  }
  if (!hasCameraColor) {
    depthPaletteInto(colorScratch, fallbackDepthMeters);
  }
  // @ref LLP 0020#v2-arkit-mesh-snapshot - Mesh triangles arrive through
  // WebXR `XRFrame.detectedMeshes`. Their anchor-local coordinates are already
  // geometry in `meshSpace`, so offscreen triangles can still improve the
  // captured scene shape; projection is needed only for current camera color.
  const appendResult = appendSurfelToFusion(
    fusion,
    world[0],
    world[1],
    world[2],
    1.05,
    colorScratch[0],
    colorScratch[1],
    colorScratch[2],
    surfelSampleWeight(fallbackDepthMeters, 1, viewAlignment) * (hasCameraColor ? 1.2 : -1.2),
    normal[0],
    normal[1],
    normal[2],
    1
  );
  return {
    appended: true,
    cameraColored: hasCameraColor,
    createdVoxel: Boolean(appendResult & APPEND_SURFEL_CREATED_VOXEL),
    planeProjected: Boolean(appendResult & APPEND_SURFEL_PLANE_PROJECTED),
    projected,
  };
}

function distanceBetween(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function isAcceptedMeshSurfelDepth(depthMeters: number): boolean {
  return Number.isFinite(depthMeters) && depthMeters >= MIN_DEPTH_M && depthMeters <= MAX_DEPTH_M;
}

function countMeshPreflightVoxel(
  result: MeshSurfelPreflightResult,
  candidateNewVoxelKeys: Set<SurfelVoxelKey>,
  fusion: SurfelFusionAccumulator,
  world: Vec3,
  projected: boolean
): void {
  const key = voxelKey(world[0], world[1], world[2]);
  if (fusion.voxels.has(key) || candidateNewVoxelKeys.has(key)) {
    result.updatedVoxelCount += 1;
  } else {
    candidateNewVoxelKeys.add(key);
    result.newVoxelCount += 1;
  }
  if (projected) {
    result.projectedSurfels += 1;
  }
  result.surfelCount += 1;
}

function projectWorldPointToViewInto(
  out: Vec3,
  worldToCamera: Float32Array,
  projectionMatrix: Float32Array,
  world: Vec3
): boolean {
  const cameraX =
    worldToCamera[0] * world[0] +
    worldToCamera[4] * world[1] +
    worldToCamera[8] * world[2] +
    worldToCamera[12];
  const cameraY =
    worldToCamera[1] * world[0] +
    worldToCamera[5] * world[1] +
    worldToCamera[9] * world[2] +
    worldToCamera[13];
  const cameraZ =
    worldToCamera[2] * world[0] +
    worldToCamera[6] * world[1] +
    worldToCamera[10] * world[2] +
    worldToCamera[14];
  const depthMeters = -cameraZ;
  if (!Number.isFinite(depthMeters) || depthMeters < MIN_DEPTH_M || depthMeters > MAX_DEPTH_M) {
    return false;
  }
  const clipX =
    projectionMatrix[0] * cameraX +
    projectionMatrix[4] * cameraY +
    projectionMatrix[8] * cameraZ +
    projectionMatrix[12];
  const clipY =
    projectionMatrix[1] * cameraX +
    projectionMatrix[5] * cameraY +
    projectionMatrix[9] * cameraZ +
    projectionMatrix[13];
  const clipW =
    projectionMatrix[3] * cameraX +
    projectionMatrix[7] * cameraY +
    projectionMatrix[11] * cameraZ +
    projectionMatrix[15];
  if (!Number.isFinite(clipX) || !Number.isFinite(clipY) || !Number.isFinite(clipW) || clipW <= 1e-6) {
    return false;
  }
  const ndcX = clipX / clipW;
  const ndcY = clipY / clipW;
  if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
    return false;
  }
  out[0] = (ndcX + 1) / 2;
  out[1] = (1 - ndcY) / 2;
  out[2] = depthMeters;
  return true;
}

function resolveCameraImage(camera: PanoramicCameraImageSource): PanoramicCameraImage | null {
  return typeof camera === 'function' ? camera() : camera;
}

function sampleGridOffsetForPhase(samplePhase: number, stride: number): number {
  const phase = Math.max(0, Math.floor(Number.isFinite(samplePhase) ? samplePhase : 0));
  const offset = positiveModulo(0.5 + phase * stride, 1);
  return 0.18 + offset * 0.64;
}

function countValidDepthSurfels(
  depthCache: DepthSampleGridCache,
  existingSurfels: number,
  stopAt: number
): number {
  let count = 0;
  for (let gy = 0; gy < SAMPLE_GRID_Y && count + existingSurfels < MAX_SURFELS; gy += 1) {
    for (
      let gx = 0;
      gx < SAMPLE_GRID_X && count + existingSurfels < MAX_SURFELS && count < stopAt;
      gx += 1
    ) {
      const depthMeters = sampleCachedGridDepthMeters(depthCache, gx, gy);
      if (Number.isFinite(depthMeters) && depthMeters >= MIN_DEPTH_M && depthMeters <= MAX_DEPTH_M) {
        count += 1;
      }
    }
    if (count >= stopAt) break;
  }
  return count;
}

function createDepthSampleGridCache(
  values: Float32Array,
  depth: PanoramicDepthInformation,
  depthTransform: Float32Array,
  depthTransformMode: NormalizedDepthTransformMode,
  unprojector: ViewSampleUnprojector,
  sampleOffsetX: number,
  sampleOffsetY: number,
  scratch: DepthSampleGridScratch | null = null
): DepthSampleGridCache {
  const gridSize = SAMPLE_GRID_X * SAMPLE_GRID_Y;
  const cameraPointSampled = scratch?.cameraPointSampled.length === gridSize
    ? scratch.cameraPointSampled
    : new Uint8Array(gridSize);
  const cameraPointScaleXs = scratch?.cameraPointScaleXs.length === SAMPLE_GRID_X
    ? scratch.cameraPointScaleXs
    : new Float32Array(SAMPLE_GRID_X);
  const cameraPointScaleYs = scratch?.cameraPointScaleYs.length === SAMPLE_GRID_Y
    ? scratch.cameraPointScaleYs
    : new Float32Array(SAMPLE_GRID_Y);
  const cameraPointXs = scratch?.cameraPointXs.length === gridSize
    ? scratch.cameraPointXs
    : new Float32Array(gridSize);
  const cameraPointYs = scratch?.cameraPointYs.length === gridSize
    ? scratch.cameraPointYs
    : new Float32Array(gridSize);
  const cameraPointZs = scratch?.cameraPointZs.length === gridSize
    ? scratch.cameraPointZs
    : new Float32Array(gridSize);
  const cameraWX0s = scratch?.cameraWX0s.length === SAMPLE_GRID_X
    ? scratch.cameraWX0s
    : new Float32Array(SAMPLE_GRID_X);
  const cameraWX1s = scratch?.cameraWX1s.length === SAMPLE_GRID_X
    ? scratch.cameraWX1s
    : new Float32Array(SAMPLE_GRID_X);
  const cameraWY0s = scratch?.cameraWY0s.length === SAMPLE_GRID_Y
    ? scratch.cameraWY0s
    : new Float32Array(SAMPLE_GRID_Y);
  const cameraWY1s = scratch?.cameraWY1s.length === SAMPLE_GRID_Y
    ? scratch.cameraWY1s
    : new Float32Array(SAMPLE_GRID_Y);
  const cameraX0s = scratch?.cameraX0s.length === SAMPLE_GRID_X
    ? scratch.cameraX0s
    : new Int32Array(SAMPLE_GRID_X);
  const cameraX1s = scratch?.cameraX1s.length === SAMPLE_GRID_X
    ? scratch.cameraX1s
    : new Int32Array(SAMPLE_GRID_X);
  const cameraXValid = scratch?.cameraXValid.length === SAMPLE_GRID_X
    ? scratch.cameraXValid
    : new Uint8Array(SAMPLE_GRID_X);
  const cameraY0s = scratch?.cameraY0s.length === SAMPLE_GRID_Y
    ? scratch.cameraY0s
    : new Int32Array(SAMPLE_GRID_Y);
  const cameraY1s = scratch?.cameraY1s.length === SAMPLE_GRID_Y
    ? scratch.cameraY1s
    : new Int32Array(SAMPLE_GRID_Y);
  const cameraYValid = scratch?.cameraYValid.length === SAMPLE_GRID_Y
    ? scratch.cameraYValid
    : new Uint8Array(SAMPLE_GRID_Y);
  const depthMeters = scratch?.depthMeters.length === gridSize
    ? scratch.depthMeters
    : new Float32Array(gridSize);
  const depthWX0s = scratch?.depthWX0s.length === SAMPLE_GRID_X
    ? scratch.depthWX0s
    : new Float32Array(SAMPLE_GRID_X);
  const depthWX1s = scratch?.depthWX1s.length === SAMPLE_GRID_X
    ? scratch.depthWX1s
    : new Float32Array(SAMPLE_GRID_X);
  const depthWY0s = scratch?.depthWY0s.length === SAMPLE_GRID_Y
    ? scratch.depthWY0s
    : new Float32Array(SAMPLE_GRID_Y);
  const depthWY1s = scratch?.depthWY1s.length === SAMPLE_GRID_Y
    ? scratch.depthWY1s
    : new Float32Array(SAMPLE_GRID_Y);
  const depthX0s = scratch?.depthX0s.length === SAMPLE_GRID_X
    ? scratch.depthX0s
    : new Int32Array(SAMPLE_GRID_X);
  const depthX1s = scratch?.depthX1s.length === SAMPLE_GRID_X
    ? scratch.depthX1s
    : new Int32Array(SAMPLE_GRID_X);
  const depthY0s = scratch?.depthY0s.length === SAMPLE_GRID_Y
    ? scratch.depthY0s
    : new Int32Array(SAMPLE_GRID_Y);
  const depthY1s = scratch?.depthY1s.length === SAMPLE_GRID_Y
    ? scratch.depthY1s
    : new Int32Array(SAMPLE_GRID_Y);
  const normalNeighborGXs = scratch?.normalNeighborGXs?.length === SAMPLE_GRID_X
    ? scratch.normalNeighborGXs
    : new Int32Array(SAMPLE_GRID_X);
  const normalNeighborGYs = scratch?.normalNeighborGYs?.length === SAMPLE_GRID_Y
    ? scratch.normalNeighborGYs
    : new Int32Array(SAMPLE_GRID_Y);
  const normalXSigns = scratch?.normalXSigns?.length === SAMPLE_GRID_X
    ? scratch.normalXSigns
    : new Int8Array(SAMPLE_GRID_X);
  const normalYSigns = scratch?.normalYSigns?.length === SAMPLE_GRID_Y
    ? scratch.normalYSigns
    : new Int8Array(SAMPLE_GRID_Y);
  const sampled = scratch?.sampled.length === gridSize
    ? scratch.sampled
    : new Uint8Array(gridSize);
  const viewXs = scratch?.viewXs.length === SAMPLE_GRID_X
    ? scratch.viewXs
    : new Float32Array(SAMPLE_GRID_X);
  const viewYs = scratch?.viewYs.length === SAMPLE_GRID_Y
    ? scratch.viewYs
    : new Float32Array(SAMPLE_GRID_Y);
  cameraPointSampled.fill(0);
  sampled.fill(0);
  for (let gx = 0; gx < SAMPLE_GRID_X; gx += 1) {
    viewXs[gx] = (gx + sampleOffsetX) / SAMPLE_GRID_X;
  }
  for (let gy = 0; gy < SAMPLE_GRID_Y; gy += 1) {
    viewYs[gy] = (gy + sampleOffsetY) / SAMPLE_GRID_Y;
  }
  // @ref LLP 0020#performance-constraints - The sparse grid is fixed for an
  // accepted keyframe, so normal estimation can reuse precomputed neighbor
  // indices and forward/backward signs in the hot loop.
  precomputeNormalNeighborAxis(viewXs, SAMPLE_GRID_X, normalNeighborGXs, normalXSigns);
  precomputeNormalNeighborAxis(viewYs, SAMPLE_GRID_Y, normalNeighborGYs, normalYSigns);
  if (unprojector.mode === 'intrinsics-projection') {
    // @ref LLP 0020#performance-constraints - The native ARKit bridge exposes
    // intrinsics through a standard WebXR projection matrix. Precompute the
    // per-axis pinhole ray coefficients once per accepted keyframe so surfel
    // and normal-neighbor unprojection only multiplies by depth in the hot loop.
    precomputeIntrinsicsUnprojectionAxis(
      viewXs,
      cameraPointScaleXs,
      unprojector.offsetX,
      unprojector.scaleX,
      false
    );
    precomputeIntrinsicsUnprojectionAxis(
      viewYs,
      cameraPointScaleYs,
      unprojector.offsetY,
      unprojector.scaleY,
      true
    );
  }
  const depthGridSampleMode: DepthGridSampleMode = depthTransformMode === 'identity'
    ? 'precomputed-identity'
    : 'normalized-transform';
  if (depthGridSampleMode === 'precomputed-identity') {
    // @ref LLP 0020#performance-constraints - View-aligned WebXR depth buffers
    // can reuse per-axis bilinear pixel weights for every sparse grid lookup in
    // this accepted keyframe.
    precomputeDepthGridAxis(viewXs, depth.width, depthX0s, depthX1s, depthWX0s, depthWX1s);
    precomputeDepthGridAxis(viewYs, depth.height, depthY0s, depthY1s, depthWY0s, depthWY1s);
  }
  if (scratch) {
    scratch.cameraPointSampled = cameraPointSampled;
    scratch.cameraPointScaleXs = cameraPointScaleXs;
    scratch.cameraPointScaleYs = cameraPointScaleYs;
    scratch.cameraPointXs = cameraPointXs;
    scratch.cameraPointYs = cameraPointYs;
    scratch.cameraPointZs = cameraPointZs;
    scratch.cameraWX0s = cameraWX0s;
    scratch.cameraWX1s = cameraWX1s;
    scratch.cameraWY0s = cameraWY0s;
    scratch.cameraWY1s = cameraWY1s;
    scratch.cameraX0s = cameraX0s;
    scratch.cameraX1s = cameraX1s;
    scratch.cameraXValid = cameraXValid;
    scratch.cameraY0s = cameraY0s;
    scratch.cameraY1s = cameraY1s;
    scratch.cameraYValid = cameraYValid;
    scratch.depthMeters = depthMeters;
    scratch.depthWX0s = depthWX0s;
    scratch.depthWX1s = depthWX1s;
    scratch.depthWY0s = depthWY0s;
    scratch.depthWY1s = depthWY1s;
    scratch.depthX0s = depthX0s;
    scratch.depthX1s = depthX1s;
    scratch.depthY0s = depthY0s;
    scratch.depthY1s = depthY1s;
    scratch.normalNeighborGXs = normalNeighborGXs;
    scratch.normalNeighborGYs = normalNeighborGYs;
    scratch.normalXSigns = normalXSigns;
    scratch.normalYSigns = normalYSigns;
    scratch.sampled = sampled;
    scratch.viewXs = viewXs;
    scratch.viewYs = viewYs;
  }
  return {
    cameraPointCacheHits: 0,
    cameraPointSampled,
    cameraPointSampledCount: 0,
    cameraPointScaleXs,
    cameraPointScaleYs,
    cameraPointXs,
    cameraPointYs,
    cameraPointZs,
    cameraWX0s,
    cameraWX1s,
    cameraWY0s,
    cameraWY1s,
    cameraX0s,
    cameraX1s,
    cameraXValid,
    cameraY0s,
    cameraY1s,
    cameraYValid,
    depth,
    depthGridSampleMode,
    depthMeters,
    depthTransform,
    depthTransformMode,
    depthWX0s,
    depthWX1s,
    depthWY0s,
    depthWY1s,
    depthX0s,
    depthX1s,
    depthY0s,
    depthY1s,
    normalNeighborGXs,
    normalNeighborGYs,
    normalXSigns,
    normalYSigns,
    sampleOffsetX,
    sampleOffsetY,
    sampled,
    sampledCount: 0,
    values,
    viewXs,
    viewYs,
  };
}

function sampleCachedGridDepthMeters(cache: DepthSampleGridCache, gx: number, gy: number): number {
  if (gx < 0 || gx >= SAMPLE_GRID_X || gy < 0 || gy >= SAMPLE_GRID_Y) {
    return Number.NaN;
  }
  const index = gy * SAMPLE_GRID_X + gx;
  if (cache.sampled[index]) {
    return cache.depthMeters[index];
  }
  const depthMeters = cache.depthGridSampleMode === 'precomputed-identity'
    ? samplePrecomputedGridDepthMeters(cache, gx, gy)
    : sampleDepthMetersWithMode(
      cache.values,
      cache.depth,
      cache.depthTransform,
      cache.depthTransformMode,
      gridViewX(cache, gx),
      gridViewY(cache, gy)
    );
  cache.sampled[index] = 1;
  cache.depthMeters[index] = depthMeters;
  cache.sampledCount += 1;
  return depthMeters;
}

function precomputeDepthGridAxis(
  normalizedValues: Float32Array,
  size: number,
  lowerPixels: Int32Array,
  upperPixels: Int32Array,
  lowerWeights: Float32Array,
  upperWeights: Float32Array
): void {
  for (let i = 0; i < normalizedValues.length; i += 1) {
    const pixel = normalizedDepthCoordinateToPixel(normalizedValues[i], size);
    const lower = Number.isFinite(pixel) ? Math.floor(pixel) : 0;
    const upper = Math.min(Math.max(0, size - 1), lower + 1);
    const upperWeight = Number.isFinite(pixel) ? pixel - lower : 0;
    lowerPixels[i] = Math.min(Math.max(0, size - 1), lower);
    upperPixels[i] = upper;
    lowerWeights[i] = 1 - upperWeight;
    upperWeights[i] = upperWeight;
  }
}

function precomputeIntrinsicsUnprojectionAxis(
  normalizedValues: Float32Array,
  scales: Float32Array,
  offset: number,
  projectionScale: number,
  invert: boolean
): void {
  for (let i = 0; i < normalizedValues.length; i += 1) {
    const ndc = invert ? 1 - normalizedValues[i] * 2 : normalizedValues[i] * 2 - 1;
    scales[i] = (ndc + offset) * projectionScale;
  }
}

function precomputeNormalNeighborAxis(
  normalizedValues: Float32Array,
  sampleCount: number,
  neighborIndexes: Int32Array,
  signs: Int8Array
): void {
  const step = 1 / sampleCount;
  for (let i = 0; i < normalizedValues.length; i += 1) {
    const forward = normalizedValues[i] + step <= 0.98;
    neighborIndexes[i] = forward ? i + 1 : i - 1;
    signs[i] = forward ? 1 : -1;
  }
}

function samplePrecomputedGridDepthMeters(cache: DepthSampleGridCache, gx: number, gy: number): number {
  const x0 = cache.depthX0s[gx];
  const x1 = cache.depthX1s[gx];
  const y0 = cache.depthY0s[gy];
  const y1 = cache.depthY1s[gy];
  const wx0 = cache.depthWX0s[gx];
  const wx1 = cache.depthWX1s[gx];
  const wy0 = cache.depthWY0s[gy];
  const wy1 = cache.depthWY1s[gy];
  const row0 = y0 * cache.depth.width;
  const row1 = y1 * cache.depth.width;
  const meters = cache.depth.rawValueToMeters;
  const values = cache.values;
  return interpolateDepthMeters(
    values[row0 + x0] * meters, wx0 * wy0,
    values[row0 + x1] * meters, wx1 * wy0,
    values[row1 + x0] * meters, wx0 * wy1,
    values[row1 + x1] * meters, wx1 * wy1
  );
}

function sampleCachedGridCameraPointInto(
  out: Vec3,
  cache: DepthSampleGridCache,
  unprojector: ViewSampleUnprojector,
  gx: number,
  gy: number,
  knownDepthMeters?: number
): boolean {
  if (gx < 0 || gx >= SAMPLE_GRID_X || gy < 0 || gy >= SAMPLE_GRID_Y) {
    return false;
  }
  const index = gy * SAMPLE_GRID_X + gx;
  if (cache.cameraPointSampled[index]) {
    cache.cameraPointCacheHits += 1;
    const x = cache.cameraPointXs[index];
    const y = cache.cameraPointYs[index];
    const z = cache.cameraPointZs[index];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return false;
    }
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return true;
  }

  const depthMeters = knownDepthMeters ?? sampleCachedGridDepthMeters(cache, gx, gy);
  cache.cameraPointSampled[index] = 1;
  cache.cameraPointSampledCount += 1;
  if (!Number.isFinite(depthMeters) || depthMeters < MIN_DEPTH_M || depthMeters > MAX_DEPTH_M) {
    cache.cameraPointXs[index] = Number.NaN;
    cache.cameraPointYs[index] = Number.NaN;
    cache.cameraPointZs[index] = Number.NaN;
    return false;
  }

  // @ref LLP 0020#performance-constraints - The common native ARKit bridge
  // exposes intrinsics as a standard WebXR projection matrix. Keep cached
  // grid-point unprojection on that fast WebXR geometry path.
  if (unprojector.mode === 'intrinsics-projection') {
    out[0] = cache.cameraPointScaleXs[gx] * depthMeters;
    out[1] = cache.cameraPointScaleYs[gy] * depthMeters;
    out[2] = -depthMeters;
  } else {
    unprojectViewSampleInto(
      out,
      unprojector,
      gridViewX(cache, gx),
      gridViewY(cache, gy),
      depthMeters
    );
  }
  cache.cameraPointXs[index] = out[0];
  cache.cameraPointYs[index] = out[1];
  cache.cameraPointZs[index] = out[2];
  return true;
}

function gridViewX(cache: DepthSampleGridCache, gx: number): number {
  return cache.viewXs[gx];
}

function gridViewY(cache: DepthSampleGridCache, gy: number): number {
  return cache.viewYs[gy];
}

export function sampleDepthMeters(
  values: Float32Array,
  depth: PanoramicDepthInformation,
  normDepthBufferFromNormView: Float32Array,
  viewX: number,
  viewY: number
): number {
  return sampleDepthMetersWithMode(
    values,
    depth,
    normDepthBufferFromNormView,
    normalizedDepthTransformMode(normDepthBufferFromNormView),
    viewX,
    viewY
  );
}

function sampleDepthMetersWithMode(
  values: Float32Array,
  depth: PanoramicDepthInformation,
  normDepthBufferFromNormView: Float32Array,
  transformMode: NormalizedDepthTransformMode,
  viewX: number,
  viewY: number
): number {
  if (transformMode === 'identity') {
    return sampleDepthMetersAtNormalizedDepthPoint(values, depth, viewX, viewY);
  }
  const depthTx =
    normDepthBufferFromNormView[0] * viewX +
    normDepthBufferFromNormView[4] * viewY +
    normDepthBufferFromNormView[12];
  const depthTy =
    normDepthBufferFromNormView[1] * viewX +
    normDepthBufferFromNormView[5] * viewY +
    normDepthBufferFromNormView[13];
  if (transformMode === 'affine') {
    return sampleDepthMetersAtNormalizedDepthPoint(values, depth, depthTx, depthTy);
  }
  const depthTw =
    normDepthBufferFromNormView[3] * viewX +
    normDepthBufferFromNormView[7] * viewY +
    normDepthBufferFromNormView[15];
  const depthX = depthTw !== 0 && depthTw !== 1 ? depthTx / depthTw : depthTx;
  const depthY = depthTw !== 0 && depthTw !== 1 ? depthTy / depthTw : depthTy;
  return sampleDepthMetersAtNormalizedDepthPoint(values, depth, depthX, depthY);
}

function sampleDepthMetersAtNormalizedDepthPoint(
  values: Float32Array,
  depth: PanoramicDepthInformation,
  depthX: number,
  depthY: number
): number {
  if (!Number.isFinite(depthX) || !Number.isFinite(depthY)) return Number.NaN;
  if (depthX < 0 || depthX > 1 || depthY < 0 || depthY > 1) {
    return Number.NaN;
  }
  const pixelX = normalizedDepthCoordinateToPixel(depthX, depth.width);
  const pixelY = normalizedDepthCoordinateToPixel(depthY, depth.height);
  if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) return Number.NaN;
  const x0 = Math.floor(pixelX);
  const y0 = Math.floor(pixelY);
  const x1 = Math.min(depth.width - 1, x0 + 1);
  const y1 = Math.min(depth.height - 1, y0 + 1);
  const fx = pixelX - x0;
  const fy = pixelY - y0;

  // @ref LLP 0020#reconstruction-pipeline - Subpixel depth sampling is
  // edge-aware: interpolate continuous neighborhoods, but reject footprints
  // that cross invalid samples or likely foreground/background boundaries.
  return interpolateDepthMeters(
    rawDepthMeters(values, depth, x0, y0), (1 - fx) * (1 - fy),
    rawDepthMeters(values, depth, x1, y0), fx * (1 - fy),
    rawDepthMeters(values, depth, x0, y1), (1 - fx) * fy,
    rawDepthMeters(values, depth, x1, y1), fx * fy
  );
}

function normalizedDepthCoordinateToPixel(value: number, size: number): number {
  if (!Number.isFinite(value) || size <= 0) return Number.NaN;
  // @ref LLP 0020#reconstruction-pipeline - WebXR CPU depth coordinates treat
  // (column + 0.5) / width as the center of a depth pixel. Bilinear
  // reconstruction therefore samples in pixel-center space instead of shifting
  // every surfel footprint half a pixel down/right.
  return Math.min(Math.max(0, size - 1), Math.max(0, value * size - 0.5));
}

function normalizedDepthTransformMode(matrix: Float32Array): NormalizedDepthTransformMode {
  if (
    nearlyOne(matrix[0] ?? 0) &&
    nearlyOne(matrix[5] ?? 0) &&
    nearlyOne(matrix[10] ?? 0) &&
    nearlyOne(matrix[15] ?? 0) &&
    nearlyZero(matrix[1] ?? 0) &&
    nearlyZero(matrix[3] ?? 0) &&
    nearlyZero(matrix[4] ?? 0) &&
    nearlyZero(matrix[7] ?? 0) &&
    nearlyZero(matrix[12] ?? 0) &&
    nearlyZero(matrix[13] ?? 0)
  ) {
    // @ref LLP 0020#reconstruction-pipeline - Native scene-depth frames are
    // already view-aligned in the current WebXR profile. Keep that common path
    // out of the general projective transform math in the scan hot loop.
    return 'identity';
  }
  if (nearlyZero(matrix[3] ?? 0) && nearlyZero(matrix[7] ?? 0) && nearlyOne(matrix[15] ?? 0)) {
    return 'affine';
  }
  return 'projective';
}

function rawDepthMeters(
  values: Float32Array,
  depth: PanoramicDepthInformation,
  x: number,
  y: number
): number {
  return (values[y * depth.width + x] ?? 0) * depth.rawValueToMeters;
}

function interpolateDepthMeters(
  depth00: number,
  weight00: number,
  depth10: number,
  weight10: number,
  depth01: number,
  weight01: number,
  depth11: number,
  weight11: number
): number {
  let minDepth = Number.POSITIVE_INFINITY;
  let maxDepth = 0;
  let weightedDepth = 0;
  let totalWeight = 0;

  if (weight00 > 1e-6) {
    if (!Number.isFinite(depth00) || depth00 <= 0) return Number.NaN;
    minDepth = Math.min(minDepth, depth00);
    maxDepth = Math.max(maxDepth, depth00);
    weightedDepth += depth00 * weight00;
    totalWeight += weight00;
  }
  if (weight10 > 1e-6) {
    if (!Number.isFinite(depth10) || depth10 <= 0) return Number.NaN;
    minDepth = Math.min(minDepth, depth10);
    maxDepth = Math.max(maxDepth, depth10);
    weightedDepth += depth10 * weight10;
    totalWeight += weight10;
  }
  if (weight01 > 1e-6) {
    if (!Number.isFinite(depth01) || depth01 <= 0) return Number.NaN;
    minDepth = Math.min(minDepth, depth01);
    maxDepth = Math.max(maxDepth, depth01);
    weightedDepth += depth01 * weight01;
    totalWeight += weight01;
  }
  if (weight11 > 1e-6) {
    if (!Number.isFinite(depth11) || depth11 <= 0) return Number.NaN;
    minDepth = Math.min(minDepth, depth11);
    maxDepth = Math.max(maxDepth, depth11);
    weightedDepth += depth11 * weight11;
    totalWeight += weight11;
  }

  if (totalWeight <= 0) return Number.NaN;
  const discontinuityThreshold = Math.max(0.08, minDepth * 0.08);
  if (maxDepth - minDepth > discontinuityThreshold) {
    return Number.NaN;
  }
  return weightedDepth / totalWeight;
}

function estimateWorldNormalInto(
  out: Vec3,
  depthCache: DepthSampleGridCache,
  unprojector: ViewSampleUnprojector,
  cameraToWorld: CameraToWorldTransformCache,
  cameraPosition: Vec3,
  worldPoint: Vec3,
  gx: number,
  gy: number,
  depthMeters: number,
  cameraPoint: Vec3,
  scratch: SurfelSampleScratch
): number {
  observationFacingNormalInto(out, cameraToWorld, cameraPoint, scratch.pointToCamera);
  const neighborGX = depthCache.normalNeighborGXs[gx] ?? -1;
  const neighborGY = depthCache.normalNeighborGYs[gy] ?? -1;
  if (neighborGX < 0 || neighborGX >= SAMPLE_GRID_X || neighborGY < 0 || neighborGY >= SAMPLE_GRID_Y) {
    return 0.25;
  }
  const xSign = depthCache.normalXSigns[gx] || 1;
  const ySign = depthCache.normalYSigns[gy] || 1;

  const depthX = sampleCachedGridDepthMeters(depthCache, neighborGX, gy);
  const depthY = sampleCachedGridDepthMeters(depthCache, gx, neighborGY);
  const discontinuityThreshold = Math.max(0.1, depthMeters * 0.06);
  if (
    !isUsableNeighborDepth(depthX, depthMeters, discontinuityThreshold) ||
    !isUsableNeighborDepth(depthY, depthMeters, discontinuityThreshold)
  ) {
    return 0.25;
  }

  if (
    !sampleCachedGridCameraPointInto(scratch.cameraPointX, depthCache, unprojector, neighborGX, gy, depthX) ||
    !sampleCachedGridCameraPointInto(scratch.cameraPointY, depthCache, unprojector, gx, neighborGY, depthY)
  ) {
    return 0.25;
  }
  const cameraPointX = scratch.cameraPointX;
  const cameraPointY = scratch.cameraPointY;
  const vecXX = (cameraPointX[0] - cameraPoint[0]) * xSign;
  const vecXY = (cameraPointX[1] - cameraPoint[1]) * xSign;
  const vecXZ = (cameraPointX[2] - cameraPoint[2]) * xSign;
  const vecYX = (cameraPointY[0] - cameraPoint[0]) * ySign;
  const vecYY = (cameraPointY[1] - cameraPoint[1]) * ySign;
  const vecYZ = (cameraPointY[2] - cameraPoint[2]) * ySign;
  scratch.normalCamera[0] = vecYY * vecXZ - vecYZ * vecXY;
  scratch.normalCamera[1] = vecYZ * vecXX - vecYX * vecXZ;
  scratch.normalCamera[2] = vecYX * vecXY - vecYY * vecXX;
  const normalCameraLengthSq =
    scratch.normalCamera[0] * scratch.normalCamera[0] +
    scratch.normalCamera[1] * scratch.normalCamera[1] +
    scratch.normalCamera[2] * scratch.normalCamera[2];
  if (normalCameraLengthSq <= 1e-10) {
    return 0.25;
  }
  const invNormalCameraLength = 1 / Math.sqrt(normalCameraLengthSq);
  scratch.normalCamera[0] *= invNormalCameraLength;
  scratch.normalCamera[1] *= invNormalCameraLength;
  scratch.normalCamera[2] *= invNormalCameraLength;
  // @ref LLP 0020#webxr-depth-geometry-unprojection - XRView.transform is a
  // rigid camera-to-world transform, so a unit camera normal stays unit after
  // rotation. Re-normalize only if a non-rigid test matrix slips through.
  transformCameraDirectionToWorldInto(out, cameraToWorld, scratch.normalCamera);
  const worldNormalLengthSq = out[0] * out[0] + out[1] * out[1] + out[2] * out[2];
  if (Math.abs(worldNormalLengthSq - 1) > 1e-3) {
    normalizeInto(out, out);
  }
  if (
    out[0] * (cameraPosition[0] - worldPoint[0]) +
    out[1] * (cameraPosition[1] - worldPoint[1]) +
    out[2] * (cameraPosition[2] - worldPoint[2]) < 0
  ) {
    out[0] *= -1;
    out[1] *= -1;
    out[2] *= -1;
  }
  return 1;
}

function isUsableNeighborDepth(depthMeters: number, centerDepthMeters: number, threshold: number): boolean {
  return Number.isFinite(depthMeters) &&
    depthMeters >= MIN_DEPTH_M &&
    depthMeters <= MAX_DEPTH_M &&
    Math.abs(depthMeters - centerDepthMeters) <= threshold;
}

export function surfelSampleWeight(
  depthMeters: number,
  normalConfidence = 1,
  surfaceViewAlignment = 1
): number {
  // Distant ARKit depth samples cover more world area and tend to be noisier;
  // keep them useful for coverage without letting them dominate fused voxels.
  const depthWeight = clamp(1.35 / Math.max(depthMeters * depthMeters, 0.5), 0.14, 1.8);
  // @ref LLP 0020#reconstruction-pipeline - Samples whose local depth
  // neighborhood could not support an estimated normal are less reliable for
  // fusion, but still useful for sparse coverage.
  const qualityWeight = 0.45 + 0.55 * clamp(normalConfidence, 0, 1);
  // @ref LLP 0020#reconstruction-pipeline - Grazing-angle observations are more
  // sensitive to small depth or pose errors, so they should contribute less to a
  // fused voxel than near-fronto-parallel observations.
  const incidenceWeight = 0.35 + 0.65 * smoothstep(0.2, 0.85, clamp(surfaceViewAlignment, 0, 1));
  return depthWeight * qualityWeight * incidenceWeight;
}

// @ref LLP 0020#reconstruction-pipeline - Repeated observations of the same
// world-space cell are fused into one weighted surfel instead of appended as
// duplicate points.
export function fuseSurfels(points: number[]): SurfelVoxelAccumulator[] {
  const fusion = createSurfelFusionAccumulator();
  appendSurfelsToFusion(fusion, points);
  return [...fusion.voxels.values()];
}

export function createSurfelFusionAccumulator(): SurfelFusionAccumulator {
  return {
    depthGridScratch: null,
    modelSurfelsScratch: null,
    preflightCameraPointScratch: [0, 0, 0],
    preflightVoxelKeysScratch: new Set(),
    preflightWorldScratch: [0, 0, 0],
    rawSampleCount: 0,
    voxels: new Map<SurfelVoxelKey, SurfelVoxelAccumulator>(),
  };
}

export function appendSurfelsToFusion(fusion: SurfelFusionAccumulator, points: number[]): void {
  for (let i = 0; i + SURFEL_STRIDE_FLOATS <= points.length; i += SURFEL_STRIDE_FLOATS) {
    appendSurfelToFusion(
      fusion,
      points[i] ?? 0,
      points[i + 1] ?? 0,
      points[i + 2] ?? 0,
      points[i + 3] ?? 1,
      points[i + 4] ?? 0,
      points[i + 5] ?? 0,
      points[i + 6] ?? 0,
      points[i + 7] ?? 1,
      points[i + 8] ?? 0,
      points[i + 9] ?? 0,
      points[i + 10] ?? 0,
      points[i + 11] ?? 0
    );
  }
}

function appendSurfelToFusion(
  fusion: SurfelFusionAccumulator,
  x: number,
  y: number,
  z: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  rawWeight: number,
  nx: number,
  ny: number,
  nz: number,
  normalConfidence: number
): number {
  fusion.rawSampleCount += 1;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0;
  const key = voxelKey(x, y, z);
  return appendFiniteSurfelToFusion(
    fusion,
    key,
    fusion.voxels.get(key),
    x,
    y,
    z,
    radius,
    r,
    g,
    b,
    rawWeight,
    nx,
    ny,
    nz,
    normalConfidence
  );
}

function appendSurfelToFusionWithKnownVoxel(
  fusion: SurfelFusionAccumulator,
  key: SurfelVoxelKey,
  voxel: SurfelVoxelAccumulator | undefined,
  x: number,
  y: number,
  z: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  rawWeight: number,
  nx: number,
  ny: number,
  nz: number,
  normalConfidence: number
): number {
  fusion.rawSampleCount += 1;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0;
  return appendFiniteSurfelToFusion(
    fusion,
    key,
    voxel,
    x,
    y,
    z,
    radius,
    r,
    g,
    b,
    rawWeight,
    nx,
    ny,
    nz,
    normalConfidence
  );
}

function appendFiniteSurfelToFusion(
  fusion: SurfelFusionAccumulator,
  key: SurfelVoxelKey,
  voxel: SurfelVoxelAccumulator | undefined,
  x: number,
  y: number,
  z: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  rawWeight: number,
  nx: number,
  ny: number,
  nz: number,
  normalConfidence: number
): number {
  const weight = Math.max(Math.abs(rawWeight), 1e-4);
  const createdVoxel = !voxel;
  if (!voxel) {
    voxel = {
      cameraB: 0,
      cameraG: 0,
      cameraR: 0,
      cameraWeight: 0,
      count: 0,
      fallbackB: 0,
      fallbackG: 0,
      fallbackR: 0,
      fallbackWeight: 0,
      normalEstimatedWeight: 0,
      normalWeight: 0,
      nx: 0,
      ny: 0,
      nz: 0,
      radius: 0,
      weight: 0,
      x: 0,
      y: 0,
      z: 0,
    };
    fusion.voxels.set(key, voxel);
  }
  let fusedX = x;
  let fusedY = y;
  let fusedZ = z;
  let planeProjected = false;
  if (voxel.weight > 0 && voxel.normalWeight > 0 && voxel.normalEstimatedWeight > 0 && normalConfidence > 0.5) {
    // @ref LLP 0020#reconstruction-pipeline — Same-voxel observations with
    // agreeing reliable normals should not pull a flat surface along the depth
    // noise axis; project them onto the accumulated local surfel plane first.
    const centerX = voxel.x / voxel.weight;
    const centerY = voxel.y / voxel.weight;
    const centerZ = voxel.z / voxel.weight;
    let planeNormalX = voxel.nx / voxel.normalWeight;
    let planeNormalY = voxel.ny / voxel.normalWeight;
    let planeNormalZ = voxel.nz / voxel.normalWeight;
    const planeNormalLengthSq =
      planeNormalX * planeNormalX +
      planeNormalY * planeNormalY +
      planeNormalZ * planeNormalZ;
    const sampleNormalLengthSq = nx * nx + ny * ny + nz * nz;
    if (planeNormalLengthSq > 1e-8 && sampleNormalLengthSq > 1e-8) {
      const invPlaneNormalLength = 1 / Math.sqrt(planeNormalLengthSq);
      const invSampleNormalLength = 1 / Math.sqrt(sampleNormalLengthSq);
      planeNormalX *= invPlaneNormalLength;
      planeNormalY *= invPlaneNormalLength;
      planeNormalZ *= invPlaneNormalLength;
      const normalAgreement = Math.abs(
        (planeNormalX * nx + planeNormalY * ny + planeNormalZ * nz) *
        invSampleNormalLength
      );
      const planeDistance =
        (x - centerX) * planeNormalX +
        (y - centerY) * planeNormalY +
        (z - centerZ) * planeNormalZ;
      if (normalAgreement >= 0.65 && Math.abs(planeDistance) <= VOXEL_SIZE_M * 1.5) {
        fusedX = x - planeDistance * planeNormalX;
        fusedY = y - planeDistance * planeNormalY;
        fusedZ = z - planeDistance * planeNormalZ;
        planeProjected = true;
      }
    }
  }
  voxel.x += fusedX * weight;
  voxel.y += fusedY * weight;
  voxel.z += fusedZ * weight;
  voxel.radius += radius * weight;
  voxel.weight += weight;
  voxel.count += 1;
  const clampedNormalConfidence = normalConfidence <= 0 ? 0 : normalConfidence >= 1 ? 1 : normalConfidence;
  const normalWeight = weight * clampedNormalConfidence;
  voxel.nx += nx * normalWeight;
  voxel.ny += ny * normalWeight;
  voxel.nz += nz * normalWeight;
  voxel.normalWeight += normalWeight;
  if (clampedNormalConfidence >= 1) {
    voxel.normalEstimatedWeight += normalWeight;
  }
  const weightedR = r * weight;
  const weightedG = g * weight;
  const weightedB = b * weight;
  if (rawWeight > 0) {
    voxel.cameraR += weightedR;
    voxel.cameraG += weightedG;
    voxel.cameraB += weightedB;
    voxel.cameraWeight += weight;
  } else {
    voxel.fallbackR += weightedR;
    voxel.fallbackG += weightedG;
    voxel.fallbackB += weightedB;
    voxel.fallbackWeight += weight;
  }
  return (createdVoxel ? APPEND_SURFEL_CREATED_VOXEL : 0) |
    (planeProjected ? APPEND_SURFEL_PLANE_PROJECTED : 0);
}

function voxelKey(x: number, y: number, z: number): SurfelVoxelKey {
  const ix = Math.floor(x * INV_VOXEL_SIZE_M);
  const iy = Math.floor(y * INV_VOXEL_SIZE_M);
  const iz = Math.floor(z * INV_VOXEL_SIZE_M);
  if (
    ix >= -VOXEL_KEY_AXIS_OFFSET && ix < VOXEL_KEY_AXIS_OFFSET &&
    iy >= -VOXEL_KEY_AXIS_OFFSET && iy < VOXEL_KEY_AXIS_OFFSET &&
    iz >= -VOXEL_KEY_AXIS_OFFSET && iz < VOXEL_KEY_AXIS_OFFSET
  ) {
    // @ref LLP 0020#performance-constraints - Typical room-scale scans fit
    // inside this packed-key range, avoiding a string allocation per sample on
    // the WebXR frame path while preserving exact voxel identity.
    return (
      (ix + VOXEL_KEY_AXIS_OFFSET) * VOXEL_KEY_AXIS_SIZE * VOXEL_KEY_AXIS_SIZE +
      (iy + VOXEL_KEY_AXIS_OFFSET) * VOXEL_KEY_AXIS_SIZE +
      (iz + VOXEL_KEY_AXIS_OFFSET)
    );
  }
  return `${ix},${iy},${iz}`;
}

export function buildModel(points: number[], keyframes: number): CaptureModel | null {
  const fusion = createSurfelFusionAccumulator();
  appendSurfelsToFusion(fusion, points);
  return buildModelFromFusion(fusion, keyframes);
}

export function canReusePanoramicModelSnapshot(
  model: CaptureModel | null,
  fusion: SurfelFusionAccumulator,
  keyframes: number
): model is CaptureModel {
  return model !== null &&
    model.keyframes === keyframes &&
    model.rawSampleCount === fusion.rawSampleCount &&
    model.surfelCount === fusion.voxels.size;
}

export function buildModelFromFusion(fusion: SurfelFusionAccumulator, keyframes: number): CaptureModel | null {
  const buildStart = performanceNow();
  const rawSampleCount = fusion.rawSampleCount;
  if (rawSampleCount <= 0) return null;
  const surfelCount = fusion.voxels.size;
  if (surfelCount <= 0) return null;
  const requiredFloats = surfelCount * SURFEL_STRIDE_FLOATS;
  // @ref LLP 0020#performance-constraints - Live preview repeatedly
  // materializes the same growing fusion map; retain CPU backing storage and
  // return exact-length views to reduce GC churn without changing GPU upload
  // size or app-facing model layout.
  if (!fusion.modelSurfelsScratch || fusion.modelSurfelsScratch.length < requiredFloats) {
    const capacityBytes = nextSurfelBufferCapacityBytes(requiredFloats * Float32Array.BYTES_PER_ELEMENT);
    fusion.modelSurfelsScratch = new Float32Array(capacityBytes / Float32Array.BYTES_PER_ELEMENT);
  }
  const surfels = fusion.modelSurfelsScratch.subarray(0, requiredFloats);
  const boundsMin: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const boundsMax: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let fusedCameraColoredSurfels = 0;
  let multiObservedSurfels = 0;
  let normalEstimatedSurfels = 0;
  // @ref LLP 0020#model-view - Partial 180-degree scans frame around the
  // weighted surface cluster rather than the bounds midpoint.
  let centerWeight = 0;
  const center: Vec3 = [0, 0, 0];
  let index = 0;
  for (const voxel of fusion.voxels.values()) {
    const invWeight = 1 / Math.max(voxel.weight, 1e-6);
    const x = voxel.x * invWeight;
    const y = voxel.y * invWeight;
    const z = voxel.z * invWeight;
    const radius = clamp(voxel.radius * invWeight, 0.45, 2.6);
    let normalX = 0;
    let normalY = 1;
    let normalZ = 0;
    if (voxel.normalWeight > 0) {
      normalX = voxel.nx / voxel.normalWeight;
      normalY = voxel.ny / voxel.normalWeight;
      normalZ = voxel.nz / voxel.normalWeight;
      const normalLength = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
      if (normalLength > 1e-6) {
        normalX /= normalLength;
        normalY /= normalLength;
        normalZ /= normalLength;
      } else {
        normalX = 0;
        normalY = 0;
        normalZ = 1;
      }
    }
    const hasCameraColor = voxel.cameraWeight > 0;
    const colorWeight = hasCameraColor ? voxel.cameraWeight : Math.max(voxel.fallbackWeight, 1e-6);
    const offset = index * SURFEL_STRIDE_FLOATS;
    surfels[offset] = x;
    surfels[offset + 1] = y;
    surfels[offset + 2] = z;
    surfels[offset + 3] = radius;
    surfels[offset + 4] = hasCameraColor ? voxel.cameraR / colorWeight : voxel.fallbackR / colorWeight;
    surfels[offset + 5] = hasCameraColor ? voxel.cameraG / colorWeight : voxel.fallbackG / colorWeight;
    surfels[offset + 6] = hasCameraColor ? voxel.cameraB / colorWeight : voxel.fallbackB / colorWeight;
    surfels[offset + 7] = voxel.weight;
    surfels[offset + 8] = normalX;
    surfels[offset + 9] = normalY;
    surfels[offset + 10] = normalZ;
    surfels[offset + 11] = voxel.count;
    if (hasCameraColor) fusedCameraColoredSurfels += 1;
    if (voxel.count > 1) multiObservedSurfels += 1;
    if (voxel.normalEstimatedWeight > 0) normalEstimatedSurfels += 1;
    boundsMin[0] = Math.min(boundsMin[0], x);
    boundsMin[1] = Math.min(boundsMin[1], y);
    boundsMin[2] = Math.min(boundsMin[2], z);
    boundsMax[0] = Math.max(boundsMax[0], x);
    boundsMax[1] = Math.max(boundsMax[1], y);
    boundsMax[2] = Math.max(boundsMax[2], z);
    const weight = Math.max(voxel.weight, 1e-6);
    center[0] += x * weight;
    center[1] += y * weight;
    center[2] += z * weight;
    centerWeight += weight;
    index += 1;
  }
  if (centerWeight > 0) {
    const invCenterWeight = 1 / centerWeight;
    center[0] *= invCenterWeight;
    center[1] *= invCenterWeight;
    center[2] *= invCenterWeight;
  } else {
    center[0] = (boundsMin[0] + boundsMax[0]) / 2;
    center[1] = (boundsMin[1] + boundsMax[1]) / 2;
    center[2] = (boundsMin[2] + boundsMax[2]) / 2;
  }
  const colorSource = fusedCameraColoredSurfels <= 0
    ? 'depth'
    : fusedCameraColoredSurfels >= surfelCount
      ? 'camera'
      : 'mixed';
  return {
    boundsMax,
    boundsMin,
    buildMs: performanceNow() - buildStart,
    cameraColoredSurfels: fusedCameraColoredSurfels,
    center,
    colorSource,
    keyframes,
    multiObservedSurfels,
    normalEstimatedSurfels,
    rawSampleCount,
    surfelCount,
    surfels,
    voxelSizeMeters: VOXEL_SIZE_M,
  };
}

export function formatModelInfo(model: CaptureModel): string {
  const size = [
    model.boundsMax[0] - model.boundsMin[0],
    model.boundsMax[1] - model.boundsMin[1],
    model.boundsMax[2] - model.boundsMin[2],
  ];
  return `model: ${model.keyframes} keyframes - ${model.surfelCount} surfels from ${model.rawSampleCount} samples - ${model.multiObservedSurfels} stable - ${model.normalEstimatedSurfels} normals - ${model.colorSource} color - ${size
    .map((value) => `${Math.max(0, value).toFixed(1)}m`)
    .join(' x ')}`;
}

export function summarizeCaptureGeometry(model: CaptureModel): CaptureGeometrySummary {
  if (model.surfelCount <= 0) {
    return emptyCaptureGeometrySummary([0, 0, 0]);
  }
  const surfels = model.surfels;
  let totalWeight = 0;
  let centroidX = 0;
  let centroidY = 0;
  let centroidZ = 0;
  let normalX = 0;
  let normalY = 0;
  let normalZ = 0;
  for (let offset = 0; offset + SURFEL_STRIDE_FLOATS <= surfels.length; offset += SURFEL_STRIDE_FLOATS) {
    const weight = Math.max(surfels[offset + 7] || 0, 1e-4);
    totalWeight += weight;
    centroidX += (surfels[offset] || 0) * weight;
    centroidY += (surfels[offset + 1] || 0) * weight;
    centroidZ += (surfels[offset + 2] || 0) * weight;
    normalX += (surfels[offset + 8] || 0) * weight;
    normalY += (surfels[offset + 9] || 0) * weight;
    normalZ += (surfels[offset + 10] || 0) * weight;
  }
  if (totalWeight <= 0) {
    return emptyCaptureGeometrySummary([0, 0, 0]);
  }
  const invTotalWeight = 1 / totalWeight;
  centroidX *= invTotalWeight;
  centroidY *= invTotalWeight;
  centroidZ *= invTotalWeight;
  const weightedCentroid: Vec3 = [centroidX, centroidY, centroidZ];
  const normalCoverage = clamp(model.normalEstimatedSurfels / Math.max(model.surfelCount, 1), 0, 1);
  if (normalCoverage <= 0) {
    return emptyCaptureGeometrySummary(weightedCentroid);
  }
  const normalLength = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
  if (normalLength <= 1e-6) {
    return emptyCaptureGeometrySummary(weightedCentroid);
  }
  const invNormalLength = 1 / normalLength;
  normalX *= invNormalLength;
  normalY *= invNormalLength;
  normalZ *= invNormalLength;

  let minProjection = Number.POSITIVE_INFINITY;
  let maxProjection = Number.NEGATIVE_INFINITY;
  let sumProjectionSq = 0;
  for (let offset = 0; offset + SURFEL_STRIDE_FLOATS <= surfels.length; offset += SURFEL_STRIDE_FLOATS) {
    const weight = Math.max(surfels[offset + 7] || 0, 1e-4);
    const projection =
      ((surfels[offset] || 0) - centroidX) * normalX +
      ((surfels[offset + 1] || 0) - centroidY) * normalY +
      ((surfels[offset + 2] || 0) - centroidZ) * normalZ;
    minProjection = Math.min(minProjection, projection);
    maxProjection = Math.max(maxProjection, projection);
    sumProjectionSq += projection * projection * weight;
  }

  return {
    normalCoherencePercent: clamp(normalLength * invTotalWeight * normalCoverage * 100, 0, 100),
    normalProjectedRmsMeters: Math.sqrt(sumProjectionSq * invTotalWeight),
    normalProjectedSpanMeters: Number.isFinite(minProjection) && Number.isFinite(maxProjection)
      ? Math.max(0, maxProjection - minProjection)
      : 0,
    weightedCentroid,
  };
}

function emptyCaptureGeometrySummary(weightedCentroid: Vec3): CaptureGeometrySummary {
  return {
    normalCoherencePercent: 0,
    normalProjectedRmsMeters: 0,
    normalProjectedSpanMeters: 0,
    weightedCentroid,
  };
}

export function formatQualityInfo(model: CaptureModel): string {
  return [
    `quality: fused ${formatPercent(model.surfelCount / Math.max(model.rawSampleCount, 1))}`,
    `stable ${formatPercent(model.multiObservedSurfels / Math.max(model.surfelCount, 1))}`,
    `camera ${formatPercent(model.cameraColoredSurfels / Math.max(model.surfelCount, 1))}`,
    `normals ${formatPercent(model.normalEstimatedSurfels / Math.max(model.surfelCount, 1))}`,
    `build ${model.buildMs.toFixed(1)}ms`,
  ].join(' - ');
}

export function serializeModelAsPly(model: CaptureModel): string {
  const serializableSurfels = Math.min(
    Math.max(0, Math.floor(model.surfelCount)),
    Math.floor(model.surfels.length / SURFEL_STRIDE_FLOATS)
  );
  const lines = [
    'ply',
    'format ascii 1.0',
    'comment standard-camera-app panoramic WebXR depth capture',
    `comment build_ms ${model.buildMs.toFixed(2)}`,
    `comment keyframes ${model.keyframes}`,
    `comment bounds_min ${model.boundsMin.map(plyNumber).join(' ')}`,
    `comment bounds_max ${model.boundsMax.map(plyNumber).join(' ')}`,
    `comment center ${model.center.map(plyNumber).join(' ')}`,
    `comment color_source ${model.colorSource}`,
    `comment camera_colored_surfels ${model.cameraColoredSurfels}`,
    `comment estimated_normal_surfels ${model.normalEstimatedSurfels}`,
    `comment multi_observed_surfels ${model.multiObservedSurfels}`,
    `comment raw_surfel_samples ${model.rawSampleCount}`,
    `comment voxel_size_meters ${model.voxelSizeMeters.toFixed(3)}`,
    `element vertex ${serializableSurfels}`,
    'property float x',
    'property float y',
    'property float z',
    'property float radius',
    'property float nx',
    'property float ny',
    'property float nz',
    'property float weight',
    'property float observations',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header',
  ];
  for (let i = 0; i < serializableSurfels * SURFEL_STRIDE_FLOATS; i += SURFEL_STRIDE_FLOATS) {
    lines.push([
      plyNumber(model.surfels[i] ?? 0),
      plyNumber(model.surfels[i + 1] ?? 0),
      plyNumber(model.surfels[i + 2] ?? 0),
      plyNumber(model.surfels[i + 3] ?? 1),
      plyNumber(model.surfels[i + 8] ?? 0),
      plyNumber(model.surfels[i + 9] ?? 1),
      plyNumber(model.surfels[i + 10] ?? 0),
      plyNumber(model.surfels[i + 7] ?? 0),
      plyNumber(model.surfels[i + 11] ?? 0),
      colorByte(model.surfels[i + 4] ?? 0),
      colorByte(model.surfels[i + 5] ?? 0),
      colorByte(model.surfels[i + 6] ?? 0),
    ].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

function plyNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(5) : '0.00000';
}

function colorByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 1 : 2)} MB`;
}

export function formatFilesLocation(filename: string, bytes: number): string {
  return `Files: standard-camera-app/${filename} (${formatBytes(bytes)})`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.max(0, Math.min(100, value * 100)).toFixed(0)}%`;
}

export function sampleCameraColor(
  camera: PanoramicCameraImage,
  bytes: Uint8Array,
  normCameraImageFromNormView: Float32Array,
  viewX: number,
  viewY: number
): Vec3 | null {
  const out: Vec3 = [0, 0, 0];
  return sampleCameraColorInto(out, camera, bytes, normCameraImageFromNormView, viewX, viewY) ? out : null;
}

function sampleCameraColorInto(
  out: Vec3,
  camera: PanoramicCameraImage,
  bytes: Uint8Array,
  normCameraImageFromNormView: Float32Array,
  viewX: number,
  viewY: number
): boolean {
  const sampler = createCameraColorSampler(camera, bytes, normCameraImageFromNormView);
  return sampler ? sampleCameraColorWithSamplerInto(out, sampler, viewX, viewY) : false;
}

function createCameraColorSampler(
  camera: PanoramicCameraImage,
  bytes: Uint8Array,
  normCameraImageFromNormView: Float32Array,
  depthCache?: DepthSampleGridCache
): CameraColorSampler | null {
  if (camera.width <= 0 || camera.height <= 0) return null;
  const transformMode = normalizedDepthTransformMode(normCameraImageFromNormView);
  const sampleMode = depthCache && canPrecomputeCameraGridAxes(normCameraImageFromNormView, transformMode)
    ? 'precomputed-axis'
    : 'normalized-transform';
  if (sampleMode === 'precomputed-axis' && depthCache) {
    // @ref LLP 0020#performance-constraints - Native panorama camera previews
    // expose an axis-aligned normalized WebXR image transform, so sparse grid
    // color sampling can reuse per-axis bilinear pixel weights.
    precomputeCameraGridAxis(
      depthCache.viewXs,
      camera.width,
      normCameraImageFromNormView[0] ?? 1,
      normCameraImageFromNormView[12] ?? 0,
      depthCache.cameraX0s,
      depthCache.cameraX1s,
      depthCache.cameraWX0s,
      depthCache.cameraWX1s,
      depthCache.cameraXValid
    );
    precomputeCameraGridAxis(
      depthCache.viewYs,
      camera.height,
      normCameraImageFromNormView[5] ?? 1,
      normCameraImageFromNormView[13] ?? 0,
      depthCache.cameraY0s,
      depthCache.cameraY1s,
      depthCache.cameraWY0s,
      depthCache.cameraWY1s,
      depthCache.cameraYValid
    );
  }
  return {
    bytes,
    cameraWX0s: depthCache?.cameraWX0s,
    cameraWX1s: depthCache?.cameraWX1s,
    cameraWY0s: depthCache?.cameraWY0s,
    cameraWY1s: depthCache?.cameraWY1s,
    cameraX0s: depthCache?.cameraX0s,
    cameraX1s: depthCache?.cameraX1s,
    cameraXValid: depthCache?.cameraXValid,
    cameraY0s: depthCache?.cameraY0s,
    cameraY1s: depthCache?.cameraY1s,
    cameraYValid: depthCache?.cameraYValid,
    format: camera.format,
    height: camera.height,
    maxPixelX: Math.max(0, camera.width - 1),
    maxPixelY: Math.max(0, camera.height - 1),
    sampleMode,
    transform: normCameraImageFromNormView,
    transformMode,
    width: camera.width,
  };
}

function canPrecomputeCameraGridAxes(
  transform: Float32Array,
  transformMode: NormalizedDepthTransformMode
): boolean {
  return transformMode !== 'projective' &&
    nearlyZero(transform[1] ?? 0) &&
    nearlyZero(transform[4] ?? 0);
}

function precomputeCameraGridAxis(
  viewValues: Float32Array,
  size: number,
  scale: number,
  offset: number,
  lowerPixels: Int32Array,
  upperPixels: Int32Array,
  lowerWeights: Float32Array,
  upperWeights: Float32Array,
  valid: Uint8Array
): void {
  const maxPixel = Math.max(0, size - 1);
  for (let i = 0; i < viewValues.length; i += 1) {
    const normalized = scale * (viewValues[i] ?? 0) + offset;
    if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
      lowerPixels[i] = 0;
      upperPixels[i] = 0;
      lowerWeights[i] = 0;
      upperWeights[i] = 0;
      valid[i] = 0;
      continue;
    }
    const pixel = normalizedImageCoordinateToPixel(normalized, size);
    if (!Number.isFinite(pixel)) {
      lowerPixels[i] = 0;
      upperPixels[i] = 0;
      lowerWeights[i] = 0;
      upperWeights[i] = 0;
      valid[i] = 0;
      continue;
    }
    const lower = Math.min(maxPixel, Math.max(0, Math.floor(pixel)));
    const upper = Math.min(maxPixel, lower + 1);
    const upperWeight = pixel - lower;
    lowerPixels[i] = lower;
    upperPixels[i] = upper;
    lowerWeights[i] = 1 - upperWeight;
    upperWeights[i] = upperWeight;
    valid[i] = 1;
  }
}

function samplePrecomputedGridCameraColorInto(
  out: Vec3,
  sampler: CameraColorSampler,
  gx: number,
  gy: number
): boolean {
  const cameraXValid = sampler.cameraXValid as Uint8Array;
  const cameraYValid = sampler.cameraYValid as Uint8Array;
  if (!cameraXValid[gx] || !cameraYValid[gy]) {
    return false;
  }
  const cameraWX0s = sampler.cameraWX0s as Float32Array;
  const cameraWX1s = sampler.cameraWX1s as Float32Array;
  const cameraWY0s = sampler.cameraWY0s as Float32Array;
  const cameraWY1s = sampler.cameraWY1s as Float32Array;
  const cameraX0s = sampler.cameraX0s as Int32Array;
  const cameraX1s = sampler.cameraX1s as Int32Array;
  const cameraY0s = sampler.cameraY0s as Int32Array;
  const cameraY1s = sampler.cameraY1s as Int32Array;
  const x0 = cameraX0s[gx] ?? 0;
  const x1 = cameraX1s[gx] ?? x0;
  const y0 = cameraY0s[gy] ?? 0;
  const y1 = cameraY1s[gy] ?? y0;
  const wx0 = cameraWX0s[gx] ?? 0;
  const wx1 = cameraWX1s[gx] ?? 0;
  const wy0 = cameraWY0s[gy] ?? 0;
  const wy1 = cameraWY1s[gy] ?? 0;
  const w00 = wx0 * wy0;
  const w10 = wx1 * wy0;
  const w01 = wx0 * wy1;
  const w11 = wx1 * wy1;
  return sampleCameraColorAtPixelsInto(out, sampler, x0, y0, x1, y1, w00, w10, w01, w11);
}

function sampleCameraColorWithSamplerInto(
  out: Vec3,
  sampler: CameraColorSampler,
  viewX: number,
  viewY: number
): boolean {
  const transform = sampler.transform;
  let cameraX = viewX;
  let cameraY = viewY;
  if (sampler.transformMode !== 'identity') {
    const cameraTx =
      transform[0] * viewX +
      transform[4] * viewY +
      transform[12];
    const cameraTy =
      transform[1] * viewX +
      transform[5] * viewY +
      transform[13];
    if (sampler.transformMode === 'projective') {
      const cameraTw =
        transform[3] * viewX +
        transform[7] * viewY +
        transform[15];
      cameraX = cameraTw !== 0 && cameraTw !== 1 ? cameraTx / cameraTw : cameraTx;
      cameraY = cameraTw !== 0 && cameraTw !== 1 ? cameraTy / cameraTw : cameraTy;
    } else {
      cameraX = cameraTx;
      cameraY = cameraTy;
    }
  }
  if (!Number.isFinite(cameraX) || !Number.isFinite(cameraY)) return false;
  if (cameraX < 0 || cameraX > 1 || cameraY < 0 || cameraY > 1) return false;
  const pixelX = normalizedImageCoordinateToPixel(cameraX, sampler.width);
  const pixelY = normalizedImageCoordinateToPixel(cameraY, sampler.height);
  if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) return false;
  const x0 = Math.floor(pixelX);
  const y0 = Math.floor(pixelY);
  const x1 = Math.min(sampler.width - 1, x0 + 1);
  const y1 = Math.min(sampler.height - 1, y0 + 1);
  const fx = pixelX - x0;
  const fy = pixelY - y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  return sampleCameraColorAtPixelsInto(out, sampler, x0, y0, x1, y1, w00, w10, w01, w11);
}

function normalizedImageCoordinateToPixel(value: number, size: number): number {
  if (!Number.isFinite(value) || size <= 0) return Number.NaN;
  return Math.min(Math.max(0, size - 1), Math.max(0, value * size - 0.5));
}

function sampleCameraColorAtPixelsInto(
  out: Vec3,
  sampler: CameraColorSampler,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w00: number,
  w10: number,
  w01: number,
  w11: number
): boolean {
  // @ref LLP 0020#reconstruction-pipeline - Camera colors are sampled through
  // the WebXR normalized image transform and interpolated at subpixel
  // locations, avoiding nearest-pixel shimmer in the live surfel preview.
  const bytes = sampler.bytes;
  const offset00 = (y0 * sampler.width + x0) * 4;
  const offset10 = (y0 * sampler.width + x1) * 4;
  const offset01 = (y1 * sampler.width + x0) * 4;
  const offset11 = (y1 * sampler.width + x1) * 4;
  if (offset00 < 0 || offset11 + 2 >= bytes.length) return false;
  const inv255 = 1 / 255;
  if (sampler.format === 'bgra8unorm') {
    out[0] = (
      bytes[offset00 + 2] * w00 +
      bytes[offset10 + 2] * w10 +
      bytes[offset01 + 2] * w01 +
      bytes[offset11 + 2] * w11
    ) * inv255;
    out[1] = (
      bytes[offset00 + 1] * w00 +
      bytes[offset10 + 1] * w10 +
      bytes[offset01 + 1] * w01 +
      bytes[offset11 + 1] * w11
    ) * inv255;
    out[2] = (
      bytes[offset00] * w00 +
      bytes[offset10] * w10 +
      bytes[offset01] * w01 +
      bytes[offset11] * w11
    ) * inv255;
    return true;
  }
  out[0] = (
    bytes[offset00] * w00 +
    bytes[offset10] * w10 +
    bytes[offset01] * w01 +
    bytes[offset11] * w11
  ) * inv255;
  out[1] = (
    bytes[offset00 + 1] * w00 +
    bytes[offset10 + 1] * w10 +
    bytes[offset01 + 1] * w01 +
    bytes[offset11 + 1] * w11
  ) * inv255;
  out[2] = (
    bytes[offset00 + 2] * w00 +
    bytes[offset10 + 2] * w10 +
    bytes[offset01 + 2] * w01 +
    bytes[offset11 + 2] * w11
  ) * inv255;
  return true;
}

export function unprojectViewSample(
  inverseProjection: Float32Array,
  viewX: number,
  viewY: number,
  depthMeters: number
): Vec3 {
  return unprojectViewSampleInto([0, 0, 0], inverseProjection, viewX, viewY, depthMeters);
}

function unprojectViewSampleInto(
  out: Vec3,
  unprojector: Float32Array | ViewSampleUnprojector,
  viewX: number,
  viewY: number,
  depthMeters: number
): Vec3 {
  if (!(unprojector instanceof Float32Array) && unprojector.mode === 'intrinsics-projection') {
    const ndcX = viewX * 2 - 1;
    const ndcY = 1 - viewY * 2;
    out[0] = (ndcX + unprojector.offsetX) * depthMeters * unprojector.scaleX;
    out[1] = (ndcY + unprojector.offsetY) * depthMeters * unprojector.scaleY;
    out[2] = -depthMeters;
    return out;
  }
  const inverseProjection = unprojector instanceof Float32Array
    ? unprojector
    : unprojector.inverseProjection;
  const ndcX = viewX * 2 - 1;
  const ndcY = 1 - viewY * 2;
  const x = inverseProjection[0] * ndcX + inverseProjection[4] * ndcY - inverseProjection[8] + inverseProjection[12];
  const y = inverseProjection[1] * ndcX + inverseProjection[5] * ndcY - inverseProjection[9] + inverseProjection[13];
  const z = inverseProjection[2] * ndcX + inverseProjection[6] * ndcY - inverseProjection[10] + inverseProjection[14];
  const w = inverseProjection[3] * ndcX + inverseProjection[7] * ndcY - inverseProjection[11] + inverseProjection[15];
  const invW = w === 0 ? 1 : 1 / w;
  const nearX = x * invW;
  const nearY = y * invW;
  const nearZ = z * invW;
  const cameraZ = nearZ === 0 ? -1 : nearZ;
  const scale = -depthMeters / cameraZ;
  out[0] = nearX * scale;
  out[1] = nearY * scale;
  out[2] = -depthMeters;
  return out;
}

function createViewSampleUnprojector(projectionMatrix: Float32Array): ViewSampleUnprojector | null {
  // @ref LLP 0020#reconstruction-pipeline - ARKit intrinsics are exposed to
  // app code only as WebXR projection geometry; this fast path consumes that
  // standard matrix and applies the same pinhole-camera unprojection used by
  // Apple's scene-depth point-cloud guidance.
  if (isIntrinsicsProjectionMatrix(projectionMatrix)) {
    return {
      mode: 'intrinsics-projection',
      offsetX: projectionMatrix[8] ?? 0,
      offsetY: projectionMatrix[9] ?? 0,
      scaleX: 1 / (projectionMatrix[0] ?? 1),
      scaleY: 1 / (projectionMatrix[5] ?? 1),
    };
  }
  const inverseProjection = invertMatrix4(projectionMatrix);
  return inverseProjection ? { inverseProjection, mode: 'matrix-inverse' } : null;
}

function isIntrinsicsProjectionMatrix(matrix: Float32Array): boolean {
  const sx = matrix[0] ?? 0;
  const sy = matrix[5] ?? 0;
  return Number.isFinite(sx) &&
    Number.isFinite(sy) &&
    Math.abs(sx) > 1e-6 &&
    Math.abs(sy) > 1e-6 &&
    nearlyZero(matrix[1] ?? 0) &&
    nearlyZero(matrix[2] ?? 0) &&
    nearlyZero(matrix[3] ?? 0) &&
    nearlyZero(matrix[4] ?? 0) &&
    nearlyZero(matrix[6] ?? 0) &&
    nearlyZero(matrix[7] ?? 0) &&
    Number.isFinite(matrix[8] ?? 0) &&
    Number.isFinite(matrix[9] ?? 0) &&
    nearlyZero(matrix[12] ?? 0) &&
    nearlyZero(matrix[13] ?? 0) &&
    Math.abs((matrix[11] ?? 0) + 1) <= 1e-5 &&
    nearlyZero(matrix[15] ?? 0);
}

function nearlyZero(value: number): boolean {
  return Math.abs(value) <= 1e-5;
}

function nearlyOne(value: number): boolean {
  return Math.abs(value - 1) <= 1e-5;
}

export function transformPoint(matrix: Float32Array, point: Vec3): Vec3 {
  return transformPointInto([0, 0, 0], matrix, point);
}

function transformPointInto(out: Vec3, matrix: Float32Array, point: Vec3): Vec3 {
  out[0] = matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12];
  out[1] = matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13];
  out[2] = matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14];
  return out;
}

function transformDirectionInto(out: Vec3, matrix: Float32Array, point: Vec3): Vec3 {
  out[0] = matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2];
  out[1] = matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2];
  out[2] = matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2];
  return out;
}

function createCameraToWorldTransformCache(matrix: Float32Array): CameraToWorldTransformCache {
  return {
    tx: matrix[12] ?? 0,
    ty: matrix[13] ?? 0,
    tz: matrix[14] ?? 0,
    xAxisX: matrix[0] ?? 1,
    xAxisY: matrix[1] ?? 0,
    xAxisZ: matrix[2] ?? 0,
    yAxisX: matrix[4] ?? 0,
    yAxisY: matrix[5] ?? 1,
    yAxisZ: matrix[6] ?? 0,
    zAxisX: matrix[8] ?? 0,
    zAxisY: matrix[9] ?? 0,
    zAxisZ: matrix[10] ?? 1,
  };
}

function transformCameraPointToWorldInto(
  out: Vec3,
  transform: CameraToWorldTransformCache,
  point: Vec3
): Vec3 {
  out[0] = transform.xAxisX * point[0] + transform.yAxisX * point[1] + transform.zAxisX * point[2] + transform.tx;
  out[1] = transform.xAxisY * point[0] + transform.yAxisY * point[1] + transform.zAxisY * point[2] + transform.ty;
  out[2] = transform.xAxisZ * point[0] + transform.yAxisZ * point[1] + transform.zAxisZ * point[2] + transform.tz;
  return out;
}

function transformCameraDirectionToWorldInto(
  out: Vec3,
  transform: CameraToWorldTransformCache,
  point: Vec3
): Vec3 {
  out[0] = transform.xAxisX * point[0] + transform.yAxisX * point[1] + transform.zAxisX * point[2];
  out[1] = transform.xAxisY * point[0] + transform.yAxisY * point[1] + transform.zAxisY * point[2];
  out[2] = transform.xAxisZ * point[0] + transform.yAxisZ * point[1] + transform.zAxisZ * point[2];
  return out;
}

export function transformNormalizedPoint(matrix: Float32Array, x: number, y: number): { x: number; y: number } {
  const tx = matrix[0] * x + matrix[4] * y + matrix[12];
  const ty = matrix[1] * x + matrix[5] * y + matrix[13];
  const tw = matrix[3] * x + matrix[7] * y + matrix[15];
  if (tw !== 0 && tw !== 1) {
    return { x: tx / tw, y: ty / tw };
  }
  return { x: tx, y: ty };
}

export function depthPalette(depthMeters: number): Vec3 {
  const out: Vec3 = [0, 0, 0];
  depthPaletteInto(out, depthMeters);
  return out;
}

function depthPaletteInto(out: Vec3, depthMeters: number): void {
  const t = clamp01((depthMeters - MIN_DEPTH_M) / (MAX_DEPTH_M - MIN_DEPTH_M));
  const near: Vec3 = [1.0, 0.42, 0.14];
  const mid: Vec3 = [0.1, 0.86, 0.72];
  const far: Vec3 = [0.25, 0.34, 1.0];
  if (t < 0.55) {
    mixVec3Into(out, near, mid, smoothstep(0, 0.55, t));
  } else {
    mixVec3Into(out, mid, far, smoothstep(0.48, 1, t));
  }
}

export function makeModelViewProjection(
  model: CaptureModel | null,
  aspect: number,
  orbit: number,
  viewer: ViewerState
): Float32Array {
  return makeModelViewProjectionInto(new Float32Array(16), model, aspect, orbit, viewer);
}

export function makeModelViewProjectionInto(
  out: Float32Array,
  model: CaptureModel | null,
  aspect: number,
  orbit: number,
  viewer: ViewerState
): Float32Array {
  if (!model) {
    return perspectiveLookAtInto(out, Math.PI / 3.1, aspect, 0.01, 100, 0, 0.4, 3.4, 0, 0, 0);
  }
  // @ref LLP 0020#model-view - Use the weighted surfel center so asymmetric
  // partial scans and low-weight outliers do not pull the orbit target away
  // from the scanned surfaces.
  const centerX = model.center[0];
  const centerY = model.center[1];
  const centerZ = model.center[2];
  const spanX = Math.max(0.1, model.boundsMax[0] - model.boundsMin[0]);
  const spanY = Math.max(0.1, model.boundsMax[1] - model.boundsMin[1]);
  const spanZ = Math.max(0.1, model.boundsMax[2] - model.boundsMin[2]);
  const radius = Math.max(1.2, Math.hypot(spanX, spanY, spanZ) * 0.72) * viewer.distanceScale;
  const yaw = orbit + viewer.yaw;
  const horizontalRadius = Math.cos(viewer.pitch) * radius;
  const baseEyeX = centerX + Math.sin(yaw) * horizontalRadius;
  const baseEyeY = centerY + Math.sin(viewer.pitch) * radius;
  const baseEyeZ = centerZ + Math.cos(yaw) * horizontalRadius;
  const forwardX = centerX - baseEyeX;
  const forwardY = centerY - baseEyeY;
  const forwardZ = centerZ - baseEyeZ;
  const invForwardLength = 1 / Math.max(Math.hypot(forwardX, forwardY, forwardZ), 1e-6);
  const normalizedForwardX = forwardX * invForwardLength;
  const normalizedForwardY = forwardY * invForwardLength;
  const normalizedForwardZ = forwardZ * invForwardLength;
  let rightX = -normalizedForwardZ;
  let rightY = 0;
  let rightZ = normalizedForwardX;
  const rightLength = Math.hypot(rightX, rightY, rightZ);
  if (rightLength > 1e-6) {
    rightX /= rightLength;
    rightY /= rightLength;
    rightZ /= rightLength;
  } else {
    rightX = 0;
    rightY = 0;
    rightZ = 1;
  }
  const upX = rightY * normalizedForwardZ - rightZ * normalizedForwardY;
  const upY = rightZ * normalizedForwardX - rightX * normalizedForwardZ;
  const upZ = rightX * normalizedForwardY - rightY * normalizedForwardX;
  const panScaleX = viewer.panX * radius;
  const panScaleY = viewer.panY * radius;
  const panX = rightX * panScaleX + upX * panScaleY;
  const panY = rightY * panScaleX + upY * panScaleY;
  const panZ = rightZ * panScaleX + upZ * panScaleY;
  // @ref LLP 0020#model-view - Gesture rotation renders every touch frame, so
  // write the model-view-projection directly into the caller's reusable uniform
  // buffer instead of allocating temporary vectors and matrices per frame.
  return perspectiveLookAtInto(
    out,
    Math.PI / 3.0,
    aspect,
    0.01,
    Math.max(20, radius * 8),
    baseEyeX + panX,
    baseEyeY + panY,
    baseEyeZ + panZ,
    centerX + panX,
    centerY + panY,
    centerZ + panZ
  );
}

function perspectiveLookAtInto(
  out: Float32Array,
  fovy: number,
  aspect: number,
  near: number,
  far: number,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  centerX: number,
  centerY: number,
  centerZ: number
): Float32Array {
  const zXRaw = eyeX - centerX;
  const zYRaw = eyeY - centerY;
  const zZRaw = eyeZ - centerZ;
  const invZLength = 1 / Math.max(Math.hypot(zXRaw, zYRaw, zZRaw), 1e-6);
  const zX = zXRaw * invZLength;
  const zY = zYRaw * invZLength;
  const zZ = zZRaw * invZLength;
  let xX = zZ;
  let xY = 0;
  let xZ = -zX;
  const xLength = Math.hypot(xX, xY, xZ);
  if (xLength > 1e-6) {
    xX /= xLength;
    xY /= xLength;
    xZ /= xLength;
  } else {
    xX = 0;
    xY = 0;
    xZ = 1;
  }
  const yX = zY * xZ - zZ * xY;
  const yY = zZ * xX - zX * xZ;
  const yZ = zX * xY - zY * xX;
  const viewTx = -(xX * eyeX + xY * eyeY + xZ * eyeZ);
  const viewTy = -(yX * eyeX + yY * eyeY + yZ * eyeZ);
  const viewTz = -(zX * eyeX + zY * eyeY + zZ * eyeZ);
  const f = 1 / Math.tan(fovy / 2);
  const p00 = f / aspect;
  const p11 = f;
  const nf = 1 / (near - far);
  const p22 = (far + near) * nf;
  const p32 = 2 * far * near * nf;
  out[0] = p00 * xX;
  out[1] = p11 * yX;
  out[2] = p22 * zX;
  out[3] = -zX;
  out[4] = p00 * xY;
  out[5] = p11 * yY;
  out[6] = p22 * zY;
  out[7] = -zY;
  out[8] = p00 * xZ;
  out[9] = p11 * yZ;
  out[10] = p22 * zZ;
  out[11] = -zZ;
  out[12] = p00 * viewTx;
  out[13] = p11 * viewTy;
  out[14] = p22 * viewTz + p32;
  out[15] = -viewTz;
  return out;
}

export function viewerYawForForward(forward: Vec3): number {
  const horizontalLength = Math.hypot(forward[0], forward[2]);
  if (!Number.isFinite(horizontalLength) || horizontalLength < 1e-6) return 0;
  return Math.atan2(-forward[0] / horizontalLength, -forward[2] / horizontalLength);
}

function averageForward(forwards: readonly Vec3[]): Vec3 {
  if (forwards.length === 0) return [0, 0, -1];
  const sum: Vec3 = [0, 0, 0];
  for (const forward of forwards) {
    sum[0] += forward[0];
    sum[1] += forward[1];
    sum[2] += forward[2];
  }
  return normalizeOrDefault(sum, [0, 0, -1]);
}

function horizontalYaw(forward: Vec3): number {
  const horizontalLength = Math.hypot(forward[0], forward[2]);
  if (!Number.isFinite(horizontalLength) || horizontalLength < 1e-6) return 0;
  return Math.atan2(forward[0] / horizontalLength, -forward[2] / horizontalLength);
}

function signedYawDelta(fromYaw: number, toYaw: number): number {
  const twoPi = Math.PI * 2;
  const delta = positiveModulo(toYaw - fromYaw + Math.PI, twoPi) - Math.PI;
  return delta === -Math.PI ? Math.PI : delta;
}

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array {
  const z = normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

export function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

export function invertMatrix4(input: Float32Array): Float32Array | null {
  const a: number[] = new Array(16);
  const inv: number[] = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      a[row * 4 + col] = input[col * 4 + row];
    }
    inv[row * 4 + row] = 1;
  }
  for (let col = 0; col < 4; col += 1) {
    let pivotRow = col;
    let pivotSize = Math.abs(a[pivotRow * 4 + col]);
    for (let row = col + 1; row < 4; row += 1) {
      const size = Math.abs(a[row * 4 + col]);
      if (size > pivotSize) {
        pivotRow = row;
        pivotSize = size;
      }
    }
    if (pivotSize < 1e-8) return null;
    if (pivotRow !== col) {
      for (let i = 0; i < 4; i += 1) {
        [a[col * 4 + i], a[pivotRow * 4 + i]] = [a[pivotRow * 4 + i], a[col * 4 + i]];
        [inv[col * 4 + i], inv[pivotRow * 4 + i]] = [inv[pivotRow * 4 + i], inv[col * 4 + i]];
      }
    }
    const pivot = a[col * 4 + col];
    for (let i = 0; i < 4; i += 1) {
      a[col * 4 + i] /= pivot;
      inv[col * 4 + i] /= pivot;
    }
    for (let row = 0; row < 4; row += 1) {
      if (row === col) continue;
      const factor = a[row * 4 + col];
      for (let i = 0; i < 4; i += 1) {
        a[row * 4 + i] -= factor * a[col * 4 + i];
        inv[row * 4 + i] -= factor * inv[col * 4 + i];
      }
    }
  }
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[col * 4 + row] = inv[row * 4 + col];
    }
  }
  return out;
}

export function extractPosition(matrix: Float32Array): Vec3 {
  return [matrix[12] ?? 0, matrix[13] ?? 0, matrix[14] ?? 0];
}

export function extractForward(matrix: Float32Array): Vec3 {
  return normalize([-(matrix[8] ?? 0), -(matrix[9] ?? 0), -(matrix[10] ?? 1)]);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scaleVec3(v: Vec3, scale: number): Vec3 {
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

function observationFacingNormalInto(
  out: Vec3,
  cameraToWorld: CameraToWorldTransformCache,
  cameraPoint: Vec3,
  pointToCamera: Vec3
): Vec3 {
  pointToCamera[0] = -cameraPoint[0];
  pointToCamera[1] = -cameraPoint[1];
  pointToCamera[2] = -cameraPoint[2];
  normalizeInto(pointToCamera, pointToCamera);
  transformCameraDirectionToWorldInto(out, cameraToWorld, pointToCamera);
  return normalizeInto(out, out);
}

export function angleDegrees(a: Vec3, b: Vec3): number {
  const value = Math.min(1, Math.max(-1, dot(normalize(a), normalize(b))));
  return Math.acos(value) * 180 / Math.PI;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): Vec3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (length <= 1e-6) return [0, 0, 1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function normalizeOrDefault(v: Vec3, fallback: Vec3): Vec3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (length <= 1e-6) return [fallback[0], fallback[1], fallback[2]];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function normalizeInto(out: Vec3, v: Vec3): Vec3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (length <= 1e-6) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 1;
    return out;
  }
  out[0] = v[0] / length;
  out[1] = v[1] / length;
  out[2] = v[2] / length;
  return out;
}

function normalizeFiniteVectorInto(out: Vec3, v: Vec3): boolean {
  const lengthSq = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (!Number.isFinite(lengthSq) || lengthSq <= 1e-12) {
    return false;
  }
  const invLength = 1 / Math.sqrt(lengthSq);
  out[0] = v[0] * invLength;
  out[1] = v[1] * invLength;
  out[2] = v[2] * invLength;
  return true;
}

function mixVec3Into(out: Vec3, a: Vec3, b: Vec3, amount: number): void {
  out[0] = a[0] + (b[0] - a[0]) * amount;
  out[1] = a[1] + (b[1] - a[1]) * amount;
  out[2] = a[2] + (b[2] - a[2]) * amount;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function positiveModulo(value: number, divisor: number): number {
  if (!Number.isFinite(value) || divisor === 0) return 0;
  return ((value % divisor) + divisor) % divisor;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function performanceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
