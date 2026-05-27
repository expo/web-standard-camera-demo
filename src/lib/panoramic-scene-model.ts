export const MAX_SURFELS = 72000;
export const SAMPLE_GRID_X = 44;
export const SAMPLE_GRID_Y = 34;
export const MIN_DEPTH_M = 0.35;
export const MAX_DEPTH_M = 4.8;
export const VOXEL_SIZE_M = 0.045;
export const MAX_KEYFRAMES = 36;
export const KEYFRAME_MIN_INTERVAL_MS = 280;
export const KEYFRAME_MIN_TRANSLATION_M = 0.1;
export const KEYFRAME_MIN_ROTATION_DEG = 10;
export const MIN_KEYFRAME_SURFELS = 96;
export const PANORAMIC_COVERAGE_YAW_BINS = 12;
export const PANORAMIC_COVERAGE_PITCH_BINS = 3;
export const PANORAMIC_COVERAGE_PITCH_RANGE_DEG = 60;
export const SURFEL_STRIDE_FLOATS = 12;
export const SURFEL_STRIDE_BYTES = SURFEL_STRIDE_FLOATS * 4;
export const LIVE_MODEL_BASE_INTERVAL_MS = 320;
export const LIVE_MODEL_10K_INTERVAL_MS = 760;
export const LIVE_MODEL_25K_INTERVAL_MS = 1250;
export const LIVE_MODEL_45K_INTERVAL_MS = 1800;
export const LIVE_MODEL_MAX_BUILD_PRESSURE_INTERVAL_MS = 2200;
export const SURFEL_BUFFER_CAPACITY_GRANULARITY_BYTES = 256 * 1024;
export const MODEL_SURFEL_BASE_POINT_SCALE_PX = 3.4;
export const MODEL_SURFEL_DENSE_POINT_SCALE_MIN_PX = 1.7;
export const MODEL_SURFEL_DENSE_POINT_SCALE_THRESHOLD = 10000;

export type Vec3 = [number, number, number];

