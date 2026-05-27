import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as React from 'react';
import { PanResponder, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';
import type { NativeStackHeaderItem } from 'expo-router/build/react-navigation/native-stack';
import type { SFSymbol } from 'sf-symbols-typescript';

import {
  Button as UIButton,
  HStack,
  Host,
  Image as UIImage,
  Picker,
  Text as UIText,
  VStack,
  buttonStyle,
  controlSize,
  disabled as disabledModifier,
  foregroundColor,
  frame,
  pickerStyle,
  tag,
  tint,
} from '@/components/demo-platform-controls';
import { DemoPageFrame } from '@/components/demo-page-frame';
import { useCamera } from '@/contexts/CameraContext';
import { configureWebGpuCanvas } from '@/lib/webgpu-canvas';
import {
  appendDepthSurfelsToFusion,
  appendMeshSurfelsToFusion,
  buildModelFromFusion,
  canReusePanoramicModelSnapshot,
  clamp,
  createSurfelFusionAccumulator,
  derivePanoramicCaptureControls,
  extractForward,
  extractPosition,
  formatFilesLocation,
  formatModelInfo,
  formatQualityInfo,
  makeModelViewProjectionInto,
  MAX_KEYFRAMES,
  MAX_SURFELS,
  MIN_KEYFRAME_NEW_VOXELS,
  MIN_KEYFRAME_SURFELS,
  MESH_SURFEL_SAMPLE_BUDGET,
  modelSurfelPointScalePx,
  nextSurfelBufferCapacityBytes,
  observedDepthSurfelCount,
  panoramicCoverageKey,
  panoramicCoveragePercent,
  panoramicCoverageSectors,
  panoramicDepthPreferenceFromSearchParam,
  panoramicDepthTypeRequestForPreference,
  performanceNow,
  preflightMeshSurfelsForFusion,
  serializeModelAsPly,
  shouldAcceptPanoramicKeyframe,
  shouldPublishLiveModelSnapshot,
  shouldRequestPanoramicMeshDetection,
  shouldSkipCoveredPanoramicSector,
  summarizeCaptureGeometry,
  SURFEL_STRIDE_BYTES,
  viewerYawForForward,
  xrScanFrameStopReason,
  type AppendDepthSurfelsProfile,
  type AppendDepthSurfelsResult,
  type AppendMeshSurfelsProfile,
  type CaptureModel,
  type KeyframeAcceptanceDecision,
  type LiveModelSnapshotPublishDecision,
  type MeshSurfelPreflightResult,
  type KeyframeSnapshot,
  type PanoramicDepthPreference,
  type PanoramicCaptureStatus,
  type SurfelFusionAccumulator,
  type Vec3,
  type ViewerState,
} from '@/lib/panoramic-scene-model';
import {
  installWebXRDepthProfile,
  runWithWebXRUserActivation,
  WebXRCPUCameraBinding,
  type WebXRCPUDepthInformation,
  type WebXRCPUCameraImage,
  type WebXRFrame,
  type WebXRMesh,
  type WebXRMeshSet,
  type WebXRReferenceSpace,
  type WebXRSession,
} from '../../../../modules/standard-camera';

// @ref LLP 0020#reconstruction-pipeline - Panoramic capture uses only
// WebXR-shaped depth, pose, camera-image, and optional mesh-detection access:
// no app-facing native AR APIs. The captured model is currently a camera-colored
// surfel cloud rendered with WebGPU.

const QUAD_VERTEX_COUNT = 6;
const COMMAND_BUTTON_GAP = 8;
const COMMAND_BUTTON_HEIGHT = 38;
const COMMAND_BUTTON_NATIVE_CHROME_WIDTH = 36;
const GESTURE_RENDER_PROFILE_INTERVAL_MS = 500;
const KEYFRAME_REJECTION_PROFILE_INTERVAL_MS = 1000;
const MESH_PROFILE_INTERVAL_MS = 2000;
const MESH_SUPPLEMENT_REFRESH_KEYFRAMES = 4;
const SCAN_STATS_PROFILE_INTERVAL_MS = 2000;
const MODEL_VIEW_MODES = [
  { label: 'Color', value: 0 },
  { label: 'Depth', value: 1 },
  { label: 'Normals', value: 2 },
] as const;
// @ref LLP 0020#v2-arkit-mesh-snapshot - Mesh supplement refresh uses
// standard XRMesh object identity plus `lastChangedTime`; native anchor IDs
// remain hidden inside the WebXR runtime.
const meshIdentitySerials = new WeakMap<WebXRMesh, number>();
let nextMeshIdentitySerial = 1;

type ModelViewMode = (typeof MODEL_VIEW_MODES)[number]['value'];

interface PreviewModelBuildResult {
  buildMs: number;
  model: CaptureModel | null;
  reusedModel: boolean;
}

interface RenderFrameProfile {
  commandEncodeMs: number;
  renderFrameMs: number;
  submitPresentMs: number;
}

interface ScanStats {
  acceptedKeyframes: number;
  depthInfoMsTotal: number;
  depthInfoRequests: number;
  depthMisses: number;
  depthPrecheckSkips: number;
  frameCount: number;
  livePublishMsTotal: number;
  maxAppendMs: number;
  poseMisses: number;
  poseMsTotal: number;
  rejectedByReason: Record<string, number>;
  startedAtMs: number;
  totalAppendMs: number;
  totalFusionMs: number;
  totalNewVoxelCount: number;
  totalUpdatedVoxelCount: number;
}

interface PoseKeyframePrecheck {
  decision: KeyframeAcceptanceDecision;
  forward: Vec3;
  position: Vec3;
  preSampleMs: number;
}

const CAPTURE_MODEL_SHADER = /* wgsl */ `
struct Uniforms {
  viewProjection: mat4x4f,
  pointScale: vec2f,
  time: f32,
  displayMode: f32,
};

struct VsIn {
  @location(0) positionRadius: vec4f,
  @location(1) colorWeight: vec4f,
  @location(2) normalCount: vec4f,
};

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) local: vec2f,
  @location(2) normal: vec3f,
  @location(3) distanceMeters: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

fn quadCorner(i: u32) -> vec2f {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0),
  );
  return corners[i];
}

@vertex
fn vs_main(in: VsIn, @builtin(vertex_index) vertexIndex: u32) -> VsOut {
  let corner = quadCorner(vertexIndex);
  var clip = u.viewProjection * vec4f(in.positionRadius.xyz, 1.0);
  let observationScale = mix(0.55, 1.0, clamp((in.normalCount.w - 1.0) * 0.5, 0.0, 1.0));
  let radiusScale = clamp(in.positionRadius.w * observationScale, 0.18, 1.35);
  let clipOffset = corner * u.pointScale * radiusScale * clip.w;
  clip = vec4f(clip.x + clipOffset.x, clip.y + clipOffset.y, clip.z, clip.w);

  var out: VsOut;
  out.position = clip;
  out.color = vec4f(in.colorWeight.rgb, 1.0);
  out.local = corner;
  out.normal = normalize(in.normalCount.xyz);
  out.distanceMeters = length(in.positionRadius.xyz);
  return out;
}

fn depthRamp(t: f32) -> vec3f {
  let near = vec3f(1.0, 0.42, 0.14);
  let mid = vec3f(0.1, 0.86, 0.72);
  let far = vec3f(0.25, 0.34, 1.0);
  if (t < 0.55) {
    return mix(near, mid, smoothstep(0.0, 0.55, t));
  }
  return mix(mid, far, smoothstep(0.48, 1.0, t));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let d = dot(in.local, in.local);
  if (d > 1.0) {
    discard;
  }
  let alpha = smoothstep(1.0, 0.55, d);
  let visibleColor = max(in.color.rgb, vec3f(0.09, 0.11, 0.14));
  var rgb = visibleColor;
  if (u.displayMode > 1.5) {
    rgb = normalize(in.normal) * 0.5 + vec3f(0.5);
  } else if (u.displayMode > 0.5) {
    let t = clamp((in.distanceMeters - 0.35) / 4.45, 0.0, 1.0);
    rgb = depthRamp(t);
  } else {
    rgb = visibleColor * (0.92 + 0.08 * alpha);
  }
  return vec4f(rgb, 1.0);
}
`;

const DEFAULT_VIEWER_STATE: ViewerState = {
  distanceScale: 1,
  panX: 0,
  panY: 0,
  pitch: 0.34,
  yaw: 0,
};

export default function PanoramicSceneCaptureScreen(): React.JSX.Element {
  const ref = useCanvasRef();
  const { adapter, device } = useDevice();
  const { lidarError, lidarStatus } = useCamera();
  const { autorun, depth, mesh } = useLocalSearchParams<{
    autorun?: string;
    depth?: string;
    mesh?: string;
  }>();
  const depthPreference = React.useMemo(
    () => panoramicDepthPreferenceFromSearchParam(depth),
    [depth]
  );
  const depthTypeRequest = React.useMemo(
    () => panoramicDepthTypeRequestForPreference(depthPreference),
    [depthPreference]
  );
  const meshDetectionRequested = React.useMemo(
    () => shouldRequestPanoramicMeshDetection(mesh),
    [mesh]
  );
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const sessionRef = React.useRef<WebXRSession | null>(null);
  const xrRafRef = React.useRef<number | null>(null);
  const didAutorunRef = React.useRef(false);
  const fusionRef = React.useRef<SurfelFusionAccumulator>(createSurfelFusionAccumulator());
  const coverageSectorsRef = React.useRef<Set<string>>(new Set());
  const captureInFlightRef = React.useRef(false);
  const previewBuildInFlightRef = React.useRef(false);
  const keyframeRef = React.useRef<KeyframeSnapshot | null>(null);
  const keyframeCountRef = React.useRef(0);
  const scanForwardSumRef = React.useRef<Vec3>([0, 0, 0]);
  const scanForwardSamplesRef = React.useRef<Vec3[]>([]);
  const scanStatsRef = React.useRef<ScanStats>(createScanStats());
  const lastLiveModelBuildDurationMsRef = React.useRef(0);
  const lastLiveModelKeyframesRef = React.useRef(0);
  const lastLiveModelPublishedAtMsRef = React.useRef(0);
  const lastLiveModelRawSampleCountRef = React.useRef(0);
  const lastMeshProfileLoggedAtMsRef = React.useRef(0);
  const lastMeshSupplementCheckKeyframeRef = React.useRef(0);
  const lastMeshSupplementKeyframeRef = React.useRef(0);
  const lastMeshSupplementSignatureRef = React.useRef<string | null>(null);
  const lastKeyframeRejectionProfileLoggedAtMsRef = React.useRef(0);
  const lastScanStatsLoggedAtMsRef = React.useRef(0);
  const modelRef = React.useRef<CaptureModel | null>(null);
  const modelRevisionRef = React.useRef(0);
  const modelViewModeRef = React.useRef<ModelViewMode>(0);
  const renderDirtyRef = React.useRef(true);
  const requestRenderRef = React.useRef<(() => void) | null>(null);
  const lastGestureRenderProfileLoggedAtMsRef = React.useRef(0);
  const statusRef = React.useRef<PanoramicCaptureStatus>('checking');
  // Accepted raw samples are bounded by MAX_SURFELS; displayed/model surfels
  // are the fused voxel count in fusionRef.current.voxels.
  const surfelCountRef = React.useRef(0);
  const supportCheckedRef = React.useRef(false);
  const viewerGestureActiveRef = React.useRef(false);
  const viewerManuallyAdjustedRef = React.useRef(false);
  const viewerRef = React.useRef<ViewerState>(DEFAULT_VIEWER_STATE);
  const viewerGestureStartRef = React.useRef<ViewerState>(DEFAULT_VIEWER_STATE);
  const pinchDistanceStartRef = React.useRef<number | null>(null);
  const panMidpointStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const singleTouchStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const [session, setSession] = React.useState<WebXRSession | null>(null);
  const [status, setStatus] = React.useState<PanoramicCaptureStatus>('checking');
  const [support, setSupport] = React.useState('checking WebXR camera/depth support');
  const [error, setError] = React.useState<string | null>(null);
  const [model, setModel] = React.useState<CaptureModel | null>(null);
  const [modelViewMode, setModelViewMode] = React.useState<ModelViewMode>(0);
  const [frameInfo, setFrameInfo] = React.useState('waiting for depth frames');
  const [modelInfo, setModelInfo] = React.useState('no capture yet');
  const [qualityInfo, setQualityInfo] = React.useState('quality: no capture yet');
  const [liveSurfelCount, setLiveSurfelCount] = React.useState(0);
  const [coveragePercent, setCoveragePercent] = React.useState(0);
  const [saveInfo, setSaveInfo] = React.useState('save after capture');
  const [saving, setSaving] = React.useState(false);
  const [fps, setFps] = React.useState('0.0');
  const [stageGestureActive, setStageGestureActive] = React.useState(false);

  const isDesktop = windowWidth >= 1040;
  const stageWidth = isDesktop
    ? Math.max(360, Math.min(windowWidth - 448, 980, Math.max(360, windowHeight - 190) * 4 / 3))
    : Math.min(Math.max(288, windowWidth - 32), 430);
  const stageHeight = Math.round(isDesktop ? stageWidth * 3 / 4 : stageWidth * 4 / 3);
  const commandButtonWidth = Math.floor((stageWidth - COMMAND_BUTTON_GAP) / 2);

  React.useEffect(() => {
    modelViewModeRef.current = modelViewMode;
    renderDirtyRef.current = true;
    requestRenderRef.current?.();
  }, [modelViewMode]);

  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);

  function setCaptureStatus(
    nextStatus: PanoramicCaptureStatus | ((current: PanoramicCaptureStatus) => PanoramicCaptureStatus)
  ): void {
    if (typeof nextStatus === 'function') {
      statusRef.current = nextStatus(statusRef.current);
      setStatus((current) => {
        const resolvedStatus = nextStatus(current);
        statusRef.current = resolvedStatus;
        return resolvedStatus;
      });
      return;
    }
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }

  const setViewerState = React.useCallback((nextViewer: ViewerState): void => {
    // @ref LLP 0020#model-view - WebGPU reads the viewer from a ref each
    // frame; drag updates avoid React state so touch rotation stays responsive.
    viewerRef.current = nextViewer;
    renderDirtyRef.current = true;
    requestRenderRef.current?.();
  }, []);

  const beginTwoFingerViewerGesture = React.useCallback((
    touches: readonly { pageX: number; pageY: number }[]
  ): void => {
    viewerGestureStartRef.current = viewerRef.current;
    pinchDistanceStartRef.current = touchDistance(touches);
    panMidpointStartRef.current = touchMidpoint(touches);
    singleTouchStartRef.current = null;
  }, []);

  const endViewerGesture = React.useCallback((): void => {
    viewerGestureActiveRef.current = false;
    pinchDistanceStartRef.current = null;
    panMidpointStartRef.current = null;
    singleTouchStartRef.current = null;
    setStageGestureActive(false);
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- Preserve the existing support-check initialization timing. */
  React.useEffect(() => {
    if (supportCheckedRef.current) return;
    supportCheckedRef.current = true;
    installWebXRDepthProfile();
    const xr = navigator.xr;
    if (!xr) {
      setSupport('WebXR camera/depth unavailable here');
      setCaptureStatus('unsupported');
      return;
    }
    void xr.isSessionSupported('immersive-ar')
      .then((supported) => {
        setSupport(supported ? 'immersive-ar camera/depth available' : 'WebXR camera/depth unavailable here');
        setCaptureStatus(supported ? 'idle' : 'unsupported');
      })
      .catch((e) => {
        setSupport('WebXR camera/depth check failed');
        setCaptureStatus('error');
        setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      });
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  React.useEffect(() => {
    return () => {
      cancelXRLoop();
      void sessionRef.current?.end();
      sessionRef.current = null;
    };
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      return () => {
        cancelXRLoop();
        void sessionRef.current?.end();
      };
    }, [])
  );

  function resetCapture(): void {
    fusionRef.current = createSurfelFusionAccumulator();
    coverageSectorsRef.current = new Set();
    keyframeRef.current = null;
    keyframeCountRef.current = 0;
    scanForwardSumRef.current = [0, 0, 0];
    scanForwardSamplesRef.current = [];
    scanStatsRef.current = createScanStats();
    lastScanStatsLoggedAtMsRef.current = scanStatsRef.current.startedAtMs;
    lastLiveModelBuildDurationMsRef.current = 0;
    lastLiveModelKeyframesRef.current = 0;
    lastLiveModelPublishedAtMsRef.current = 0;
    lastLiveModelRawSampleCountRef.current = 0;
    lastMeshProfileLoggedAtMsRef.current = 0;
    lastMeshSupplementCheckKeyframeRef.current = 0;
    lastMeshSupplementKeyframeRef.current = 0;
    lastMeshSupplementSignatureRef.current = null;
    lastKeyframeRejectionProfileLoggedAtMsRef.current = 0;
    lastGestureRenderProfileLoggedAtMsRef.current = 0;
    surfelCountRef.current = 0;
    modelViewModeRef.current = 0;
    viewerGestureActiveRef.current = false;
    viewerManuallyAdjustedRef.current = false;
    publishModel(null);
    setModelViewMode(0);
    setViewerState(DEFAULT_VIEWER_STATE);
    setFrameInfo('waiting for depth frames');
    setModelInfo('no capture yet');
    setQualityInfo('quality: no capture yet');
    setLiveSurfelCount(0);
    setCoveragePercent(0);
    setSaveInfo('save after capture');
    setError(null);
    if (!sessionRef.current) {
      setCaptureStatus((current) => (current === 'unsupported' ? current : 'idle'));
    }
  }

  function resetViewer(): void {
    const nextViewer = recenteredViewerState();
    viewerManuallyAdjustedRef.current = false;
    viewerGestureStartRef.current = nextViewer;
    pinchDistanceStartRef.current = null;
    panMidpointStartRef.current = null;
    singleTouchStartRef.current = null;
    setViewerState(nextViewer);
  }

  function addScanForward(forward: Vec3): void {
    const current = scanForwardSumRef.current;
    scanForwardSumRef.current = [
      current[0] + forward[0],
      current[1] + forward[1],
      current[2] + forward[2],
    ];
    // @ref LLP 0020#model-view - Recompute 180-degree coverage around the
    // accepted scan arc so the hint follows partial sweeps in AR world space.
    scanForwardSamplesRef.current = [...scanForwardSamplesRef.current, forward];
    coverageSectorsRef.current = panoramicCoverageSectors(scanForwardSamplesRef.current);
  }

  function recenteredViewerState(): ViewerState {
    return {
      ...DEFAULT_VIEWER_STATE,
      yaw: viewerYawForForward(scanForwardSumRef.current),
    };
  }

  function recordScanRejection(reason: string | null): void {
    const key = reason ?? 'unknown';
    const rejected = scanStatsRef.current.rejectedByReason;
    rejected[key] = (rejected[key] ?? 0) + 1;
  }

  function maybeLogKeyframeRejectionProfile(
    reason: string | null,
    fields: Record<string, unknown> = {}
  ): void {
    const now = performanceNow();
    if (
      lastKeyframeRejectionProfileLoggedAtMsRef.current > 0 &&
      now - lastKeyframeRejectionProfileLoggedAtMsRef.current < KEYFRAME_REJECTION_PROFILE_INTERVAL_MS
    ) {
      return;
    }
    lastKeyframeRejectionProfileLoggedAtMsRef.current = now;
    const stats = scanStatsRef.current;
    // @ref LLP 0020#testing-and-validation - Rejection profiles explain why a
    // physical scan can appear to capture no surfels even though the XR loop is
    // running, without forcing CPU depth/camera work on pose-only rejects.
    console.log('PANORAMIC_KEYFRAME_REJECTION_PROFILE', JSON.stringify({
      coveragePercent: roundMetric(panoramicCoveragePercent(coverageSectorsRef.current), 1),
      depthInfoRequests: stats.depthInfoRequests,
      depthMisses: stats.depthMisses,
      depthPrecheckSkips: stats.depthPrecheckSkips,
      depthType: sessionRef.current?.depthType ?? null,
      frameCount: stats.frameCount,
      fusedSurfelCount: fusionRef.current.voxels.size,
      keyframes: keyframeCountRef.current,
      rawSampleCount: fusionRef.current.rawSampleCount,
      reason: reason ?? 'unknown',
      retainedSamples: surfelCountRef.current,
      status: statusRef.current,
      ...fields,
    }));
  }

  function logScanStats(reason: string): void {
    const stats = scanStatsRef.current;
    const now = performanceNow();
    const elapsedMs = now - stats.startedAtMs;
    lastScanStatsLoggedAtMsRef.current = now;
    console.log('PANORAMIC_SCAN_STATS', JSON.stringify({
      acceptedKeyframes: stats.acceptedKeyframes,
      acceptedKeyframeFps: roundMetric(1000 * stats.acceptedKeyframes / Math.max(elapsedMs, 1), 2),
      avgAppendMs: roundMetric(stats.totalAppendMs / Math.max(stats.acceptedKeyframes, 1)),
      avgDepthInfoMs: roundMetric(stats.depthInfoMsTotal / Math.max(stats.depthInfoRequests, 1)),
      avgFusionMs: roundMetric(stats.totalFusionMs / Math.max(stats.acceptedKeyframes, 1)),
      avgLivePublishMs: roundMetric(stats.livePublishMsTotal / Math.max(stats.acceptedKeyframes, 1)),
      avgPoseMs: roundMetric(stats.poseMsTotal / Math.max(stats.frameCount, 1)),
      coveragePercent: roundMetric(panoramicCoveragePercent(coverageSectorsRef.current), 1),
      depthPreference,
      depthInfoRequests: stats.depthInfoRequests,
      depthMisses: stats.depthMisses,
      depthPrecheckSkips: stats.depthPrecheckSkips,
      elapsedMs: roundMetric(elapsedMs),
      frameCount: stats.frameCount,
      fusedSurfelCount: fusionRef.current.voxels.size,
      maxAppendMs: roundMetric(stats.maxAppendMs),
      meshRequested: meshDetectionRequested,
      newVoxelCount: stats.totalNewVoxelCount,
      newVoxelPercent: roundMetric(
        100 * stats.totalNewVoxelCount / Math.max(stats.totalNewVoxelCount + stats.totalUpdatedVoxelCount, 1),
        1
      ),
      poseMisses: stats.poseMisses,
      reason,
      rejectedByReason: stats.rejectedByReason,
      rawSampleCount: fusionRef.current.rawSampleCount,
      retainedSamples: surfelCountRef.current,
      scanFps: roundMetric(1000 * stats.frameCount / Math.max(elapsedMs, 1), 1),
      updatedVoxelCount: stats.totalUpdatedVoxelCount,
    }));
  }

  function logXRScanLoopStopProfile(reason: string, session: WebXRSession): void {
    const stats = scanStatsRef.current;
    // @ref LLP 0020#testing-and-validation - If recursive XR frame scheduling
    // stops after a first keyframe, logs need to show whether the app stopped
    // intentionally or the session/status guard rejected the next frame.
    console.log('PANORAMIC_XR_SCAN_LOOP_STOP_PROFILE', JSON.stringify({
      acceptedKeyframes: stats.acceptedKeyframes,
      captureInFlight: captureInFlightRef.current,
      depthMisses: stats.depthMisses,
      frameCount: stats.frameCount,
      fusedSurfelCount: fusionRef.current.voxels.size,
      keyframes: keyframeCountRef.current,
      poseMisses: stats.poseMisses,
      rawSampleCount: fusionRef.current.rawSampleCount,
      reason,
      retainedSamples: surfelCountRef.current,
      sessionEnded: session.ended,
      sessionMatches: sessionRef.current === session,
      status: statusRef.current,
    }));
  }

  function logScanConfig(
    session: WebXRSession,
    requestedDepthPreference: PanoramicDepthPreference,
    requestedDepthTypes: readonly string[],
    requestedMesh: boolean
  ): void {
    // @ref LLP 0020#testing-and-validation - Physical profile-only runs can
    // force raw depth or disable mesh detection to isolate whether a one-frame
    // scan is caused by ARKit scene-depth smoothing, mesh reconstruction, or the
    // JS keyframe gates.
    console.log('PANORAMIC_SCAN_CONFIG', JSON.stringify({
      depthPreference: requestedDepthPreference,
      depthTypeRequest: requestedDepthTypes,
      meshRequested: requestedMesh,
      sessionDepthType: session.depthType ?? null,
    }));
  }

  function maybeLogPeriodicScanStats(): void {
    const now = performanceNow();
    if (now - lastScanStatsLoggedAtMsRef.current < SCAN_STATS_PROFILE_INTERVAL_MS) {
      return;
    }
    // @ref LLP 0020#testing-and-validation - Profile-only physical runs need
    // scan-loop telemetry even when no keyframes are accepted yet, so pose/depth
    // misses and rejection reasons are visible without waiting for Capture.
    logScanStats('periodic');
  }

  function maybeLogMeshProfile(frame: WebXRFrame): void {
    const now = performanceNow();
    if (now - lastMeshProfileLoggedAtMsRef.current < MESH_PROFILE_INTERVAL_MS) {
      return;
    }
    const detectedMeshes = frame.detectedMeshes;
    const meshCount = detectedMeshes.size;
    lastMeshProfileLoggedAtMsRef.current = now;
    let latestChangedTime = 0;
    for (const mesh of detectedMeshes) {
      latestChangedTime = Math.max(latestChangedTime, mesh.lastChangedTime);
    }
    // @ref LLP 0020#v2-arkit-mesh-snapshot - Mesh telemetry lets physical-device logs
    // show whether the WebXR mesh-backed surfel path has enough geometry to
    // improve scan quality on the real device. It stays on
    // `XRFrame.detectedMeshes` summary fields so periodic rejected frames do
    // not force full mesh-buffer marshaling.
    console.log('PANORAMIC_MESH_PROFILE', JSON.stringify({
      frameTimeMs: roundMetric(frame.predictedDisplayTime),
      lastChangedTime: roundMetric(latestChangedTime),
      meshCount,
      normalCount: 0,
    }));
  }

  async function startSession(): Promise<void> {
    if (sessionRef.current) return;
    const preserveCapturedModel = statusRef.current === 'captured' && modelRef.current !== null;
    installWebXRDepthProfile();
    setError(null);
    setCaptureStatus('requesting');
    try {
      const xr = navigator.xr;
      if (!xr) {
        setSupport('WebXR camera/depth unavailable here');
        setCaptureStatus(preserveCapturedModel ? 'captured' : 'unsupported');
        return;
      }
      const supported = await xr.isSessionSupported('immersive-ar');
      if (!supported) {
        setSupport('WebXR camera/depth unavailable here');
        setCaptureStatus(preserveCapturedModel ? 'captured' : 'unsupported');
        return;
      }
      const nextSession = await runWithWebXRUserActivation(() =>
        xr.requestSession('immersive-ar', {
          requiredFeatures: ['depth-sensing', 'camera-access'],
          optionalFeatures: meshDetectionRequested ? ['mesh-detection'] : [],
          depthSensing: {
            usagePreference: ['cpu-optimized'],
            dataFormatPreference: ['float32'],
            // @ref LLP 0020#webxr-depth-geometry-unprojection - The panorama
            // is a deliberate slow 180-degree sweep; normal runs prefer WebXR
            // smoothed depth, while profile-only deep links can force raw first
            // to isolate ARKit scene-depth starvation from smoothing.
            depthTypeRequest: [...depthTypeRequest],
            matchDepthView: true,
          },
          cameraAccess: {
            usagePreference: ['cpu-optimized'],
            formatPreference: ['bgra8unorm', 'rgba8unorm'],
            matchCameraView: true,
          },
        })
      );
      resetCapture();
      sessionRef.current = nextSession;
      logScanConfig(nextSession, depthPreference, depthTypeRequest, meshDetectionRequested);
      setSession(nextSession);
      setCaptureStatus('scanning');
      setFrameInfo(`depth: ${nextSession.depthType ?? 'none'} - waiting for depth frames`);
      nextSession.addEventListener('end', () => {
        if (sessionRef.current === nextSession) {
          sessionRef.current = null;
          setSession(null);
          setCaptureStatus((current) => (current === 'captured' ? current : 'idle'));
        }
      });
      startXRLoopSafely(nextSession);
    } catch (e) {
      sessionRef.current = null;
      setSession(null);
      setCaptureStatus(preserveCapturedModel ? 'captured' : 'error');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  React.useEffect(() => {
    if (autorun !== '1' || didAutorunRef.current || status !== 'idle') return;
    didAutorunRef.current = true;
    void startSession();
  }, [autorun, status]);

  async function stopSession(): Promise<void> {
    const current = sessionRef.current;
    if (!current) return;
    setCaptureStatus('ending');
    cancelXRLoop();
    if (scanStatsRef.current.frameCount > 0) {
      logScanStats('stop');
    }
    try {
      await current.end();
      sessionRef.current = null;
      setSession(null);
      setCaptureStatus('idle');
    } catch (e) {
      setCaptureStatus('error');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  async function captureModel(): Promise<void> {
    if (captureInFlightRef.current || previewBuildInFlightRef.current) return;
    captureInFlightRef.current = true;
    const captureSession = sessionRef.current;
    cancelXRLoop();
    setError(null);
    setCaptureStatus('building-model');
    setModelInfo('building captured model');
    try {
      await nextAnimationFrame();
      const previewBuild = buildPreviewModel();
      const nextModel = previewBuild.model;
      if (!nextModel || nextModel.surfelCount === 0) {
        if (captureSession && sessionRef.current === captureSession) {
          startXRLoopSafely(captureSession);
        }
        setCaptureStatus(captureSession && sessionRef.current === captureSession ? 'scanning' : 'idle');
        setError('No valid depth samples have been captured yet.');
        return;
      }
      publishModel(nextModel, { recenter: !viewerManuallyAdjustedRef.current });
      setModelInfo(formatModelInfo(nextModel));
      setQualityInfo(formatQualityInfo(nextModel));
      logCaptureMetrics(nextModel, previewBuild);
      logCaptureGeometryMetrics(nextModel, scanForwardSumRef.current);
      logScanStats('capture');
      setSaveInfo('ready to save .ply');
      statusRef.current = 'captured';
      setCaptureStatus('captured');
      requestRenderRef.current?.();
      try {
        await stopActiveSession();
      } catch (stopError) {
        setError(
          `Capture succeeded, but ending the XR session failed. ${
            stopError instanceof Error ? `${stopError.name}: ${stopError.message}` : String(stopError)
          }`
        );
      }
    } catch (e) {
      if (captureSession && sessionRef.current === captureSession) {
        startXRLoopSafely(captureSession);
        setCaptureStatus('scanning');
      } else {
        setCaptureStatus('error');
      }
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    } finally {
      captureInFlightRef.current = false;
    }
  }

  async function previewModel(): Promise<void> {
    if (previewBuildInFlightRef.current || statusRef.current !== 'scanning') return;
    previewBuildInFlightRef.current = true;
    const previewSession = sessionRef.current;
    setError(null);
    statusRef.current = 'building-model';
    setCaptureStatus('building-model');
    setModelInfo('building preview model');
    try {
      await nextAnimationFrame();
      const previewBuild = buildPreviewModel();
      const nextModel = previewBuild.model;
      if (!nextModel || nextModel.surfelCount === 0) {
        setError('No valid depth samples have been captured yet.');
        return;
      }
      publishModel(nextModel, { recenter: !viewerManuallyAdjustedRef.current });
      setModelInfo(`preview: ${formatModelInfo(nextModel)}`);
      setQualityInfo(formatQualityInfo(nextModel));
      setFrameInfo(`preview model: ${nextModel.surfelCount} fused surfels from ${keyframeCountRef.current} keyframes`);
      logPreviewMetrics(nextModel, previewBuild);
      logScanStats('preview');
    } catch (e) {
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    } finally {
      previewBuildInFlightRef.current = false;
      if (statusRef.current === 'building-model') {
        const nextStatus =
          previewSession && sessionRef.current === previewSession && !previewSession.ended ? 'scanning' : 'idle';
        statusRef.current = nextStatus;
        setCaptureStatus(nextStatus);
      }
    }
  }

  function buildPreviewModel(): PreviewModelBuildResult {
    const buildStart = performanceNow();
    const cachedModel = modelRef.current;
    if (canReusePanoramicModelSnapshot(cachedModel, fusionRef.current, keyframeCountRef.current)) {
      return {
        buildMs: performanceNow() - buildStart,
        model: cachedModel,
        reusedModel: true,
      };
    }
    const model = buildModelFromFusion(fusionRef.current, keyframeCountRef.current);
    return {
      buildMs: model?.buildMs ?? performanceNow() - buildStart,
      model,
      reusedModel: false,
    };
  }

  function maybePublishLiveModel(): boolean {
    if (statusRef.current !== 'scanning' || keyframeCountRef.current <= 0) {
      return false;
    }
    const now = performanceNow();
    const hasPublishedModel = modelRef.current !== null;
    // @ref LLP 0020#performance-constraints - Live scan feedback backs off as
    // retained samples and build cost grow; Preview/Capture still force a full
    // model build at the user boundary.
    const publishDecision = shouldPublishLiveModelSnapshot({
      hasPublishedModel,
      keyframes: keyframeCountRef.current,
      lastPublishedAtMs: lastLiveModelPublishedAtMsRef.current,
      lastPublishedKeyframes: lastLiveModelKeyframesRef.current,
      lastPublishedRawSampleCount: lastLiveModelRawSampleCountRef.current,
      nowMs: now,
      previousBuildMs: lastLiveModelBuildDurationMsRef.current,
      rawSampleCount: fusionRef.current.rawSampleCount,
    });
    if (!publishDecision.publish) {
      return false;
    }
    const previewBuild = buildPreviewModel();
    const nextModel = previewBuild.model;
    if (!nextModel || nextModel.surfelCount === 0) {
      return false;
    }
    lastLiveModelBuildDurationMsRef.current = previewBuild.buildMs;
    lastLiveModelKeyframesRef.current = keyframeCountRef.current;
    lastLiveModelPublishedAtMsRef.current = performanceNow();
    lastLiveModelRawSampleCountRef.current = fusionRef.current.rawSampleCount;
    // @ref LLP 0020#model-view - During a 180-degree scan, keep live snapshots
    // centered around the evolving accepted view until the user manually
    // inspects the model, then preserve that chosen inspection view.
    publishModel(nextModel, { recenter: !viewerManuallyAdjustedRef.current });
    setModelInfo(
      `live: ${formatModelInfo(nextModel)} - refresh ${previewBuild.buildMs.toFixed(1)}ms/${publishDecision.intervalMs}ms`
    );
    logLiveModelProfile(nextModel, publishDecision, previewBuild);
    return true;
  }

  // @ref LLP 0020#privacy-and-permissions - Export is an explicit user action
  // and uses the system share sheet; captures are not uploaded or saved silently.
  async function saveModel(): Promise<void> {
    const capturedModel = status === 'captured' ? modelRef.current : null;
    if (!capturedModel || saving) return;
    setSaving(true);
    setError(null);
    setSaveInfo('writing .ply');
    try {
      const filename = modelFileName();
      const file = new File(Paths.document, filename);
      const ply = serializeModelAsPly(capturedModel);
      file.create({ overwrite: true });
      file.write(ply);
      const savedSize = file.exists ? file.size : 0;
      if (savedSize <= 0) {
        throw new Error('PLY export was not written to Files.');
      }
      const filesLocation = formatFilesLocation(filename, savedSize);
      setSaveInfo(filesLocation);
      logExportMetrics(capturedModel, file.uri, filename, savedSize);
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        return;
      }
      try {
        await Sharing.shareAsync(file.uri, {
          dialogTitle: 'Save scene model',
          mimeType: 'model/ply',
          UTI: 'public.data',
        });
      } catch (shareError) {
        setError(
          `Share sheet did not complete; file remains saved to Files. ${
            shareError instanceof Error ? `${shareError.name}: ${shareError.message}` : String(shareError)
          }`
        );
      }
      setSaveInfo(filesLocation);
    } catch (e) {
      setSaveInfo('save failed');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    } finally {
      setSaving(false);
    }
  }

  const running = session !== null;
  const {
    canCapture,
    canPreview,
    canSave,
    canStart,
    transitioning,
    unsupported,
  } = derivePanoramicCaptureControls({
    hasModel: model !== null,
    liveSurfelCount,
    saving,
    status,
  });
  const canRecenterModel = model !== null;
  const displayError = error ?? lidarError;
  const badgeState = (() => {
    if (status === 'error' || lidarStatus === 'error') return { label: 'XR error', style: styles.badgeWarn };
    if (unsupported) return { label: 'unsupported', style: styles.badgeWarn };
    if (status === 'scanning') return { label: 'scanning', style: styles.badgeLive };
    if (status === 'building-model') return { label: 'building', style: styles.badgeWarn };
    if (status === 'captured') return { label: 'captured', style: styles.badgeLive };
    if (status === 'requesting') return { label: 'starting', style: styles.badgeWarn };
    return { label: 'ready', style: styles.badgeWarn };
  })();

  const isStageGestureEnabled = React.useCallback(
    () => statusRef.current === 'scanning' || modelRef.current !== null,
    []
  );

  const modelPanResponder = React.useMemo(
    () =>
      // @ref LLP 0020#model-view - Model-view supports one-finger orbit plus
      // two-finger pan/pinch inspection of the surfel cloud.
      // eslint-disable-next-line react-hooks/refs -- PanResponder stores handlers; refs are read when gestures fire.
      PanResponder.create({
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onMoveShouldSetPanResponder: (event, gesture) =>
          isStageGestureEnabled() &&
          (event.nativeEvent.touches.length > 1 || Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2),
        onMoveShouldSetPanResponderCapture: (event, gesture) =>
          isStageGestureEnabled() &&
          (event.nativeEvent.touches.length > 1 || Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2),
        onPanResponderGrant: (event) => {
          viewerGestureActiveRef.current = true;
          lastGestureRenderProfileLoggedAtMsRef.current = 0;
          setStageGestureActive(true);
          viewerManuallyAdjustedRef.current = true;
          viewerGestureStartRef.current = viewerRef.current;
          const touches = event.nativeEvent.touches;
          if (touches.length > 1) {
            beginTwoFingerViewerGesture(touches);
          } else {
            pinchDistanceStartRef.current = null;
            panMidpointStartRef.current = null;
            singleTouchStartRef.current = touchPoint(touches);
          }
        },
        onPanResponderMove: (event) => {
          if (!isStageGestureEnabled()) return;
          const touches = event.nativeEvent.touches;
          if (touches.length > 1) {
            if (pinchDistanceStartRef.current === null || panMidpointStartRef.current === null) {
              beginTwoFingerViewerGesture(touches);
              return;
            }
            const start = viewerGestureStartRef.current;
            const pinchDistance = touchDistance(touches);
            const midpoint = touchMidpoint(touches);
            if (pinchDistance === null || midpoint === null) return;
            const startMidpoint = panMidpointStartRef.current ?? midpoint;
            const panDx = midpoint.x - startMidpoint.x;
            const panDy = midpoint.y - startMidpoint.y;
            setViewerState({
              ...start,
              distanceScale: clamp(start.distanceScale * pinchDistanceStartRef.current / pinchDistance, 0.45, 2.4),
              panX: clamp(start.panX - panDx * 0.0022, -1.6, 1.6),
              panY: clamp(start.panY + panDy * 0.0022, -1.6, 1.6),
            });
            return;
          }

          if (pinchDistanceStartRef.current !== null || panMidpointStartRef.current !== null) {
            viewerGestureStartRef.current = viewerRef.current;
            pinchDistanceStartRef.current = null;
            panMidpointStartRef.current = null;
            singleTouchStartRef.current = touchPoint(touches);
            return;
          }

          const point = touchPoint(touches);
          if (!point) return;
          if (!singleTouchStartRef.current) {
            singleTouchStartRef.current = point;
            viewerGestureStartRef.current = viewerRef.current;
            return;
          }
          const start = viewerGestureStartRef.current;
          setViewerState({
            ...start,
            pitch: clamp(start.pitch + (point.y - singleTouchStartRef.current.y) * 0.006, -1.05, 1.15),
            yaw: start.yaw + (point.x - singleTouchStartRef.current.x) * 0.008,
          });
        },
        onPanResponderRelease: () => {
          endViewerGesture();
        },
        onPanResponderTerminate: () => {
          endViewerGesture();
        },
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
      }),
    [beginTwoFingerViewerGesture, endViewerGesture, isStageGestureEnabled, setViewerState]
  );

  function xrHeaderRightItems(): NativeStackHeaderItem[] {
    const iconName: SFSymbol = running ? 'stop.fill' : 'play.fill';
    const label = running ? 'Stop scan' : 'Start scan';
    return [
      {
        type: 'button' as const,
        label,
        accessibilityLabel: label,
        disabled: transitioning || (!running && !canStart) || unsupported,
        icon: { type: 'sfSymbol' as const, name: iconName },
        identifier: 'panoramic-capture-start-stop',
        onPress: running ? () => void stopSession() : () => void startSession(),
        tintColor: running ? '#ff453a' : '#f8fafc',
        variant: 'plain' as const,
      },
    ];
  }

  React.useEffect(() => {
    if (!device) return;
    const gpuDevice = device;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    let animationFrame: number | null = null;

    const setup = async (): Promise<void> => {
      try {
        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        const { context, height, width } = configureWebGpuCanvas(ref, gpuDevice, presentationFormat);
        const shaderModule = gpuDevice.createShaderModule({ code: CAPTURE_MODEL_SHADER });
        void shaderModule.getCompilationInfo?.()
          .then((info: GPUCompilationInfo) => {
            const errors = info.messages.filter((message) => message.type === 'error');
            if (errors.length > 0) {
              setError(
                errors
                  .map((message) => `WGSL ${message.lineNum}:${message.linePos} ${message.message}`)
                  .join('\n')
              );
            }
          })
          .catch(() => undefined);
        const bindGroupLayout = gpuDevice.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          ],
        });
        const pipeline = gpuDevice.createRenderPipeline({
          layout: gpuDevice.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
          vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: [
              {
                arrayStride: SURFEL_STRIDE_BYTES,
                attributes: [
                  { shaderLocation: 0, offset: 0, format: 'float32x4' },
                  { shaderLocation: 1, offset: 16, format: 'float32x4' },
                  { shaderLocation: 2, offset: 32, format: 'float32x4' },
                ],
                stepMode: 'instance',
              },
            ],
          },
          fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: presentationFormat }] },
          primitive: { topology: 'triangle-list' },
          depthStencil: {
            depthCompare: 'less',
            depthWriteEnabled: true,
            format: 'depth24plus',
          },
        });
        const uniformBuffer = gpuDevice.createBuffer({
          size: 80,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const bindGroup = gpuDevice.createBindGroup({
          layout: bindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        });
        let surfelBuffer: GPUBuffer | null = null;
        let surfelBufferCapacityBytes = 0;
        let depthTexture: GPUTexture | null = null;
        let lastModelRevision = -1;
        let lastRenderedModelViewMode = -1;
        let renderedCapturedModelRevision = -1;
        let frames = 0;
        let lastFpsReport = Date.now();
        const uniforms = new Float32Array(20);

        const rebuildDepthTexture = (canvasWidth: number, canvasHeight: number): void => {
          depthTexture?.destroy();
          depthTexture = gpuDevice.createTexture({
            size: { width: canvasWidth, height: canvasHeight },
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
        };

        const uploadSurfelBuffer = (nextModel: CaptureModel | null, modelRevision: number): void => {
          if (!nextModel || nextModel.surfelCount === 0) {
            surfelBuffer?.destroy();
            surfelBuffer = null;
            surfelBufferCapacityBytes = 0;
            return;
          }
          const uploadStart = performanceNow();
          const requiredBytes = nextModel.surfels.byteLength;
          const nextCapacityBytes = nextSurfelBufferCapacityBytes(requiredBytes);
          let allocated = false;
          if (!surfelBuffer || requiredBytes > surfelBufferCapacityBytes) {
            surfelBuffer?.destroy();
            surfelBuffer = gpuDevice.createBuffer({
              size: nextCapacityBytes,
              usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            surfelBufferCapacityBytes = nextCapacityBytes;
            allocated = true;
          }
          gpuDevice.queue.writeBuffer(surfelBuffer, 0, nextModel.surfels);
          logModelUploadProfile(
            nextModel,
            modelRevision,
            performanceNow() - uploadStart,
            allocated,
            surfelBufferCapacityBytes
          );
        };

        rebuildDepthTexture(width, height);

        function requestRender(): void {
          if (cancelled || animationFrame !== null) return;
          animationFrame = requestAnimationFrame(render);
        }
        requestRenderRef.current = requestRender;

        function render(): void {
          animationFrame = null;
          if (cancelled) return;
          const renderFrameStart = performanceNow();
          const currentModel = modelRef.current;
          const currentModelRevision = modelRevisionRef.current;
          const currentModelViewMode = modelViewModeRef.current;
          const modelChanged = currentModelRevision !== lastModelRevision;
          if (currentModelRevision !== lastModelRevision) {
            lastModelRevision = currentModelRevision;
            uploadSurfelBuffer(currentModel, currentModelRevision);
          }
          const modeChanged = currentModelViewMode !== lastRenderedModelViewMode;
          if (!renderDirtyRef.current && !modelChanged && !modeChanged) {
            return;
          }
          renderDirtyRef.current = false;
          lastRenderedModelViewMode = currentModelViewMode;

          const elapsed = performanceNow() / 1000;
          makeModelViewProjectionInto(
            uniforms,
            currentModel,
            width / Math.max(height, 1),
            0,
            viewerRef.current
          );
          // @ref LLP 0020#webgpu-rendering - Dense surfel captures render as
          // smaller camera-facing splats to reduce overdraw on device GPUs.
          const pointScalePx = modelSurfelPointScalePx(currentModel?.surfelCount ?? 0);
          uniforms[16] = pointScalePx / Math.max(width, 1);
          uniforms[17] = pointScalePx / Math.max(height, 1);
          uniforms[18] = elapsed;
          uniforms[19] = currentModelViewMode;
          gpuDevice.queue.writeBuffer(uniformBuffer, 0, uniforms);

          const commandEncodeStart = performanceNow();
          const encoder = gpuDevice.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0.016, g: 0.019, b: 0.03, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
            depthStencilAttachment: depthTexture
              ? {
                  view: depthTexture.createView(),
                  depthClearValue: 1,
                  depthLoadOp: 'clear',
                  depthStoreOp: 'discard',
                }
              : undefined,
          });
          let didDrawCapturedModel = false;
          if (surfelBuffer && currentModel && currentModel.surfelCount > 0) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.setVertexBuffer(0, surfelBuffer);
            pass.draw(QUAD_VERTEX_COUNT, currentModel.surfelCount);
            didDrawCapturedModel =
              statusRef.current === 'captured' &&
              renderedCapturedModelRevision !== currentModelRevision;
          }
          pass.end();
          const commandEncodeMs = performanceNow() - commandEncodeStart;
          const submitPresentStart = performanceNow();
          gpuDevice.queue.submit([encoder.finish()]);
          context.present();
          const submitPresentMs = performanceNow() - submitPresentStart;
          const renderFrameEnd = performanceNow();
          const renderFrameProfile = {
            commandEncodeMs,
            renderFrameMs: renderFrameEnd - renderFrameStart,
            submitPresentMs,
          };
          if (modelChanged && currentModel) {
            logRenderFrameProfile(
              currentModel,
              currentModelRevision,
              width,
              height,
              presentationFormat,
              modelViewModeRef.current,
              statusRef.current,
              renderFrameProfile,
              'model-change'
            );
          } else if (
            currentModel &&
            viewerGestureActiveRef.current &&
            renderFrameEnd - lastGestureRenderProfileLoggedAtMsRef.current >= GESTURE_RENDER_PROFILE_INTERVAL_MS
          ) {
            lastGestureRenderProfileLoggedAtMsRef.current = renderFrameEnd;
            logRenderFrameProfile(
              currentModel,
              currentModelRevision,
              width,
              height,
              presentationFormat,
              modelViewModeRef.current,
              statusRef.current,
              renderFrameProfile,
              'gesture'
            );
          }
          if (didDrawCapturedModel && currentModel) {
            renderedCapturedModelRevision = currentModelRevision;
            logRenderMetrics(
              currentModel,
              currentModelRevision,
              width,
              height,
              presentationFormat,
              modelViewModeRef.current,
              renderFrameProfile
            );
          }

          frames += 1;
          const now = Date.now();
          if (now - lastFpsReport >= 1000) {
            setFps((frames / ((now - lastFpsReport) / 1000)).toFixed(1));
            frames = 0;
            lastFpsReport = now;
          }
        }

        requestRender();
        cleanup = (): void => {
          if (requestRenderRef.current === requestRender) {
            requestRenderRef.current = null;
          }
          if (animationFrame !== null) cancelAnimationFrame(animationFrame);
          surfelBuffer?.destroy();
          depthTexture?.destroy();
          uniformBuffer.destroy();
        };
      } catch (e) {
        setCaptureStatus('error');
        setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    };

    void setup();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [device, ref, stageHeight, stageWidth]);

  const showStoppedPlaceholder = Device.isDevice && !running && !model;
  const stageSurfelCount = model ? model.surfelCount : liveSurfelCount;

  return (
    <>
      <Stack.Screen options={{
        fullScreenGestureEnabled: false,
        gestureEnabled: false,
        unstable_headerRightItems: xrHeaderRightItems,
      }} />
      <ScrollView
        directionalLockEnabled
        scrollEnabled={!stageGestureActive}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic">
        <DemoPageFrame
          preview={
            <View {...modelPanResponder.panHandlers} style={[styles.stage, { height: stageHeight, width: stageWidth }]}>
              <Canvas ref={ref} style={styles.canvas} />
              {showStoppedPlaceholder ? (
                <View style={styles.emptyOverlay}>
                  <Text style={styles.emptyTitle}>Start a camera/depth scan</Text>
                  <Text style={styles.emptySub}>Sweep about 180 degrees, then capture the surfel model.</Text>
                </View>
              ) : null}
              <View style={styles.stageBadge}>
                <Text style={[styles.badge, badgeState.style]}>{badgeState.label}</Text>
              </View>
              <View style={styles.stageReadout}>
                <Text style={styles.stageReadoutLabel}>MODEL</Text>
                <Text style={styles.stageReadoutValue}>{stageSurfelCount}</Text>
                <Text style={styles.stageReadoutSub}>surfels</Text>
              </View>
              <View style={styles.coveragePanel}>
                <View style={styles.coverageHeader}>
                  <Text style={styles.coverageLabel}>180 SCAN</Text>
                  <Text style={styles.coverageValue}>{Math.round(coveragePercent)}%</Text>
                </View>
                <View style={styles.coverageTrack}>
                  <View style={[styles.coverageFill, { width: `${coveragePercent}%` }]} />
                </View>
              </View>
            </View>
          }
          controls={
            <>
              <Host colorScheme="dark" style={[styles.commandHost, { width: stageWidth }]}>
                <VStack spacing={COMMAND_BUTTON_GAP}>
                  <CommandButton
                    disabled={running ? transitioning : transitioning || !canStart || unsupported}
                    icon={running ? 'stop.fill' : 'play.fill'}
                    label={running ? 'Stop Scan' : 'Start Scan'}
                    onPress={running ? () => void stopSession() : () => void startSession()}
                    tone={running ? 'danger' : 'primary'}
                    width={stageWidth}
                  />
                  <HStack spacing={COMMAND_BUTTON_GAP}>
                    <CommandButton
                      disabled={!canCapture}
                      icon="camera.fill"
                      label="Capture"
                      onPress={() => void captureModel()}
                      tone="primary"
                      width={commandButtonWidth}
                    />
                    <CommandButton
                      disabled={!canPreview}
                      icon="eye.fill"
                      label="Preview Model"
                      onPress={() => void previewModel()}
                      tone="preview"
                      width={commandButtonWidth}
                    />
                  </HStack>
                  <HStack spacing={COMMAND_BUTTON_GAP}>
                    <CommandButton
                      disabled={!canSave}
                      icon="square.and.arrow.down"
                      label={saving ? 'Saving' : 'Save'}
                      onPress={() => void saveModel()}
                      tone="primary"
                      width={commandButtonWidth}
                    />
                    <CommandButton
                      disabled={transitioning}
                      icon="arrow.counterclockwise"
                      label={canRecenterModel ? 'Recenter' : 'Reset'}
                      onPress={canRecenterModel ? resetViewer : resetCapture}
                      tone="reset"
                      width={commandButtonWidth}
                    />
                  </HStack>
                </VStack>
              </Host>
              {model ? (
                // @ref LLP 0020#model-view - Model-view exposes inspection
                // modes for camera color, geometric depth, and fused normals.
                <View style={[styles.modeControl, { width: stageWidth }]}>
                  <Text style={styles.modeControlLabel}>View</Text>
                  <Host colorScheme="dark" style={styles.modePickerHost}>
                    <Picker
                      label="View"
                      modifiers={[pickerStyle('segmented')]}
                      onSelectionChange={(value) => setModelViewMode(value as ModelViewMode)}
                      selection={modelViewMode}>
                      {MODEL_VIEW_MODES.map((mode) => (
                        <UIText key={mode.value} modifiers={[tag(mode.value)]}>
                          {mode.label}
                        </UIText>
                      ))}
                    </Picker>
                  </Host>
                </View>
              ) : null}

              <View style={styles.controls}>
                <View style={styles.titleBlock}>
                  <Text style={styles.title}>Panoramic Scene Capture</Text>
                  <Text style={styles.subtitle}>
                    WebXR camera/depth keyframes fused into a WebGPU surfel model
                  </Text>
                </View>
                <View style={styles.statusRow}>
                  <Text style={[styles.badge, badgeState.style]}>{badgeState.label}</Text>
                  <Text style={styles.statusText}>{status}</Text>
                </View>
                <Text selectable style={styles.metric}>{support}</Text>
                <Text selectable style={styles.metric}>{frameInfo}</Text>
                <Text selectable style={styles.metric}>{modelInfo}</Text>
                <Text selectable style={styles.metric}>{qualityInfo}</Text>
                <Text selectable style={styles.metric}>webgpu: {fps} fps - {adapter?.info?.vendor ?? 'unknown adapter'}</Text>
                <Text selectable style={styles.metric}>files: {saveInfo}</Text>
                {displayError ? <Text selectable style={styles.error}>{displayError}</Text> : null}
              </View>
            </>
          }
        />
      </ScrollView>
    </>
  );

  function cancelXRLoop(): void {
    const current = sessionRef.current;
    if (current && xrRafRef.current !== null) {
      current.cancelAnimationFrame(xrRafRef.current);
    }
    xrRafRef.current = null;
  }

  async function stopActiveSession(): Promise<void> {
    const current = sessionRef.current;
    if (!current) return;
    cancelXRLoop();
    try {
      await current.end();
    } finally {
      if (sessionRef.current === current) {
        sessionRef.current = null;
      }
      setSession(null);
    }
  }

  async function startXRLoop(nextSession: WebXRSession): Promise<void> {
    const referenceSpace = await nextSession.requestReferenceSpace('local');
    const cameraBinding = new WebXRCPUCameraBinding(nextSession);
    const onFrame = (_time: DOMHighResTimeStamp, frame: WebXRFrame): void => {
      const frameWallTime = performanceNow();
      try {
        const stats = scanStatsRef.current;
        stats.frameCount += 1;
        const poseStart = performanceNow();
        const pose = frame.getViewerPose(referenceSpace);
        stats.poseMsTotal += performanceNow() - poseStart;
        const view = pose?.views[0];
        if (!view) {
          stats.poseMisses += 1;
          maybeLogPeriodicScanStats();
          return;
        }
        maybeLogMeshProfile(frame);
        // @ref LLP 0020#keyframe-policy - `predictedDisplayTime` describes when
        // the native frame was captured/displayed. The panorama throttle uses JS
        // callback wall time so delayed WebXR delivery does not collapse several
        // scan candidates into the first keyframe's interval bucket.
        const precheck = precheckKeyframePose(view.transform.matrix, frameWallTime);
        if (!precheck) {
          stats.depthPrecheckSkips += 1;
          maybeLogPeriodicScanStats();
          return;
        }
        const depthInfoStart = performanceNow();
        const depth = frame.getDepthInformation(view);
        stats.depthInfoMsTotal += performanceNow() - depthInfoStart;
        stats.depthInfoRequests += 1;
        if (depth) {
          let cachedCameraImage: WebXRCPUCameraImage | null | undefined;
          const getCameraImage = (): WebXRCPUCameraImage | null => {
            if (cachedCameraImage !== undefined) {
              return cachedCameraImage;
            }
            const xrCamera = view.camera;
            cachedCameraImage = xrCamera ? cameraBinding.getCameraImage(xrCamera) : null;
            return cachedCameraImage;
          };
          // @ref LLP 0017#xr-webgl-get-camera-image — This route uses the
          // repo-local CPU binding analog to sample camera colors into surfels;
          // no native camera side API is called outside the WebXR-shaped frame.
          maybeCaptureKeyframe(
            depth,
            getCameraImage,
            // @ref LLP 0013#xr-depth-information — XRDepthInformation includes
            // XRViewGeometry; use the depth object's associated projection and
            // transform for reconstruction instead of exposing native intrinsics.
            depth.projectionMatrix,
            depth.transform.matrix,
            frameWallTime,
            precheck,
            frame,
            referenceSpace
          );
        } else {
          stats.depthMisses += 1;
          maybeLogKeyframeRejectionProfile('depth-miss', {
            cameraForward: roundVec3(precheck.forward),
            cameraPosition: roundVec3(precheck.position),
            rotationDeg: roundMetric(precheck.decision.rotationDeg, 1),
            translationM: roundMetric(precheck.decision.translationM, 3),
          });
        }
        maybeLogPeriodicScanStats();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        recordScanRejection('scan-loop-error');
        // @ref LLP 0020#testing-and-validation - A thrown frame callback used
        // to stop recursive XR RAF scheduling, leaving a scan with only the
        // first accepted surfel batch. Keep the loop alive and make the failure
        // visible in copied physical-device logs.
        maybeLogKeyframeRejectionProfile('scan-loop-error', {
          errorMessage: message,
          errorName: e instanceof Error ? e.name : 'Error',
          frameTimeMs: roundMetric(frame.predictedDisplayTime),
        });
        setError(`Scan loop error: ${message}`);
      } finally {
        const scheduleInput = {
          captureInFlight: captureInFlightRef.current,
          sessionEnded: nextSession.ended,
          sessionMatches: sessionRef.current === nextSession,
          status: statusRef.current,
        };
        const stopReason = xrScanFrameStopReason(scheduleInput);
        if (stopReason === null) {
          xrRafRef.current = nextSession.requestAnimationFrame(onFrame);
        } else {
          logXRScanLoopStopProfile(stopReason, nextSession);
          xrRafRef.current = null;
        }
      }
    };
    xrRafRef.current = nextSession.requestAnimationFrame(onFrame);
  }

  function precheckKeyframePose(cameraToWorld: Float32Array, time: number): PoseKeyframePrecheck | null {
    if (statusRef.current !== 'scanning') {
      recordScanRejection('not-scanning');
      maybeLogKeyframeRejectionProfile('not-scanning');
      return null;
    }
    const position = extractPosition(cameraToWorld);
    const forward = extractForward(cameraToWorld);
    const lastKeyframe = keyframeRef.current;
    const preSampleStart = performanceNow();
    const decision = shouldAcceptPanoramicKeyframe({
      existingSurfels: surfelCountRef.current,
      forward,
      keyframes: keyframeCountRef.current,
      last: lastKeyframe,
      position,
      time,
    });
    const preSampleMs = performanceNow() - preSampleStart;
    if (!decision.accepted) {
      // @ref LLP 0020#performance-constraints - Reject pose-only non-keyframes
      // before touching WebXR CPU depth/camera data.
      recordScanRejection(decision.reason);
      maybeLogKeyframeRejectionProfile(decision.reason, {
        cameraForward: roundVec3(forward),
        cameraPosition: roundVec3(position),
        intervalMs: roundMetric(lastKeyframe ? Math.max(0, time - lastKeyframe.time) : 0),
        rotationDeg: roundMetric(decision.rotationDeg, 1),
        rotationSpeedDegPerSec: roundMetric(decision.rotationSpeedDegPerSec, 1),
        translationM: roundMetric(decision.translationM, 3),
        translationSpeedMPerSec: roundMetric(decision.translationSpeedMPerSec, 3),
      });
      return null;
    }
    if (shouldSkipCoveredPanoramicSector({
      coverageSectors: coverageSectorsRef.current,
      forward,
      keyframes: keyframeCountRef.current,
      scanForwardSum: scanForwardSumRef.current,
      translationM: decision.translationM,
    })) {
      recordScanRejection('covered-sector');
      maybeLogKeyframeRejectionProfile('covered-sector', {
        cameraForward: roundVec3(forward),
        cameraPosition: roundVec3(position),
        intervalMs: roundMetric(lastKeyframe ? Math.max(0, time - lastKeyframe.time) : 0),
        rotationDeg: roundMetric(decision.rotationDeg, 1),
        translationM: roundMetric(decision.translationM, 3),
      });
      return null;
    }
    return { decision, forward, position, preSampleMs };
  }

  function startXRLoopSafely(nextSession: WebXRSession): void {
    void startXRLoop(nextSession).catch((e) => {
      if (sessionRef.current !== nextSession || nextSession.ended) {
        return;
      }
      setCaptureStatus('error');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    });
  }

  function publishModel(nextModel: CaptureModel | null, options: { recenter?: boolean } = {}): void {
    modelRef.current = nextModel;
    modelRevisionRef.current += 1;
    renderDirtyRef.current = true;
    requestRenderRef.current?.();
    setModel(nextModel);
    if (nextModel) {
      if (statusRef.current !== 'scanning') {
        setLiveSurfelCount(nextModel.surfelCount);
      }
      setQualityInfo(formatQualityInfo(nextModel));
      if (options.recenter) {
        setViewerState(recenteredViewerState());
      }
    }
  }

  function maybeCaptureKeyframe(
    depth: WebXRCPUDepthInformation,
    getCameraImage: () => WebXRCPUCameraImage | null,
    projectionMatrix: Float32Array,
    cameraToWorld: Float32Array,
    time: number,
    precheck: PoseKeyframePrecheck,
    frame: WebXRFrame,
    referenceSpace: WebXRReferenceSpace
  ): boolean {
    if (statusRef.current !== 'scanning') {
      recordScanRejection('not-scanning');
      maybeLogKeyframeRejectionProfile('not-scanning');
      return false;
    }
    const { forward, position, preSampleMs } = precheck;
    const candidateCoverageSector = panoramicCoverageKey(forward, { centerForward: scanForwardSumRef.current });
    const addsCoverageSector = !coverageSectorsRef.current.has(candidateCoverageSector);
    // @ref LLP 0020#performance-constraints - After the first keyframe,
    // require world-space contribution before asking WebXR for the CPU camera
    // image and before doing the full color/normal fusion pass. New 180-degree
    // coverage sectors use a lighter gate; already-covered sectors use the
    // full duplicate-frame rejection threshold.
    const minNewVoxelsForFusion = keyframeCountRef.current <= 0
      ? 0
      : addsCoverageSector
        ? Math.max(1, Math.floor(MIN_KEYFRAME_NEW_VOXELS / 2))
        : MIN_KEYFRAME_NEW_VOXELS;
    let detectedMeshes: WebXRMeshSet | null = null;
    let meshFetchMs = 0;
    const getDetectedMeshes = (): WebXRMeshSet => {
      if (detectedMeshes === null) {
        const meshFetchStart = performanceNow();
        detectedMeshes = frame.detectedMeshes;
        meshFetchMs = performanceNow() - meshFetchStart;
      }
      return detectedMeshes;
    };
    const getMeshPose = (mesh: WebXRMesh) =>
      frame.getPose(mesh.meshSpace, referenceSpace)?.transform ?? null;

    let appendProfile: AppendDepthSurfelsProfile = {};
    const appendStart = performanceNow();
    let added = appendDepthSurfelsToFusion(
      depth,
      getCameraImage,
      projectionMatrix,
      cameraToWorld,
      fusionRef.current,
      surfelCountRef.current,
      {
        minSurfelsForCamera: MIN_KEYFRAME_SURFELS,
        minNewVoxelsForFusion,
        profile: appendProfile,
        detailedProfile:
          keyframeCountRef.current === 0 ||
          (keyframeCountRef.current + 1) % 5 === 0 ||
          keyframeCountRef.current + 1 >= MAX_KEYFRAMES,
        samplePhase: keyframeCountRef.current,
      }
    );
    const depthInitialAppendMs = performanceNow() - appendStart;
    let appendMs = performanceNow() - appendStart;
    const sampleDecisionStart = performanceNow();
    // @ref LLP 0020#keyframe-policy - Pose/time/speed rejections happen before
    // WebXR CPU depth/camera access. After append, only density/contribution
    // gates can reject the candidate, so a rejected frame cannot leave fused
    // surfels behind for a pose reason.
    const sampleDecisionMs = performanceNow() - sampleDecisionStart;
    const observedDepthSurfels = observedDepthSurfelCount(added.surfelCount, appendProfile.preflightSurfels);
    // @ref LLP 0020#performance-constraints - Mature overlap skips reduce how
    // many samples are actually fused, but the density gate should use the
    // preflight-observed surface count. Otherwise a useful new-voxel keyframe can
    // be treated as sparse just because duplicate mature voxels were skipped.
    const depthSparse = observedDepthSurfels < MIN_KEYFRAME_SURFELS;
    const depthTooRedundant = minNewVoxelsForFusion > 0 && added.newVoxelCount < minNewVoxelsForFusion;
    let meshPreflight: MeshSurfelPreflightResult | null = null;
    let meshPreflightMs = 0;
    let depthRecoveryAppendMs = 0;
    let depthRecoverySkipped = false;
    let meshRecoveredDepthGate = false;
    if (depthSparse || depthTooRedundant) {
      const meshPreflightStopAtSurfels = Math.max(0, MIN_KEYFRAME_SURFELS - observedDepthSurfels);
      const meshPreflightStopAtNewVoxels = Math.max(0, minNewVoxelsForFusion - added.newVoxelCount);
      const meshPreflightStart = performanceNow();
      meshPreflight = preflightMeshSurfelsForFusion(
        getDetectedMeshes(),
        getMeshPose,
        projectionMatrix,
        cameraToWorld,
        fusionRef.current,
        surfelCountRef.current + added.surfelCount,
        {
          maxSurfels: MESH_SURFEL_SAMPLE_BUDGET,
          stopAtNewVoxels: meshPreflightStopAtNewVoxels,
          stopAtSurfels: meshPreflightStopAtSurfels,
        }
      );
      meshPreflightMs = performanceNow() - meshPreflightStart;
      const combinedPreflightSurfels = observedDepthSurfels + meshPreflight.surfelCount;
      const combinedPreflightNewVoxels = added.newVoxelCount + meshPreflight.newVoxelCount;
      if (combinedPreflightSurfels < MIN_KEYFRAME_SURFELS) {
        recordScanRejection('too-few-surfels');
        maybeLogKeyframeRejectionProfile('too-few-surfels', {
          cameraForward: roundVec3(forward),
          cameraPosition: roundVec3(position),
          combinedPreflightNewVoxelCount: combinedPreflightNewVoxels,
          combinedPreflightSurfels,
          depthInitialAppendMs: roundMetric(depthInitialAppendMs),
          depthNewVoxelCount: added.newVoxelCount,
          depthSurfelCount: added.surfelCount,
          meshPreflightMs: roundMetric(meshPreflightMs),
          meshPreflightNewVoxelCount: meshPreflight.newVoxelCount,
          meshPreflightSurfelCount: meshPreflight.surfelCount,
          minKeyframeSurfels: MIN_KEYFRAME_SURFELS,
          minNewVoxelsForFusion,
          observedDepthSurfels,
          rotationDeg: roundMetric(precheck.decision.rotationDeg, 1),
          translationM: roundMetric(precheck.decision.translationM, 3),
        });
        if (combinedPreflightSurfels > 0) {
          setFrameInfo(
            `waiting for fuller surface: ${combinedPreflightSurfels}/${MIN_KEYFRAME_SURFELS} depth+mesh samples`
          );
        }
        return false;
      }
      if (minNewVoxelsForFusion > 0 && combinedPreflightNewVoxels < minNewVoxelsForFusion) {
        recordScanRejection('too-few-new-voxels');
        maybeLogKeyframeRejectionProfile('too-few-new-voxels', {
          cameraForward: roundVec3(forward),
          cameraPosition: roundVec3(position),
          combinedPreflightNewVoxelCount: combinedPreflightNewVoxels,
          combinedPreflightSurfels,
          depthInitialAppendMs: roundMetric(depthInitialAppendMs),
          depthNewVoxelCount: added.newVoxelCount,
          depthSurfelCount: added.surfelCount,
          meshPreflightMs: roundMetric(meshPreflightMs),
          meshPreflightNewVoxelCount: meshPreflight.newVoxelCount,
          meshPreflightSurfelCount: meshPreflight.surfelCount,
          minKeyframeSurfels: MIN_KEYFRAME_SURFELS,
          minNewVoxelsForFusion,
          observedDepthSurfels,
          rotationDeg: roundMetric(precheck.decision.rotationDeg, 1),
          translationM: roundMetric(precheck.decision.translationM, 3),
        });
        setFrameInfo(
          `waiting for new coverage: ${combinedPreflightNewVoxels}/${minNewVoxelsForFusion} depth+mesh voxels`
        );
        return false;
      }
      meshRecoveredDepthGate = true;
      const depthRecoveryCanSkip = added.newVoxelCount <= 0 &&
        meshPreflight.surfelCount >= MIN_KEYFRAME_SURFELS &&
        (minNewVoxelsForFusion <= 0 || meshPreflight.newVoxelCount >= minNewVoxelsForFusion);
      if (!depthRecoveryCanSkip && added.surfelCount > 0) {
        appendProfile = {};
        const depthRecoveryAppendStart = performanceNow();
        added = appendDepthSurfelsToFusion(
          depth,
          getCameraImage,
          projectionMatrix,
          cameraToWorld,
          fusionRef.current,
          surfelCountRef.current,
          {
            minSurfelsForCamera: 0,
            minNewVoxelsForFusion: 0,
            profile: appendProfile,
            detailedProfile:
              keyframeCountRef.current === 0 ||
              (keyframeCountRef.current + 1) % 5 === 0 ||
              keyframeCountRef.current + 1 >= MAX_KEYFRAMES,
            samplePhase: keyframeCountRef.current,
          }
        );
        depthRecoveryAppendMs = performanceNow() - depthRecoveryAppendStart;
        appendMs = performanceNow() - appendStart;
      } else {
        depthRecoverySkipped = true;
        added = {
          cameraColoredSurfels: 0,
          newVoxelCount: 0,
          surfelCount: 0,
          updatedVoxelCount: 0,
        };
      }
    }
    if (observedDepthSurfels < MIN_KEYFRAME_SURFELS && !meshRecoveredDepthGate) {
      recordScanRejection('too-few-surfels');
      maybeLogKeyframeRejectionProfile('too-few-surfels', {
        cameraForward: roundVec3(forward),
        cameraPosition: roundVec3(position),
        depthInitialAppendMs: roundMetric(depthInitialAppendMs),
        depthNewVoxelCount: added.newVoxelCount,
        depthSurfelCount: added.surfelCount,
        minKeyframeSurfels: MIN_KEYFRAME_SURFELS,
        minNewVoxelsForFusion,
        observedDepthSurfels,
        rotationDeg: roundMetric(precheck.decision.rotationDeg, 1),
        translationM: roundMetric(precheck.decision.translationM, 3),
      });
      if (observedDepthSurfels > 0) {
        setFrameInfo(
          `waiting for fuller depth frame: ${observedDepthSurfels}/${MIN_KEYFRAME_SURFELS} samples`
        );
      }
      return false;
    }
    if (minNewVoxelsForFusion > 0 && added.newVoxelCount < minNewVoxelsForFusion && !meshRecoveredDepthGate) {
      recordScanRejection('too-few-new-voxels');
      maybeLogKeyframeRejectionProfile('too-few-new-voxels', {
        cameraForward: roundVec3(forward),
        cameraPosition: roundVec3(position),
        depthInitialAppendMs: roundMetric(depthInitialAppendMs),
        depthNewVoxelCount: added.newVoxelCount,
        depthSurfelCount: added.surfelCount,
        minKeyframeSurfels: MIN_KEYFRAME_SURFELS,
        minNewVoxelsForFusion,
        observedDepthSurfels,
        rotationDeg: roundMetric(precheck.decision.rotationDeg, 1),
        translationM: roundMetric(precheck.decision.translationM, 3),
      });
      setFrameInfo(
        `waiting for new coverage: ${added.newVoxelCount}/${minNewVoxelsForFusion} new voxels`
      );
      return false;
    }
    const sampleDecision = precheck.decision;
    const meshProfile: AppendMeshSurfelsProfile = {};
    const nextKeyframeOrdinal = keyframeCountRef.current + 1;
    const meshPeriodicCheckDue =
      nextKeyframeOrdinal === 1 ||
      nextKeyframeOrdinal - lastMeshSupplementCheckKeyframeRef.current >= MESH_SUPPLEMENT_REFRESH_KEYFRAMES;
    const meshRefreshDue =
      lastMeshSupplementSignatureRef.current !== null &&
      nextKeyframeOrdinal - lastMeshSupplementKeyframeRef.current >= MESH_SUPPLEMENT_REFRESH_KEYFRAMES;
    const meshCoverageCheckDue = addsCoverageSector;
    // @ref LLP 0020#v2-arkit-mesh-snapshot - When depth alone accepted this
    // keyframe, defer XRFrame.detectedMeshes summary reads except for first /
    // newly covered 180-degree sectors, periodic refresh checks, or explicit
    // supplement refreshes. Mesh rescue still reads immediately because it can
    // decide whether a weak depth candidate should be accepted.
    const shouldCheckMeshMetadata =
      meshRecoveredDepthGate || meshCoverageCheckDue || meshPeriodicCheckDue || meshRefreshDue;
    const candidateMeshes = shouldCheckMeshMetadata ? getDetectedMeshes() : null;
    if (shouldCheckMeshMetadata) {
      lastMeshSupplementCheckKeyframeRef.current = nextKeyframeOrdinal;
    }
    const meshSignature = candidateMeshes ? meshMetadataSignature(candidateMeshes) : (lastMeshSupplementSignatureRef.current ?? '');
    const meshAvailable = (candidateMeshes?.size ?? 0) > 0;
    const meshSignatureChanged = meshAvailable && meshSignature !== lastMeshSupplementSignatureRef.current;
    const shouldAppendMesh = meshAvailable && (meshRecoveredDepthGate || meshSignatureChanged || meshRefreshDue);
    const meshAppendReason = !shouldCheckMeshMetadata
      ? 'mesh-check-deferred'
      : !meshAvailable
        ? 'no-mesh'
        : meshRecoveredDepthGate
          ? 'recovered-depth-gate'
          : meshSignatureChanged
            ? 'mesh-metadata-changed'
            : meshRefreshDue
              ? 'periodic-refresh'
              : 'unchanged-mesh';
    let meshAppendSkipped = true;
    let meshAppendMs = 0;
    let meshAdded: AppendDepthSurfelsResult = {
      cameraColoredSurfels: 0,
      newVoxelCount: 0,
      surfelCount: 0,
      updatedVoxelCount: 0,
    };
    if (shouldAppendMesh) {
      const meshAppendStart = performanceNow();
      meshAdded = appendMeshSurfelsToFusion(
        candidateMeshes!,
        getMeshPose,
        getCameraImage,
        projectionMatrix,
        cameraToWorld,
        fusionRef.current,
        surfelCountRef.current + added.surfelCount,
        {
          maxSurfels: MESH_SURFEL_SAMPLE_BUDGET,
          profile: meshProfile,
        }
      );
      meshAppendMs = performanceNow() - meshAppendStart;
      meshAppendSkipped = false;
      lastMeshSupplementKeyframeRef.current = nextKeyframeOrdinal;
      lastMeshSupplementSignatureRef.current = meshSignature;
    }
    const totalCameraColoredSurfels = added.cameraColoredSurfels + meshAdded.cameraColoredSurfels;
    const totalNewVoxelCount = added.newVoxelCount + meshAdded.newVoxelCount;
    const totalSurfelCount = added.surfelCount + meshAdded.surfelCount;
    const totalUpdatedVoxelCount = added.updatedVoxelCount + meshAdded.updatedVoxelCount;

    // @ref LLP 0020#performance-constraints - Accepted samples are inserted
    // into voxel fusion during the WebXR depth pass, avoiding a second JS array
    // walk on the XR frame path.
    const fusionMs = 0;
    keyframeCountRef.current += 1;
    surfelCountRef.current += totalSurfelCount;
    keyframeRef.current = { forward, position, time };
    const stats = scanStatsRef.current;
    stats.acceptedKeyframes = keyframeCountRef.current;
    stats.totalAppendMs += appendMs + meshAppendMs;
    stats.maxAppendMs = Math.max(stats.maxAppendMs, appendMs + meshAppendMs);
    stats.totalFusionMs += fusionMs;
    stats.totalNewVoxelCount += totalNewVoxelCount;
    stats.totalUpdatedVoxelCount += totalUpdatedVoxelCount;
    addScanForward(forward);
    const fusedSurfelCount = fusionRef.current.voxels.size;
    const rawSampleCount = fusionRef.current.rawSampleCount;
    setLiveSurfelCount(fusedSurfelCount);
    setCoveragePercent(panoramicCoveragePercent(coverageSectorsRef.current));
    setQualityInfo(
      `scan profile: append ${(appendMs + meshAppendMs).toFixed(1)}ms - camera ${totalCameraColoredSurfels}/${totalSurfelCount}`
    );
    setFrameInfo(
      `keyframes: ${keyframeCountRef.current}/${MAX_KEYFRAMES} - raw samples: ${rawSampleCount}/${MAX_SURFELS} - fused: ${fusedSurfelCount} - mesh: ${meshAdded.surfelCount} - camera color: ${totalCameraColoredSurfels > 0 ? 'yes' : 'fallback'}`
    );
    const livePublishStart = performanceNow();
    const livePublished = maybePublishLiveModel();
    const livePublishMs = performanceNow() - livePublishStart;
    stats.livePublishMsTotal += livePublishMs;
    logKeyframeProfile({
      appendProfile,
      appendMs: appendMs + meshAppendMs,
      cameraColoredSurfels: totalCameraColoredSurfels,
      coveragePercent: panoramicCoveragePercent(coverageSectorsRef.current),
      depthAppendMs: appendMs,
      depthInitialAppendMs,
      depthRecoveryAppendMs,
      depthRecoverySkipped,
      depthType: sessionRef.current?.depthType ?? null,
      fusionMs,
      keyframes: keyframeCountRef.current,
      livePublished,
      livePublishMs,
      meshAdded,
      meshAppendMs,
      meshAppendReason,
      meshAppendSkipped,
      meshFetchMs,
      meshSignature,
      meshProfile,
      meshPreflight,
      meshPreflightMs,
      meshRecoveredDepthGate,
      newVoxelCount: totalNewVoxelCount,
      observedDepthSurfels,
      position,
      preSampleMs,
      projectionMatrix,
      rawSampleCount,
      retainedSamples: surfelCountRef.current,
      rotationDeg: sampleDecision.rotationDeg,
      rotationSpeedDegPerSec: sampleDecision.rotationSpeedDegPerSec,
      sampleDecisionMs,
      transform: cameraToWorld,
      surfelCount: totalSurfelCount,
      fusedSurfelCount,
      translationM: sampleDecision.translationM,
      translationSpeedMPerSec: sampleDecision.translationSpeedMPerSec,
      updatedVoxelCount: totalUpdatedVoxelCount,
    });
    if (keyframeCountRef.current % 5 === 0 || keyframeCountRef.current >= MAX_KEYFRAMES) {
      logScanStats('accepted-keyframe');
    }
    if (!livePublished) {
      setModelInfo(
        `scan: ${keyframeCountRef.current}/${MAX_KEYFRAMES} keyframes - ${rawSampleCount}/${MAX_SURFELS} raw samples - ${fusedSurfelCount} fused surfels - live model ${modelRef.current?.surfelCount ?? 0} surfels`
      );
    }
    return true;
  }
}

function CommandButton({
  disabled,
  icon,
  label,
  onPress,
  tone,
  width,
}: {
  disabled: boolean;
  icon: SFSymbol;
  label: string;
  onPress: () => void;
  tone: 'danger' | 'preview' | 'primary' | 'reset';
  width: number;
}): React.JSX.Element {
  const prominent = tone === 'primary' || tone === 'danger';
  const tintColor = (() => {
    if (tone === 'danger') return '#ff453a';
    if (tone === 'preview') return '#38bdf8';
    if (tone === 'reset') return '#f59e0b';
    return '#14b8a6';
  })();
  const labelColor = prominent ? '#f8fafc' : tintColor;
  const labelWidth = Math.max(88, width - COMMAND_BUTTON_NATIVE_CHROME_WIDTH);
  return (
    <UIButton
      onPress={disabled ? undefined : onPress}
      role={tone === 'danger' ? 'destructive' : 'default'}
      modifiers={[
        buttonStyle(prominent ? 'borderedProminent' : 'bordered'),
        controlSize('regular'),
        tint(tintColor),
        disabledModifier(disabled),
      ]}>
      <HStack modifiers={[frame({ width: labelWidth })]} spacing={6}>
        <UIImage color={labelColor} size={15} systemName={icon} />
        <UIText modifiers={[foregroundColor(labelColor)]}>{label}</UIText>
      </HStack>
    </UIButton>
  );
}

function logCaptureMetrics(model: CaptureModel, build: PreviewModelBuildResult): void {
  const boundsMeters = [
    model.boundsMax[0] - model.boundsMin[0],
    model.boundsMax[1] - model.boundsMin[1],
    model.boundsMax[2] - model.boundsMin[2],
  ].map((value) => roundMetric(Math.max(0, value), 3));
  console.log('PANORAMIC_CAPTURE_METRICS', JSON.stringify({
    boundsMeters,
    buildMs: roundMetric(build.buildMs),
    cameraColorPercent: roundMetric(100 * model.cameraColoredSurfels / Math.max(model.surfelCount, 1), 1),
    colorSource: model.colorSource,
    fusionPercent: roundMetric(100 * model.surfelCount / Math.max(model.rawSampleCount, 1), 1),
    keyframes: model.keyframes,
    modelBuildMs: roundMetric(model.buildMs),
    multiObservationPercent: roundMetric(100 * model.multiObservedSurfels / Math.max(model.surfelCount, 1), 1),
    multiObservedSurfels: model.multiObservedSurfels,
    normalPercent: roundMetric(100 * model.normalEstimatedSurfels / Math.max(model.surfelCount, 1), 1),
    rawSampleCount: model.rawSampleCount,
    reusedModel: build.reusedModel,
    surfelCount: model.surfelCount,
    voxelSizeMeters: model.voxelSizeMeters,
  }));
}

function logCaptureGeometryMetrics(model: CaptureModel, scanForwardSum: Vec3): void {
  const boundsMeters: Vec3 = [
    model.boundsMax[0] - model.boundsMin[0],
    model.boundsMax[1] - model.boundsMin[1],
    model.boundsMax[2] - model.boundsMin[2],
  ];
  const geometry = summarizeCaptureGeometry(model);
  const largestHorizontal = Math.max(boundsMeters[0], boundsMeters[2], 1e-6);
  console.log('PANORAMIC_CAPTURE_GEOMETRY', JSON.stringify({
    boundsCenterMeters: roundVec3([
      (model.boundsMin[0] + model.boundsMax[0]) / 2,
      (model.boundsMin[1] + model.boundsMax[1]) / 2,
      (model.boundsMin[2] + model.boundsMax[2]) / 2,
    ]),
    boundsMaxMeters: roundVec3(model.boundsMax),
    boundsMeters: roundVec3(boundsMeters),
    boundsMinMeters: roundVec3(model.boundsMin),
    heightToLargestHorizontal: roundMetric(boundsMeters[1] / largestHorizontal, 3),
    keyframes: model.keyframes,
    modelCenterMeters: roundVec3(model.center),
    normalCoherencePercent: roundMetric(geometry.normalCoherencePercent, 1),
    normalProjectedRmsMeters: roundMetric(geometry.normalProjectedRmsMeters, 3),
    normalProjectedSpanMeters: roundMetric(geometry.normalProjectedSpanMeters, 3),
    rawSampleCount: model.rawSampleCount,
    scanForwardAverage: roundVec3([
      scanForwardSum[0] / Math.max(model.keyframes, 1),
      scanForwardSum[1] / Math.max(model.keyframes, 1),
      scanForwardSum[2] / Math.max(model.keyframes, 1),
    ]),
    surfelCount: model.surfelCount,
    weightedCentroidMeters: roundVec3(geometry.weightedCentroid),
  }));
}

function logPreviewMetrics(model: CaptureModel, build: PreviewModelBuildResult): void {
  console.log('PANORAMIC_PREVIEW_METRICS', JSON.stringify({
    buildMs: roundMetric(build.buildMs),
    cameraColorPercent: roundMetric(100 * model.cameraColoredSurfels / Math.max(model.surfelCount, 1), 1),
    colorSource: model.colorSource,
    fusionPercent: roundMetric(100 * model.surfelCount / Math.max(model.rawSampleCount, 1), 1),
    keyframes: model.keyframes,
    modelBuildMs: roundMetric(model.buildMs),
    multiObservationPercent: roundMetric(100 * model.multiObservedSurfels / Math.max(model.surfelCount, 1), 1),
    multiObservedSurfels: model.multiObservedSurfels,
    normalPercent: roundMetric(100 * model.normalEstimatedSurfels / Math.max(model.surfelCount, 1), 1),
    rawSampleCount: model.rawSampleCount,
    reusedModel: build.reusedModel,
    surfelCount: model.surfelCount,
  }));
}

function logExportMetrics(model: CaptureModel, uri: string, filename: string, bytes: number): void {
  console.log('PANORAMIC_EXPORT_METRICS', JSON.stringify({
    bytes,
    filename,
    filesVisiblePath: `standard-camera-app/${filename}`,
    keyframes: model.keyframes,
    surfelCount: model.surfelCount,
    uri,
  }));
}

function logRenderMetrics(
  model: CaptureModel,
  modelRevision: number,
  canvasWidth: number,
  canvasHeight: number,
  presentationFormat: GPUTextureFormat,
  modelViewMode: ModelViewMode,
  renderFrameProfile: RenderFrameProfile
): void {
  console.log('PANORAMIC_RENDER_METRICS', JSON.stringify({
    buildMs: roundMetric(model.buildMs),
    cameraColorPercent: roundMetric(100 * model.cameraColoredSurfels / Math.max(model.surfelCount, 1), 1),
    canvasHeight,
    canvasWidth,
    commandEncodeMs: roundMetric(renderFrameProfile.commandEncodeMs),
    keyframes: model.keyframes,
    modelRevision,
    multiObservationPercent: roundMetric(100 * model.multiObservedSurfels / Math.max(model.surfelCount, 1), 1),
    multiObservedSurfels: model.multiObservedSurfels,
    normalPercent: roundMetric(100 * model.normalEstimatedSurfels / Math.max(model.surfelCount, 1), 1),
    presentationFormat,
    rawSampleCount: model.rawSampleCount,
    renderFrameMs: roundMetric(renderFrameProfile.renderFrameMs),
    submitPresentMs: roundMetric(renderFrameProfile.submitPresentMs),
    surfelCount: model.surfelCount,
    viewMode: MODEL_VIEW_MODES.find((mode) => mode.value === modelViewMode)?.label ?? modelViewMode,
  }));
}

function logRenderFrameProfile(
  model: CaptureModel,
  modelRevision: number,
  canvasWidth: number,
  canvasHeight: number,
  presentationFormat: GPUTextureFormat,
  modelViewMode: ModelViewMode,
  status: PanoramicCaptureStatus,
  renderFrameProfile: RenderFrameProfile,
  reason: 'gesture' | 'model-change'
): void {
  console.log('PANORAMIC_RENDER_FRAME_PROFILE', JSON.stringify({
    canvasHeight,
    canvasWidth,
    commandEncodeMs: roundMetric(renderFrameProfile.commandEncodeMs),
    keyframes: model.keyframes,
    modelRevision,
    presentationFormat,
    rawSampleCount: model.rawSampleCount,
    reason,
    renderFrameMs: roundMetric(renderFrameProfile.renderFrameMs),
    status,
    submitPresentMs: roundMetric(renderFrameProfile.submitPresentMs),
    surfelCount: model.surfelCount,
    viewMode: MODEL_VIEW_MODES.find((mode) => mode.value === modelViewMode)?.label ?? modelViewMode,
  }));
}

function logLiveModelProfile(
  model: CaptureModel,
  publishDecision: LiveModelSnapshotPublishDecision,
  build: PreviewModelBuildResult
): void {
  console.log('PANORAMIC_LIVE_MODEL_PROFILE', JSON.stringify({
    buildMs: roundMetric(build.buildMs),
    intervalMs: publishDecision.intervalMs,
    keyframes: model.keyframes,
    modelBuildMs: roundMetric(model.buildMs),
    multiObservationPercent: roundMetric(100 * model.multiObservedSurfels / Math.max(model.surfelCount, 1), 1),
    multiObservedSurfels: model.multiObservedSurfels,
    reason: publishDecision.reason,
    rawSampleCount: model.rawSampleCount,
    reusedModel: build.reusedModel,
    surfelCount: model.surfelCount,
  }));
}

function logModelUploadProfile(
  model: CaptureModel,
  modelRevision: number,
  uploadMs: number,
  allocated: boolean,
  capacityBytes: number
): void {
  console.log('PANORAMIC_MODEL_UPLOAD_PROFILE', JSON.stringify({
    allocated,
    capacityBytes,
    modelRevision,
    surfelBytes: model.surfels.byteLength,
    surfelCount: model.surfelCount,
    uploadMs: roundMetric(uploadMs),
  }));
}

function logKeyframeProfile({
  appendProfile,
  appendMs,
  cameraColoredSurfels,
  coveragePercent,
  depthAppendMs,
  depthInitialAppendMs,
  depthRecoveryAppendMs,
  depthRecoverySkipped,
  depthType,
  fusedSurfelCount,
  fusionMs,
  keyframes,
  livePublished,
  livePublishMs,
  meshAdded,
  meshAppendMs,
  meshAppendReason,
  meshAppendSkipped,
  meshFetchMs,
  meshSignature,
  meshProfile,
  meshPreflight,
  meshPreflightMs,
  meshRecoveredDepthGate,
  newVoxelCount,
  observedDepthSurfels,
  position,
  preSampleMs,
  projectionMatrix,
  rawSampleCount,
  retainedSamples,
  rotationDeg,
  rotationSpeedDegPerSec,
  sampleDecisionMs,
  transform,
  surfelCount,
  translationM,
  translationSpeedMPerSec,
  updatedVoxelCount,
}: {
  appendProfile: AppendDepthSurfelsProfile;
  appendMs: number;
  cameraColoredSurfels: number;
  coveragePercent: number;
  depthAppendMs: number;
  depthInitialAppendMs: number;
  depthRecoveryAppendMs: number;
  depthRecoverySkipped: boolean;
  depthType: string | null;
  fusedSurfelCount: number;
  fusionMs: number;
  keyframes: number;
  livePublished: boolean;
  livePublishMs: number;
  meshAdded: AppendDepthSurfelsResult;
  meshAppendMs: number;
  meshAppendReason: string;
  meshAppendSkipped: boolean;
  meshFetchMs: number;
  meshSignature: string;
  meshProfile: AppendMeshSurfelsProfile;
  meshPreflight: MeshSurfelPreflightResult | null;
  meshPreflightMs: number;
  meshRecoveredDepthGate: boolean;
  newVoxelCount: number;
  observedDepthSurfels: number;
  position: Vec3;
  preSampleMs: number;
  projectionMatrix: Float32Array;
  rawSampleCount: number;
  retainedSamples: number;
  rotationDeg: number;
  rotationSpeedDegPerSec: number;
  sampleDecisionMs: number;
  transform: Float32Array;
  surfelCount: number;
  translationM: number;
  translationSpeedMPerSec: number;
  updatedVoxelCount: number;
}): void {
  const projectionPixels = projectionPixelGeometry(
    projectionMatrix,
    appendProfile.depthWidth ?? 0,
    appendProfile.depthHeight ?? 0
  );
  console.log('PANORAMIC_KEYFRAME_PROFILE', JSON.stringify({
    appendMs: roundMetric(appendMs),
    cameraBytes: appendProfile.cameraBytes ?? 0,
    cameraColorPercent: roundMetric(100 * cameraColoredSurfels / Math.max(surfelCount, 1), 1),
    cameraForward: roundVec3([-(transform[8] ?? 0), -(transform[9] ?? 0), -(transform[10] ?? 1)]),
    cameraImageMs: roundMetric(appendProfile.cameraImageMs ?? 0),
    cameraPointCacheHits: appendProfile.cameraPointCacheHits ?? 0,
    cameraPointSamples: appendProfile.cameraPointSamples ?? 0,
    cameraPosition: roundVec3(position),
    cameraRequested: appendProfile.cameraRequested ?? false,
    cameraSampleMode: appendProfile.cameraSampleMode ?? 'unknown',
    cameraSize: [appendProfile.cameraWidth ?? 0, appendProfile.cameraHeight ?? 0],
    cameraTransformMode: appendProfile.cameraTransformMode ?? 'unknown',
    cameraUp: roundVec3([transform[4] ?? 0, transform[5] ?? 1, transform[6] ?? 0]),
    centerCameraMeters: appendProfile.centerCameraMeters ? roundVec3(appendProfile.centerCameraMeters) : null,
    centerDepthMeters: roundMetric(appendProfile.centerDepthMeters ?? 0, 3),
    centerDepthValid: appendProfile.centerDepthValid ?? false,
    centerWorldMeters: appendProfile.centerWorldMeters ? roundVec3(appendProfile.centerWorldMeters) : null,
    coveragePercent: roundMetric(coveragePercent, 1),
    depthAppendMs: roundMetric(depthAppendMs),
    depthBytes: appendProfile.depthBytes ?? 0,
    depthCacheReused: appendProfile.depthCacheReused ?? false,
    depthDataMs: roundMetric(appendProfile.depthDataMs ?? 0),
    depthGridSamples: appendProfile.depthGridSampleCount ?? 0,
    depthGridSampleMode: appendProfile.depthGridSampleMode ?? 'unknown',
    depthLookupMs: roundMetric(appendProfile.depthLookupMs ?? 0),
    depthPreflightMs: roundMetric(appendProfile.depthPreflightMs ?? 0),
    depthSize: [appendProfile.depthWidth ?? 0, appendProfile.depthHeight ?? 0],
    depthInitialAppendMs: roundMetric(depthInitialAppendMs),
    depthRecoveryAppendMs: roundMetric(depthRecoveryAppendMs),
    depthRecoverySkipped,
    depthTransformMode: appendProfile.depthTransformMode ?? 'unknown',
    depthType: depthType ?? 'unknown',
    detailedTiming: appendProfile.detailedTiming ?? false,
    fusedSurfelCount,
    fusionMs: roundMetric(fusionMs),
    fusionMode: 'inline',
    keyframes,
    livePublished,
    livePublishMs: roundMetric(livePublishMs),
    meshAppendReason,
    meshAppendSkipped,
    meshAppendMs: roundMetric(meshAppendMs),
    meshCameraColorPercent: roundMetric(100 * meshAdded.cameraColoredSurfels / Math.max(meshAdded.surfelCount, 1), 1),
    meshCameraColoredSurfels: meshAdded.cameraColoredSurfels,
    meshCameraImageMs: roundMetric(meshProfile.cameraImageMs ?? 0),
    meshCameraRequested: meshProfile.cameraRequested ?? false,
    meshCameraSampleMode: meshProfile.cameraSampleMode ?? 'unknown',
    meshCount: meshProfile.meshCount ?? 0,
    meshFetchMs: roundMetric(meshFetchMs),
    meshMaxSurfels: meshProfile.maxSurfels ?? 0,
    meshNewVoxelCount: meshAdded.newVoxelCount,
    meshNormalCount: meshProfile.meshNormalCount ?? 0,
    meshNormalMode: meshProfile.meshNormalMode ?? 'none',
    meshPoseMisses: meshProfile.poseMisses ?? 0,
    meshPlaneProjectedSamples: meshProfile.planeProjectedSamples ?? 0,
    meshPreflightEarlyStopped: meshPreflight?.earlyStopped ?? false,
    meshPreflightMaxSurfels: meshPreflight?.maxSurfels ?? 0,
    meshPreflightNewVoxelCount: meshPreflight?.newVoxelCount ?? 0,
    meshPreflightMs: roundMetric(meshPreflightMs),
    meshPreflightProjectedSurfels: meshPreflight?.projectedSurfels ?? 0,
    meshPreflightSampleStride: meshPreflight?.meshSampleStride ?? 0,
    meshPreflightSkippedSurfels: meshPreflight?.skippedSurfels ?? 0,
    meshPreflightStrideSkippedCandidates: meshPreflight?.strideSkippedCandidates ?? 0,
    meshPreflightStopAtNewVoxels: meshPreflight?.stopAtNewVoxels ?? 0,
    meshPreflightStopAtSurfels: meshPreflight?.stopAtSurfels ?? 0,
    meshPreflightSurfelCount: meshPreflight?.surfelCount ?? 0,
    meshProjectedSurfels: meshProfile.projectedSurfels ?? 0,
    meshRecoveredDepthGate,
    meshSampleStride: meshProfile.meshSampleStride ?? 0,
    meshSkippedSurfels: meshProfile.skippedSurfels ?? 0,
    meshSignature,
    meshStrideSkippedCandidates: meshProfile.strideSkippedCandidates ?? 0,
    meshSurfelCount: meshAdded.surfelCount,
    meshTriangles: meshProfile.meshTriangles ?? 0,
    meshUpdatedVoxelCount: meshAdded.updatedVoxelCount,
    meshVertices: meshProfile.meshVertices ?? 0,
    minNewVoxelsForFusion: appendProfile.minNewVoxelsForFusion ?? 0,
    matureVoxelSkips: appendProfile.matureVoxelSkips ?? 0,
    newVoxelCount,
    newVoxelPercent: roundMetric(100 * newVoxelCount / Math.max(surfelCount, 1), 1),
    newVoxelPreflightMs: roundMetric(appendProfile.newVoxelPreflightMs ?? 0),
    normalEstimateMs: roundMetric(appendProfile.normalEstimateMs ?? 0),
    observedDepthSurfels,
    planeProjectedSamples: appendProfile.planeProjectedSamples ?? 0,
    preSampleMs: roundMetric(preSampleMs),
    projectionFocalPixels: projectionPixels.focalPixels,
    projectionOffset: roundVec2([projectionMatrix[8] ?? 0, projectionMatrix[9] ?? 0]),
    projectionPrincipalPixel: projectionPixels.principalPixel,
    projectionScale: roundVec2([projectionMatrix[0] ?? 0, projectionMatrix[5] ?? 0]),
    preflightNewVoxels: appendProfile.preflightNewVoxels ?? 0,
    preflightSurfels: appendProfile.preflightSurfels ?? 0,
    preflightUpdatedVoxels: appendProfile.preflightUpdatedVoxels ?? 0,
    profiledSampleCount: appendProfile.profiledSampleCount ?? 0,
    rawSampleCount,
    retainedSamples,
    rotationDeg: roundMetric(rotationDeg, 1),
    rotationSpeedDegPerSec: roundMetric(rotationSpeedDegPerSec, 1),
    colorSampleMs: roundMetric(appendProfile.colorSampleMs ?? 0),
    sampleConsumeMs: roundMetric(appendProfile.sampleConsumeMs ?? 0),
    sampleDecisionMs: roundMetric(sampleDecisionMs),
    sampleGrid: [appendProfile.sampleGridX ?? 0, appendProfile.sampleGridY ?? 0],
    sampleOffset: [
      roundMetric(appendProfile.sampleOffsetX ?? 0, 3),
      roundMetric(appendProfile.sampleOffsetY ?? 0, 3),
    ],
    samplePhase: appendProfile.samplePhase ?? 0,
    timedSampleCount: appendProfile.timedSampleCount ?? 0,
    timingSampleStride: appendProfile.timingSampleStride ?? 0,
    unprojectionMode: appendProfile.unprojectionMode ?? 'unknown',
    unprojectMs: roundMetric(appendProfile.unprojectMs ?? 0),
    sampleLoopMs: roundMetric(appendProfile.sampleLoopMs ?? 0),
    surfelCount,
    translationM: roundMetric(translationM, 3),
    translationSpeedMPerSec: roundMetric(translationSpeedMPerSec, 3),
    updatedVoxelCount,
  }));
}

function projectionPixelGeometry(
  projectionMatrix: Float32Array,
  depthWidth: number,
  depthHeight: number
): { focalPixels: [number, number]; principalPixel: [number, number] } {
  if (depthWidth <= 0 || depthHeight <= 0) {
    return { focalPixels: [0, 0], principalPixel: [0, 0] };
  }
  const scaleX = projectionMatrix[0] ?? 0;
  const scaleY = projectionMatrix[5] ?? 0;
  const offsetX = projectionMatrix[8] ?? 0;
  const offsetY = projectionMatrix[9] ?? 0;
  return {
    focalPixels: roundVec2([
      scaleX * depthWidth / 2,
      scaleY * depthHeight / 2,
    ]),
    // Native WebXR projection accounts for normalized texel centers. Convert
    // back to integer depth-pixel-center units for device-log diagnostics.
    principalPixel: roundVec2([
      (1 - offsetX) * depthWidth / 2 - 0.5,
      (offsetY + 1) * depthHeight / 2 - 0.5,
    ]),
  };
}

function meshMetadataSignature(meshes: WebXRMeshSet): string {
  if (meshes.size <= 0) return '0';
  const meshParts: string[] = [];
  for (const mesh of meshes) {
    meshParts.push(`${meshIdentitySerial(mesh)}:${Math.round(mesh.lastChangedTime * 1000)}`);
  }
  meshParts.sort();
  return `${meshes.size}:${meshParts.join('|')}`;
}

function meshIdentitySerial(mesh: WebXRMesh): number {
  let serial = meshIdentitySerials.get(mesh);
  if (serial === undefined) {
    serial = nextMeshIdentitySerial;
    nextMeshIdentitySerial += 1;
    meshIdentitySerials.set(mesh, serial);
  }
  return serial;
}

function createScanStats(): ScanStats {
  return {
    acceptedKeyframes: 0,
    depthInfoMsTotal: 0,
    depthInfoRequests: 0,
    depthMisses: 0,
    depthPrecheckSkips: 0,
    frameCount: 0,
    livePublishMsTotal: 0,
    maxAppendMs: 0,
    poseMisses: 0,
    poseMsTotal: 0,
    rejectedByReason: {},
    startedAtMs: performanceNow(),
    totalAppendMs: 0,
    totalFusionMs: 0,
    totalNewVoxelCount: 0,
    totalUpdatedVoxelCount: 0,
  };
}

function roundMetric(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function roundVec2(value: [number, number]): [number, number] {
  return [roundMetric(value[0], 4), roundMetric(value[1], 4)];
}

function roundVec3(value: Vec3): Vec3 {
  return [roundMetric(value[0], 4), roundMetric(value[1], 4), roundMetric(value[2], 4)];
}

function modelFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `standard-camera-scene-${stamp}.ply`;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function touchDistance(touches: readonly { pageX: number; pageY: number }[]): number | null {
  if (touches.length < 2) return null;
  const [a, b] = touches;
  if (!a || !b) return null;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

function touchMidpoint(touches: readonly { pageX: number; pageY: number }[]): { x: number; y: number } | null {
  if (touches.length < 2) return null;
  const [a, b] = touches;
  if (!a || !b) return null;
  return {
    x: (a.pageX + b.pageX) / 2,
    y: (a.pageY + b.pageY) / 2,
  };
}

function touchPoint(touches: readonly { pageX: number; pageY: number }[]): { x: number; y: number } | null {
  const [touch] = touches;
  if (!touch) return null;
  return { x: touch.pageX, y: touch.pageY };
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#050712',
  },
  content: {
    alignItems: 'center',
    gap: 14,
    paddingTop: 8,
    paddingBottom: 128,
  },
  stage: {
    backgroundColor: '#050712',
    borderColor: 'rgba(148, 163, 184, 0.22)',
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  canvas: {
    flex: 1,
  },
  emptyOverlay: {
    alignItems: 'center',
    backgroundColor: '#000',
    bottom: 0,
    gap: 8,
    justifyContent: 'center',
    left: 0,
    padding: 22,
    pointerEvents: 'none',
    position: 'absolute',
    right: 0,
    top: 0,
  },
  emptyTitle: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: 0,
    textAlign: 'center',
  },
  emptySub: {
    color: '#94a3b8',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  stageBadge: {
    left: 10,
    pointerEvents: 'none',
    position: 'absolute',
    top: 10,
  },
  stageReadout: {
    alignItems: 'flex-end',
    backgroundColor: 'rgba(5, 7, 18, 0.72)',
    borderColor: 'rgba(45, 212, 191, 0.24)',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 7,
    pointerEvents: 'none',
    position: 'absolute',
    right: 10,
    top: 10,
  },
  stageReadoutLabel: {
    color: '#7dd3fc',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '800',
  },
  stageReadoutValue: {
    color: '#f8fafc',
    fontFamily: 'Menlo',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 1,
  },
  stageReadoutSub: {
    color: '#94a3b8',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '700',
  },
  coveragePanel: {
    backgroundColor: 'rgba(5, 7, 18, 0.74)',
    borderColor: 'rgba(125, 211, 252, 0.22)',
    borderRadius: 8,
    borderWidth: 1,
    bottom: 10,
    left: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    pointerEvents: 'none',
    position: 'absolute',
    right: 10,
  },
  coverageHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  coverageLabel: {
    color: '#7dd3fc',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '800',
  },
  coverageValue: {
    color: '#f8fafc',
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '800',
  },
  coverageTrack: {
    backgroundColor: 'rgba(148, 163, 184, 0.16)',
    borderRadius: 999,
    height: 5,
    overflow: 'hidden',
  },
  coverageFill: {
    backgroundColor: '#14b8a6',
    borderRadius: 999,
    height: 5,
  },
  commandHost: {
    minHeight: COMMAND_BUTTON_HEIGHT * 3 + COMMAND_BUTTON_GAP * 2,
  },
  modeControl: {
    gap: 6,
  },
  modeControlLabel: {
    color: '#7dd3fc',
    fontFamily: 'Menlo',
    fontSize: 10,
    fontWeight: '800',
  },
  modePickerHost: {
    minHeight: 36,
  },
  controls: {
    alignSelf: 'stretch',
    gap: 8,
    paddingHorizontal: 16,
  },
  titleBlock: {
    gap: 3,
    paddingBottom: 2,
  },
  title: {
    color: '#f8fafc',
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: 0,
  },
  subtitle: {
    color: '#9fb0c8',
    fontSize: 13,
    lineHeight: 18,
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  badge: {
    borderRadius: 8,
    fontFamily: 'Menlo',
    fontSize: 11,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 5,
    textTransform: 'uppercase',
  },
  badgeLive: {
    backgroundColor: 'rgba(45, 212, 191, 0.16)',
    color: '#5eead4',
  },
  badgeWarn: {
    backgroundColor: 'rgba(251, 191, 36, 0.16)',
    color: '#fcd34d',
  },
  statusText: {
    color: '#f8fafc',
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  metric: {
    color: '#cbd5e1',
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
  },
  error: {
    color: '#fca5a5',
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 16,
  },
});