export interface CaptureModel {
  boundsMax: Vec3;
  boundsMin: Vec3;
  buildMs: number;
  cameraColoredSurfels: number;
  colorSource: 'camera' | 'depth' | 'mixed';
  keyframes: number;
  normalEstimatedSurfels: number;
  rawSampleCount: number;
  surfelCount: number;
  surfels: Float32Array;
  voxelSizeMeters: number;
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

export interface KeyframeSnapshot {
  forward: Vec3;
  position: Vec3;
  time: number;
}

export type KeyframeRejectionReason =
  | 'max-keyframes'
  | 'max-surfels'
  | 'too-few-surfels'
  | 'too-soon'
  | 'too-similar';

export interface KeyframeAcceptanceDecision {
  accepted: boolean;
  reason: KeyframeRejectionReason | null;
  rotationDeg: number;
  translationM: number;
}

export interface KeyframeAcceptanceInput {
  candidateSurfels?: number;
  existingSurfels: number;
  forward: Vec3;
  keyframes: number;
  last: KeyframeSnapshot | null;
  maxKeyframes?: number;
  maxSurfels?: number;
  minIntervalMs?: number;
  minRotationDeg?: number;
  minSurfels?: number;
  minTranslationM?: number;
  position: Vec3;
  time: number;
}

export interface PanoramicCoverageOptions {
  pitchBins?: number;
  pitchRangeDeg?: number;
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
    ? clamp(previousBuildMs * 5, LIVE_MODEL_BASE_INTERVAL_MS, LIVE_MODEL_MAX_BUILD_PRESSURE_INTERVAL_MS)
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
  rawSampleCount: number;
  voxels: Map<string, SurfelVoxelAccumulator>;
}

export function shouldAcceptPanoramicKeyframe({
  candidateSurfels,
  existingSurfels,
  forward,
  keyframes,
  last,
  maxKeyframes = MAX_KEYFRAMES,
  maxSurfels = MAX_SURFELS,
  minIntervalMs = KEYFRAME_MIN_INTERVAL_MS,
  minRotationDeg = KEYFRAME_MIN_ROTATION_DEG,
  minSurfels = MIN_KEYFRAME_SURFELS,
  minTranslationM = KEYFRAME_MIN_TRANSLATION_M,
  position,
  time,
}: KeyframeAcceptanceInput): KeyframeAcceptanceDecision {
  if (keyframes >= maxKeyframes) {
    return { accepted: false, reason: 'max-keyframes', rotationDeg: 0, translationM: 0 };
  }
  if (existingSurfels >= maxSurfels) {
    return { accepted: false, reason: 'max-surfels', rotationDeg: 0, translationM: 0 };
  }
  if (candidateSurfels !== undefined && candidateSurfels < minSurfels) {
    return { accepted: false, reason: 'too-few-surfels', rotationDeg: 0, translationM: 0 };
  }
  if (!last) {
    return { accepted: true, reason: null, rotationDeg: 0, translationM: 0 };
  }

  const translationM = distance(position, last.position);
  const rotationDeg = angleDegrees(forward, last.forward);
  if (time - last.time < minIntervalMs) {
    return { accepted: false, reason: 'too-soon', rotationDeg, translationM };
  }
  if (translationM < minTranslationM && rotationDeg < minRotationDeg) {
    return { accepted: false, reason: 'too-similar', rotationDeg, translationM };
  }
  return { accepted: true, reason: null, rotationDeg, translationM };
}

export function panoramicCoverageKey(
  forward: Vec3,
  {
    pitchBins = PANORAMIC_COVERAGE_PITCH_BINS,
    pitchRangeDeg = PANORAMIC_COVERAGE_PITCH_RANGE_DEG,
    yawBins = PANORAMIC_COVERAGE_YAW_BINS,
  }: PanoramicCoverageOptions = {}
): string {
  const direction = normalize(forward);
  const yaw = Math.atan2(direction[0], -direction[2]);
  const yawUnit = positiveModulo(yaw / (Math.PI * 2), 1);
  const pitchRangeRad = Math.max(1, pitchRangeDeg) * Math.PI / 180;
  const pitch = Math.asin(clamp(direction[1], -1, 1));
  const pitchUnit = clamp((pitch + pitchRangeRad) / (pitchRangeRad * 2), 0, 0.999999);
  const safeYawBins = Math.max(1, Math.floor(yawBins));
  const safePitchBins = Math.max(1, Math.floor(pitchBins));
  const yawBin = Math.min(safeYawBins - 1, Math.floor(yawUnit * safeYawBins));
  const pitchBin = Math.min(safePitchBins - 1, Math.floor(pitchUnit * safePitchBins));
  return `${yawBin}:${pitchBin}`;
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
  camera: PanoramicCameraImage | null,
  projectionMatrix: Float32Array,
  cameraToWorld: Float32Array,
  store: number[],
  existingSurfels: number
): { cameraColoredSurfels: number; surfelCount: number } {
  const inverseProjection = invertMatrix4(projectionMatrix);
  if (!inverseProjection) return { cameraColoredSurfels: 0, surfelCount: 0 };
  const values = new Float32Array(depth.data);
  const depthTransform = depth.normDepthBufferFromNormView.matrix;
  const cameraPosition = extractPosition(cameraToWorld);
  const cameraBytes = camera ? new Uint8Array(camera.data) : null;
  const cameraTransform = camera?.normCameraImageFromNormView.matrix ?? null;
  let added = 0;
  let cameraColoredSurfels = 0;
  for (let gy = 0; gy < SAMPLE_GRID_Y && added + existingSurfels < MAX_SURFELS; gy += 1) {
    const viewY = (gy + 0.5) / SAMPLE_GRID_Y;
    for (let gx = 0; gx < SAMPLE_GRID_X && added + existingSurfels < MAX_SURFELS; gx += 1) {
      const viewX = (gx + 0.5) / SAMPLE_GRID_X;
      const depthMeters = sampleDepthMeters(values, depth, depthTransform, viewX, viewY);
      if (!Number.isFinite(depthMeters) || depthMeters < MIN_DEPTH_M || depthMeters > MAX_DEPTH_M) {
        continue;
      }
      // @ref LLP 0020#reconstruction-pipeline - WebXR depth samples are read
      // through normDepthBufferFromNormView, then unprojected with the
      // associated XRViewGeometry projection matrix.
      const cameraPoint = unprojectViewSample(inverseProjection, viewX, viewY, depthMeters);
      const world = transformPoint(cameraToWorld, cameraPoint);
      const normalSample = estimateWorldNormal(
        values,
        depth,
        depthTransform,
        inverseProjection,
        cameraToWorld,
        cameraPosition,
        world,
        viewX,
        viewY,
        depthMeters,
        cameraPoint
      );
      const sampledColor = camera && cameraBytes && cameraTransform
        ? sampleCameraColor(camera, cameraBytes, cameraTransform, viewX, viewY)
        : null;
      const color = sampledColor ?? depthPalette(depthMeters);
      if (sampledColor) cameraColoredSurfels += 1;
      const radius = Math.max(0.6, 2.4 - depthMeters * 0.26);
      const weight = surfelSampleWeight(depthMeters) * (sampledColor ? 1 : -1);
      store.push(
        world[0],
        world[1],
        world[2],
        radius,
        color[0],
        color[1],
        color[2],
        weight,
        normalSample.normal[0],
        normalSample.normal[1],
        normalSample.normal[2],
        normalSample.confidence
      );
      added += 1;
    }
  }
  return { cameraColoredSurfels, surfelCount: added };
}

export function sampleDepthMeters(
  values: Float32Array,
  depth: PanoramicDepthInformation,
  normDepthBufferFromNormView: Float32Array,
  viewX: number,
  viewY: number
): number {
  const depthPoint = transformNormalizedPoint(normDepthBufferFromNormView, viewX, viewY);
  if (!Number.isFinite(depthPoint.x) || !Number.isFinite(depthPoint.y)) return Number.NaN;
  if (depthPoint.x < 0 || depthPoint.x > 1 || depthPoint.y < 0 || depthPoint.y > 1) {
    return Number.NaN;
  }
  const px = Math.round(clamp01(depthPoint.x) * Math.max(0, depth.width - 1));
  const py = Math.round(clamp01(depthPoint.y) * Math.max(0, depth.height - 1));
  const rawDepth = values[py * depth.width + px] ?? 0;
  return rawDepth * depth.rawValueToMeters;
}

function estimateWorldNormal(
  values: Float32Array,
  depth: PanoramicDepthInformation,
  depthTransform: Float32Array,
  inverseProjection: Float32Array,
  cameraToWorld: Float32Array,
  cameraPosition: Vec3,
  worldPoint: Vec3,
  viewX: number,
  viewY: number,
  depthMeters: number,
  cameraPoint: Vec3
): { confidence: number; normal: Vec3 } {
  const fallback = observationFacingNormal(cameraToWorld, cameraPoint);
  const stepX = 1 / SAMPLE_GRID_X;
  const stepY = 1 / SAMPLE_GRID_Y;
  const xForward = viewX + stepX <= 0.98;
  const yForward = viewY + stepY <= 0.98;
  const neighborX = xForward ? viewX + stepX : viewX - stepX;
  const neighborY = yForward ? viewY + stepY : viewY - stepY;
  if (neighborX < 0 || neighborX > 1 || neighborY < 0 || neighborY > 1) {
    return { confidence: 0.25, normal: fallback };
  }

  const depthX = sampleDepthMeters(values, depth, depthTransform, neighborX, viewY);
  const depthY = sampleDepthMeters(values, depth, depthTransform, viewX, neighborY);
  const discontinuityThreshold = Math.max(0.1, depthMeters * 0.06);
  if (
    !isUsableNeighborDepth(depthX, depthMeters, discontinuityThreshold) ||
    !isUsableNeighborDepth(depthY, depthMeters, discontinuityThreshold)
  ) {
    return { confidence: 0.25, normal: fallback };
  }

  const cameraPointX = unprojectViewSample(inverseProjection, neighborX, viewY, depthX);
  const cameraPointY = unprojectViewSample(inverseProjection, viewX, neighborY, depthY);
  const vecX = xForward ? subtract(cameraPointX, cameraPoint) : subtract(cameraPoint, cameraPointX);
  const vecY = yForward ? subtract(cameraPointY, cameraPoint) : subtract(cameraPoint, cameraPointY);
  const normalCamera = cross(vecY, vecX);
  if (Math.hypot(normalCamera[0], normalCamera[1], normalCamera[2]) <= 1e-5) {
    return { confidence: 0.25, normal: fallback };
  }
  let normalWorld = normalize(transformDirection(cameraToWorld, normalize(normalCamera)));
  if (dot(normalWorld, subtract(cameraPosition, worldPoint)) < 0) {
    normalWorld = scaleVec3(normalWorld, -1);
  }
  return { confidence: 1, normal: normalWorld };
}

function isUsableNeighborDepth(depthMeters: number, centerDepthMeters: number, threshold: number): boolean {
  return Number.isFinite(depthMeters) &&
    depthMeters >= MIN_DEPTH_M &&
    depthMeters <= MAX_DEPTH_M &&
    Math.abs(depthMeters - centerDepthMeters) <= threshold;
}

function surfelSampleWeight(depthMeters: number): number {
  // Distant ARKit depth samples cover more world area and tend to be noisier;
  // keep them useful for coverage without letting them dominate fused voxels.
  return clamp(1.35 / Math.max(depthMeters * depthMeters, 0.5), 0.14, 1.8);
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
    rawSampleCount: 0,
    voxels: new Map<string, SurfelVoxelAccumulator>(),
  };
}

export function appendSurfelsToFusion(fusion: SurfelFusionAccumulator, points: number[]): void {
  for (let i = 0; i + SURFEL_STRIDE_FLOATS <= points.length; i += SURFEL_STRIDE_FLOATS) {
    fusion.rawSampleCount += 1;
    const x = points[i] ?? 0;
    const y = points[i + 1] ?? 0;
    const z = points[i + 2] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const rawWeight = points[i + 7] ?? 1;
    const weight = Math.max(Math.abs(rawWeight), 1e-4);
    const key = voxelKey(x, y, z);
    let voxel = fusion.voxels.get(key);
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
    addSampleToVoxel(voxel, points, i, weight, rawWeight > 0);
  }
}

function addSampleToVoxel(
  voxel: SurfelVoxelAccumulator,
  points: number[],
  offset: number,
  weight: number,
  hasCameraColor: boolean
): void {
  voxel.x += (points[offset] ?? 0) * weight;
  voxel.y += (points[offset + 1] ?? 0) * weight;
  voxel.z += (points[offset + 2] ?? 0) * weight;
  voxel.radius += (points[offset + 3] ?? 1) * weight;
  voxel.weight += weight;
  voxel.count += 1;
  const normalConfidence = clamp(points[offset + 11] ?? 0, 0, 1);
  const normalWeight = weight * normalConfidence;
  voxel.nx += (points[offset + 8] ?? 0) * normalWeight;
  voxel.ny += (points[offset + 9] ?? 0) * normalWeight;
  voxel.nz += (points[offset + 10] ?? 0) * normalWeight;
  voxel.normalWeight += normalWeight;
  if (normalConfidence >= 1) {
    voxel.normalEstimatedWeight += normalWeight;
  }
  const r = (points[offset + 4] ?? 0) * weight;
  const g = (points[offset + 5] ?? 0) * weight;
  const b = (points[offset + 6] ?? 0) * weight;
  if (hasCameraColor) {
    voxel.cameraR += r;
    voxel.cameraG += g;
    voxel.cameraB += b;
    voxel.cameraWeight += weight;
  } else {
    voxel.fallbackR += r;
    voxel.fallbackG += g;
    voxel.fallbackB += b;
    voxel.fallbackWeight += weight;
  }
}

function voxelKey(x: number, y: number, z: number): string {
  return [
    Math.floor(x / VOXEL_SIZE_M),
    Math.floor(y / VOXEL_SIZE_M),
    Math.floor(z / VOXEL_SIZE_M),
  ].join(',');
}

export function buildModel(points: number[], keyframes: number): CaptureModel | null {
  const fusion = createSurfelFusionAccumulator();
  appendSurfelsToFusion(fusion, points);
  return buildModelFromFusion(fusion, keyframes);
}

export function buildModelFromFusion(fusion: SurfelFusionAccumulator, keyframes: number): CaptureModel | null {
  const buildStart = performanceNow();
  const rawSampleCount = fusion.rawSampleCount;
  if (rawSampleCount <= 0) return null;
  const fused = [...fusion.voxels.values()];
  const surfelCount = fused.length;
  if (surfelCount <= 0) return null;
  const surfels = new Float32Array(surfelCount * SURFEL_STRIDE_FLOATS);
  const boundsMin: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const boundsMax: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let fusedCameraColoredSurfels = 0;
  let normalEstimatedSurfels = 0;
  for (let index = 0; index < fused.length; index += 1) {
    const voxel = fused[index];
    if (!voxel) continue;
    const invWeight = 1 / Math.max(voxel.weight, 1e-6);
    const x = voxel.x * invWeight;
    const y = voxel.y * invWeight;
    const z = voxel.z * invWeight;
    const radius = clamp(voxel.radius * invWeight, 0.45, 2.6);
    const normal = voxel.normalWeight > 0
      ? normalize([voxel.nx / voxel.normalWeight, voxel.ny / voxel.normalWeight, voxel.nz / voxel.normalWeight])
      : [0, 1, 0] as Vec3;
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
    surfels[offset + 8] = normal[0];
    surfels[offset + 9] = normal[1];
    surfels[offset + 10] = normal[2];
    surfels[offset + 11] = voxel.count;
    if (hasCameraColor) fusedCameraColoredSurfels += 1;
    if (voxel.normalEstimatedWeight > 0) normalEstimatedSurfels += 1;
    boundsMin[0] = Math.min(boundsMin[0], x);
    boundsMin[1] = Math.min(boundsMin[1], y);
    boundsMin[2] = Math.min(boundsMin[2], z);
    boundsMax[0] = Math.max(boundsMax[0], x);
    boundsMax[1] = Math.max(boundsMax[1], y);
    boundsMax[2] = Math.max(boundsMax[2], z);
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
    colorSource,
    keyframes,
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
  return `model: ${model.keyframes} keyframes - ${model.surfelCount} surfels from ${model.rawSampleCount} samples - ${model.normalEstimatedSurfels} normals - ${model.colorSource} color - ${size
    .map((value) => `${Math.max(0, value).toFixed(1)}m`)
    .join(' x ')}`;
}

export function formatQualityInfo(model: CaptureModel): string {
  return [
    `quality: fused ${formatPercent(model.surfelCount / Math.max(model.rawSampleCount, 1))}`,
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
    `comment color_source ${model.colorSource}`,
    `comment camera_colored_surfels ${model.cameraColoredSurfels}`,
    `comment estimated_normal_surfels ${model.normalEstimatedSurfels}`,
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
  const cameraPoint = transformNormalizedPoint(normCameraImageFromNormView, viewX, viewY);
  if (!Number.isFinite(cameraPoint.x) || !Number.isFinite(cameraPoint.y)) return null;
  if (cameraPoint.x < 0 || cameraPoint.x > 1 || cameraPoint.y < 0 || cameraPoint.y > 1) return null;
  const px = Math.round(cameraPoint.x * Math.max(0, camera.width - 1));
  const py = Math.round(cameraPoint.y * Math.max(0, camera.height - 1));
  const offset = (py * camera.width + px) * 4;
  if (offset < 0 || offset + 2 >= bytes.length) return null;
  if (camera.format === 'bgra8unorm') {
    return [
      (bytes[offset + 2] ?? 0) / 255,
      (bytes[offset + 1] ?? 0) / 255,
      (bytes[offset] ?? 0) / 255,
    ];
  }
  return [
    (bytes[offset] ?? 0) / 255,
    (bytes[offset + 1] ?? 0) / 255,
    (bytes[offset + 2] ?? 0) / 255,
  ];
}

export function unprojectViewSample(
  inverseProjection: Float32Array,
  viewX: number,
  viewY: number,
  depthMeters: number
): Vec3 {
  const ndcX = viewX * 2 - 1;
  const ndcY = 1 - viewY * 2;
  const near = transformClipPoint(inverseProjection, [ndcX, ndcY, -1, 1]);
  const z = near[2] === 0 ? -1 : near[2];
  const scale = -depthMeters / z;
  return [near[0] * scale, near[1] * scale, -depthMeters];
}

function transformClipPoint(matrix: Float32Array, point: [number, number, number, number]): Vec3 {
  const x = matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12] * point[3];
  const y = matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13] * point[3];
  const z = matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14] * point[3];
  const w = matrix[3] * point[0] + matrix[7] * point[1] + matrix[11] * point[2] + matrix[15] * point[3];
  const invW = w === 0 ? 1 : 1 / w;
  return [x * invW, y * invW, z * invW];
}

export function transformPoint(matrix: Float32Array, point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

function transformDirection(matrix: Float32Array, point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2],
  ];
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
  const t = clamp01((depthMeters - MIN_DEPTH_M) / (MAX_DEPTH_M - MIN_DEPTH_M));
  const near: Vec3 = [1.0, 0.42, 0.14];
  const mid: Vec3 = [0.1, 0.86, 0.72];
  const far: Vec3 = [0.25, 0.34, 1.0];
  return t < 0.55
    ? mixVec3(near, mid, smoothstep(0, 0.55, t))
    : mixVec3(mid, far, smoothstep(0.48, 1, t));
}

export function makeModelViewProjection(
  model: CaptureModel | null,
  aspect: number,
  orbit: number,
  viewer: ViewerState
): Float32Array {
  if (!model) {
    return mat4Multiply(perspective(Math.PI / 3.1, aspect, 0.01, 100), lookAt([0, 0.4, 3.4], [0, 0, 0], [0, 1, 0]));
  }
  const modelCenter: Vec3 = [
    (model.boundsMin[0] + model.boundsMax[0]) / 2,
    (model.boundsMin[1] + model.boundsMax[1]) / 2,
    (model.boundsMin[2] + model.boundsMax[2]) / 2,
  ];
  const span: Vec3 = [
    Math.max(0.1, model.boundsMax[0] - model.boundsMin[0]),
    Math.max(0.1, model.boundsMax[1] - model.boundsMin[1]),
    Math.max(0.1, model.boundsMax[2] - model.boundsMin[2]),
  ];
  const radius = Math.max(1.2, Math.hypot(span[0], span[1], span[2]) * 0.72) * viewer.distanceScale;
  const yaw = orbit + viewer.yaw;
  const horizontalRadius = Math.cos(viewer.pitch) * radius;
  const baseEye: Vec3 = [
    modelCenter[0] + Math.sin(yaw) * horizontalRadius,
    modelCenter[1] + Math.sin(viewer.pitch) * radius,
    modelCenter[2] + Math.cos(yaw) * horizontalRadius,
  ];
  const forward = normalize(subtract(modelCenter, baseEye));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  const panOffset = addVec3(
    scaleVec3(right, viewer.panX * radius),
    scaleVec3(up, viewer.panY * radius)
  );
  const center = addVec3(modelCenter, panOffset);
  const eye = addVec3(baseEye, panOffset);
  return mat4Multiply(perspective(Math.PI / 3.0, aspect, 0.01, Math.max(20, radius * 8)), lookAt(eye, center, [0, 1, 0]));
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

function observationFacingNormal(cameraToWorld: Float32Array, cameraPoint: Vec3): Vec3 {
  const pointToCamera = normalize([-cameraPoint[0], -cameraPoint[1], -cameraPoint[2]]);
  return normalize(transformDirection(cameraToWorld, pointToCamera));
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
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length <= 1e-6) return [0, 0, 1];
  return [v[0] / length, v[1] / length, v[2] / length];
}

function mixVec3(a: Vec3, b: Vec3, amount: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ];
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
