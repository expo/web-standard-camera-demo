import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import { Stack, useFocusEffect } from 'expo-router';
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
  appendDepthSurfels,
  appendSurfelsToFusion,
  buildModelFromFusion,
  clamp,
  createSurfelFusionAccumulator,
  extractForward,
  extractPosition,
  formatFilesLocation,
  formatModelInfo,
  formatQualityInfo,
  makeModelViewProjection,
  MAX_KEYFRAMES,
  MAX_SURFELS,
  MIN_KEYFRAME_SURFELS,
  panoramicCoverageKey,
  panoramicCoveragePercent,
  performanceNow,
  serializeModelAsPly,
  shouldAcceptPanoramicKeyframe,
  SURFEL_STRIDE_BYTES,
  type CaptureModel,
  type KeyframeSnapshot,
  type SurfelFusionAccumulator,
  type ViewerState,
} from '@/lib/panoramic-scene-model';
import {
  installWebXRDepthProfile,
  runWithWebXRUserActivation,
  WebXRCPUCameraBinding,
  type WebXRCPUDepthInformation,
  type WebXRCPUCameraImage,
  type WebXRFrame,
  type WebXRSession,
} from '../../../../modules/standard-camera';

// @ref LLP 0020#reconstruction-pipeline - The first panoramic capture slice
// uses only WebXR-shaped depth, pose, and camera-image access: no new AR APIs
// or mesh extension. The captured model is a camera-colored surfel cloud
// rendered with WebGPU.

const QUAD_VERTEX_COUNT = 6;
const COMMAND_BUTTON_GAP = 8;
const COMMAND_BUTTON_HEIGHT = 38;
const COMMAND_BUTTON_NATIVE_CHROME_WIDTH = 36;
const MODEL_VIEW_MODES = [
  { label: 'Color', value: 0 },
  { label: 'Depth', value: 1 },
  { label: 'Normals', value: 2 },
] as const;

type ModelViewMode = (typeof MODEL_VIEW_MODES)[number]['value'];

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
  let radiusScale = max(in.positionRadius.w, 0.35);
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
  let lightDir = normalize(vec3f(-0.25, 0.72, 0.64));
  let diffuse = 0.52 + 0.38 * max(dot(normalize(in.normal), lightDir), 0.0);
  var rgb = in.color.rgb * (diffuse + alpha * 0.18);
  if (u.displayMode > 1.5) {
    rgb = normalize(in.normal) * 0.5 + vec3f(0.5);
  } else if (u.displayMode > 0.5) {
    let t = clamp((in.distanceMeters - 0.35) / 4.45, 0.0, 1.0);
    rgb = depthRamp(t);
  }
  return vec4f(rgb, 1.0);
}
`;

type CaptureStatus =
  | 'idle'
  | 'checking'
  | 'unsupported'
  | 'requesting'
  | 'scanning'
  | 'captured'
  | 'ending'
  | 'error';

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
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const sessionRef = React.useRef<WebXRSession | null>(null);
  const xrRafRef = React.useRef<number | null>(null);
  const fusionRef = React.useRef<SurfelFusionAccumulator>(createSurfelFusionAccumulator());
  const coverageSectorsRef = React.useRef<Set<string>>(new Set());
  const keyframeRef = React.useRef<KeyframeSnapshot | null>(null);
  const keyframeCountRef = React.useRef(0);
  const modelRef = React.useRef<CaptureModel | null>(null);
  const modelRevisionRef = React.useRef(0);
  const modelViewModeRef = React.useRef<ModelViewMode>(0);
  const statusRef = React.useRef<CaptureStatus>('checking');
  const surfelCountRef = React.useRef(0);
  const supportCheckedRef = React.useRef(false);
  const viewerRef = React.useRef<ViewerState>(DEFAULT_VIEWER_STATE);
  const viewerGestureStartRef = React.useRef<ViewerState>(DEFAULT_VIEWER_STATE);
  const pinchDistanceStartRef = React.useRef<number | null>(null);
  const panMidpointStartRef = React.useRef<{ x: number; y: number } | null>(null);
  const [session, setSession] = React.useState<WebXRSession | null>(null);
  const [status, setStatus] = React.useState<CaptureStatus>('checking');
  const [support, setSupport] = React.useState('checking WebXR camera/depth support');
  const [error, setError] = React.useState<string | null>(null);
  const [model, setModel] = React.useState<CaptureModel | null>(null);
  const [modelViewMode, setModelViewMode] = React.useState<ModelViewMode>(0);
  const [viewer, setViewer] = React.useState<ViewerState>(DEFAULT_VIEWER_STATE);
  const [frameInfo, setFrameInfo] = React.useState('waiting for depth frames');
  const [modelInfo, setModelInfo] = React.useState('no capture yet');
  const [qualityInfo, setQualityInfo] = React.useState('quality: no capture yet');
  const [liveSurfelCount, setLiveSurfelCount] = React.useState(0);
  const [coveragePercent, setCoveragePercent] = React.useState(0);
  const [saveInfo, setSaveInfo] = React.useState('save after capture');
  const [saving, setSaving] = React.useState(false);
  const [fps, setFps] = React.useState('0.0');

  const isDesktop = windowWidth >= 1040;
  const stageWidth = isDesktop
    ? Math.max(360, Math.min(windowWidth - 448, 980, Math.max(360, windowHeight - 190) * 4 / 3))
    : Math.min(Math.max(288, windowWidth - 32), 430);
  const stageHeight = Math.round(isDesktop ? stageWidth * 3 / 4 : stageWidth * 4 / 3);
  const commandButtonWidth = Math.floor((stageWidth - COMMAND_BUTTON_GAP) / 2);

  React.useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);

  React.useEffect(() => {
    modelViewModeRef.current = modelViewMode;
  }, [modelViewMode]);

  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);

  /* eslint-disable react-hooks/set-state-in-effect -- Preserve the existing support-check initialization timing. */
  React.useEffect(() => {
    if (supportCheckedRef.current) return;
    supportCheckedRef.current = true;
    installWebXRDepthProfile();
    const xr = navigator.xr;
    if (!xr) {
      setSupport('WebXR camera/depth unavailable here');
      setStatus('unsupported');
      return;
    }
    void xr.isSessionSupported('immersive-ar')
      .then((supported) => {
        setSupport(supported ? 'immersive-ar camera/depth available' : 'WebXR camera/depth unavailable here');
        setStatus(supported ? 'idle' : 'unsupported');
      })
      .catch((e) => {
        setSupport('WebXR camera/depth check failed');
        setStatus('error');
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
    surfelCountRef.current = 0;
    viewerRef.current = DEFAULT_VIEWER_STATE;
    modelViewModeRef.current = 0;
    publishModel(null);
    setModelViewMode(0);
    setViewer(DEFAULT_VIEWER_STATE);
    setFrameInfo('waiting for depth frames');
    setModelInfo('no capture yet');
    setQualityInfo('quality: no capture yet');
    setLiveSurfelCount(0);
    setCoveragePercent(0);
    setSaveInfo('save after capture');
    setError(null);
    if (!sessionRef.current) {
      setStatus((current) => (current === 'unsupported' ? current : 'idle'));
    }
  }

  function resetViewer(): void {
    viewerRef.current = DEFAULT_VIEWER_STATE;
    viewerGestureStartRef.current = DEFAULT_VIEWER_STATE;
    pinchDistanceStartRef.current = null;
    panMidpointStartRef.current = null;
    setViewer(DEFAULT_VIEWER_STATE);
  }

  async function startSession(): Promise<void> {
    if (sessionRef.current) return;
    installWebXRDepthProfile();
    resetCapture();
    setError(null);
    setStatus('requesting');
    try {
      const xr = navigator.xr;
      if (!xr) {
        setSupport('WebXR camera/depth unavailable here');
        setStatus('unsupported');
        return;
      }
      const supported = await xr.isSessionSupported('immersive-ar');
      if (!supported) {
        setSupport('WebXR camera/depth unavailable here');
        setStatus('unsupported');
        return;
      }
      const nextSession = await runWithWebXRUserActivation(() =>
        xr.requestSession('immersive-ar', {
          requiredFeatures: ['depth-sensing', 'camera-access'],
          depthSensing: {
            usagePreference: ['cpu-optimized'],
            dataFormatPreference: ['float32'],
            depthTypeRequest: ['smooth', 'raw'],
            matchDepthView: true,
          },
          cameraAccess: {
            usagePreference: ['cpu-optimized'],
            formatPreference: ['bgra8unorm', 'rgba8unorm'],
            matchCameraView: true,
          },
        })
      );
      sessionRef.current = nextSession;
      setSession(nextSession);
      setStatus('scanning');
      nextSession.addEventListener('end', () => {
        if (sessionRef.current === nextSession) {
          sessionRef.current = null;
          setSession(null);
          setStatus((current) => (current === 'captured' ? current : 'idle'));
        }
      });
      void startXRLoop(nextSession).catch((e) => {
        setStatus('error');
        setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      });
    } catch (e) {
      sessionRef.current = null;
      setSession(null);
      setStatus('error');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  async function stopSession(): Promise<void> {
    const current = sessionRef.current;
    if (!current) return;
    setStatus('ending');
    cancelXRLoop();
    try {
      await current.end();
      sessionRef.current = null;
      setSession(null);
      setStatus('idle');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  async function captureModel(): Promise<void> {
    const nextModel = buildPreviewModel();
    if (!nextModel || nextModel.surfelCount === 0) {
      setError('No valid depth samples have been captured yet.');
      return;
    }
    publishModel(nextModel);
    setModelInfo(formatModelInfo(nextModel));
    setQualityInfo(formatQualityInfo(nextModel));
    logCaptureMetrics(nextModel);
    setSaveInfo('ready to save .ply');
    setStatus('captured');
    await stopActiveSession();
  }

  function previewModel(): void {
    const nextModel = buildPreviewModel();
    if (!nextModel || nextModel.surfelCount === 0) {
      setError('No valid depth samples have been captured yet.');
      return;
    }
    publishModel(nextModel);
    setModelInfo(`preview: ${formatModelInfo(nextModel)}`);
    setQualityInfo(formatQualityInfo(nextModel));
  }

  function buildPreviewModel(): CaptureModel | null {
    return buildModelFromFusion(fusionRef.current, keyframeCountRef.current);
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
  const capturedModelAvailable = status === 'captured' && model !== null;
  const canStart = status === 'idle' || status === 'captured';
  const transitioning = status === 'requesting' || status === 'ending';
  const canPreview = liveSurfelCount > 0 && !transitioning;
  const canCapture = status === 'scanning' && liveSurfelCount > 0;
  const canSave = capturedModelAvailable && !saving;
  const unsupported = status === 'unsupported';
  const displayError = error ?? lidarError;
  const badgeState = (() => {
    if (status === 'error' || lidarStatus === 'error') return { label: 'XR error', style: styles.badgeWarn };
    if (unsupported) return { label: 'unsupported', style: styles.badgeWarn };
    if (status === 'scanning') return { label: 'scanning', style: styles.badgeLive };
    if (status === 'captured') return { label: 'captured', style: styles.badgeLive };
    if (status === 'requesting') return { label: 'starting', style: styles.badgeWarn };
    return { label: 'ready', style: styles.badgeWarn };
  })();

  const modelPanResponder = React.useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- PanResponder stores handlers; refs are read when gestures fire.
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          model !== null && (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2),
        onPanResponderGrant: (event) => {
          viewerGestureStartRef.current = viewerRef.current;
          pinchDistanceStartRef.current = touchDistance(event.nativeEvent.touches);
          panMidpointStartRef.current = touchMidpoint(event.nativeEvent.touches);
        },
        onPanResponderMove: (event, gesture) => {
          if (!model) return;
          const start = viewerGestureStartRef.current;
          const touches = event.nativeEvent.touches;
          const pinchDistance = touchDistance(touches);
          const midpoint = touchMidpoint(touches);
          if (pinchDistance !== null && pinchDistanceStartRef.current !== null) {
            const startMidpoint = panMidpointStartRef.current ?? midpoint;
            const panDx = midpoint && startMidpoint ? midpoint.x - startMidpoint.x : 0;
            const panDy = midpoint && startMidpoint ? midpoint.y - startMidpoint.y : 0;
            setViewer({
              ...start,
              distanceScale: clamp(start.distanceScale * pinchDistanceStartRef.current / pinchDistance, 0.45, 2.4),
              panX: clamp(start.panX - panDx * 0.0022, -1.6, 1.6),
              panY: clamp(start.panY + panDy * 0.0022, -1.6, 1.6),
            });
            return;
          }
          setViewer({
            ...start,
            pitch: clamp(start.pitch + gesture.dy * 0.006, -1.05, 1.15),
            yaw: start.yaw + gesture.dx * 0.008,
          });
        },
        onPanResponderRelease: () => {
          pinchDistanceStartRef.current = null;
          panMidpointStartRef.current = null;
        },
        onPanResponderTerminate: () => {
          pinchDistanceStartRef.current = null;
          panMidpointStartRef.current = null;
        },
        onStartShouldSetPanResponder: (event) => model !== null && event.nativeEvent.touches.length > 1,
      }),
    [model]
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
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    let animationFrame: number | null = null;

    const setup = async (): Promise<void> => {
      try {
        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        const { context, height, width } = configureWebGpuCanvas(ref, device, presentationFormat);
        const shaderModule = device.createShaderModule({ code: CAPTURE_MODEL_SHADER });
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
        const bindGroupLayout = device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          ],
        });
        const pipeline = device.createRenderPipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
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
        const uniformBuffer = device.createBuffer({
          size: 80,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const bindGroup = device.createBindGroup({
          layout: bindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        });
        let surfelBuffer: GPUBuffer | null = null;
        let depthTexture: GPUTexture | null = null;
        let lastModelRevision = -1;
        let renderedCapturedModelRevision = -1;
        let frames = 0;
        let lastFpsReport = Date.now();

        const rebuildDepthTexture = (canvasWidth: number, canvasHeight: number): void => {
          depthTexture?.destroy();
          depthTexture = device.createTexture({
            size: { width: canvasWidth, height: canvasHeight },
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
        };

        const rebuildSurfelBuffer = (nextModel: CaptureModel | null): void => {
          surfelBuffer?.destroy();
          surfelBuffer = null;
          if (!nextModel || nextModel.surfelCount === 0) return;
          surfelBuffer = device.createBuffer({
            size: Math.max(nextModel.surfels.byteLength, SURFEL_STRIDE_BYTES),
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          });
          device.queue.writeBuffer(surfelBuffer, 0, nextModel.surfels);
        };

        rebuildDepthTexture(width, height);

        const render = (): void => {
          if (cancelled) return;
          const currentModel = modelRef.current;
          const currentModelRevision = modelRevisionRef.current;
          if (currentModelRevision !== lastModelRevision) {
            lastModelRevision = currentModelRevision;
            rebuildSurfelBuffer(currentModel);
          }

          const elapsed = performanceNow() / 1000;
          const viewProjection = makeModelViewProjection(
            currentModel,
            width / Math.max(height, 1),
            statusRef.current === 'scanning' ? 0.18 : elapsed * 0.22,
            viewerRef.current
          );
          const uniforms = new Float32Array(20);
          uniforms.set(viewProjection, 0);
          uniforms[16] = 5.5 / Math.max(width, 1);
          uniforms[17] = 5.5 / Math.max(height, 1);
          uniforms[18] = elapsed;
          uniforms[19] = modelViewModeRef.current;
          device.queue.writeBuffer(uniformBuffer, 0, uniforms);

          const encoder = device.createCommandEncoder();
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
          device.queue.submit([encoder.finish()]);
          context.present();
          if (didDrawCapturedModel && currentModel) {
            renderedCapturedModelRevision = currentModelRevision;
            logRenderMetrics(
              currentModel,
              currentModelRevision,
              width,
              height,
              presentationFormat,
              modelViewModeRef.current
            );
          }

          frames += 1;
          const now = Date.now();
          if (now - lastFpsReport >= 1000) {
            setFps((frames / ((now - lastFpsReport) / 1000)).toFixed(1));
            frames = 0;
            lastFpsReport = now;
          }
          animationFrame = requestAnimationFrame(render);
        };

        animationFrame = requestAnimationFrame(render);
        cleanup = (): void => {
          if (animationFrame !== null) cancelAnimationFrame(animationFrame);
          surfelBuffer?.destroy();
          depthTexture?.destroy();
          uniformBuffer.destroy();
        };
      } catch (e) {
        setStatus('error');
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

  return (
    <>
      <Stack.Screen options={{ unstable_headerRightItems: xrHeaderRightItems }} />
      <ScrollView
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
                  <Text style={styles.emptySub}>Pan slowly, then capture the surfel model.</Text>
                </View>
              ) : null}
              <View style={styles.stageBadge}>
                <Text style={[styles.badge, badgeState.style]}>{badgeState.label}</Text>
              </View>
              <View style={styles.stageReadout}>
                <Text style={styles.stageReadoutLabel}>MODEL</Text>
                <Text style={styles.stageReadoutValue}>
                  {status === 'scanning' ? liveSurfelCount : model ? `${model.surfelCount}` : liveSurfelCount}
                </Text>
                <Text style={styles.stageReadoutSub}>surfels</Text>
              </View>
              <View style={styles.coveragePanel}>
                <View style={styles.coverageHeader}>
                  <Text style={styles.coverageLabel}>SCAN</Text>
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
                      label="Preview"
                      onPress={previewModel}
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
                      label={capturedModelAvailable ? 'Recenter' : 'Reset'}
                      onPress={capturedModelAvailable ? resetViewer : resetCapture}
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
    const referenceSpace = await nextSession.requestReferenceSpace('viewer');
    const cameraBinding = new WebXRCPUCameraBinding(nextSession);
    const onFrame = (_time: DOMHighResTimeStamp, frame: WebXRFrame): void => {
      const pose = frame.getViewerPose(referenceSpace);
      const view = pose?.views[0];
      if (!view) {
        xrRafRef.current = nextSession.requestAnimationFrame(onFrame);
        return;
      }
      const depth = frame.getDepthInformation(view);
      if (depth) {
        // @ref LLP 0017#xr-webgl-get-camera-image — This route uses the
        // repo-local CPU binding analog to sample camera colors into surfels;
        // no native camera side API is called outside the WebXR-shaped frame.
        const accepted = maybeCaptureKeyframe(
          depth,
          () => {
            const xrCamera = view.camera;
            return xrCamera ? cameraBinding.getCameraImage(xrCamera) : null;
          },
          view.projectionMatrix,
          view.transform.matrix,
          frame.predictedDisplayTime
        );
        if (accepted) {
          // @ref LLP 0020#performance-constraints - Do not rebuild the full
          // voxel-fused model while scanning; that made each accepted keyframe
          // slower as retained samples grew. Capture seals and builds once.
          setModelInfo(
            `scan: ${keyframeCountRef.current}/${MAX_KEYFRAMES} keyframes - ${surfelCountRef.current}/${MAX_SURFELS} samples retained - model builds on Capture`
          );
        }
      }
      xrRafRef.current = nextSession.requestAnimationFrame(onFrame);
    };
    xrRafRef.current = nextSession.requestAnimationFrame(onFrame);
  }

  function publishModel(nextModel: CaptureModel | null): void {
    modelRef.current = nextModel;
    modelRevisionRef.current += 1;
    setModel(nextModel);
    if (nextModel) {
      setLiveSurfelCount(nextModel.surfelCount);
      setQualityInfo(formatQualityInfo(nextModel));
    }
  }

  function maybeCaptureKeyframe(
    depth: WebXRCPUDepthInformation,
    getCameraImage: () => WebXRCPUCameraImage | null,
    projectionMatrix: Float32Array,
    cameraToWorld: Float32Array,
    time: number
  ): boolean {
    const position = extractPosition(cameraToWorld);
    const forward = extractForward(cameraToWorld);
    const preSampleDecision = shouldAcceptPanoramicKeyframe({
      existingSurfels: surfelCountRef.current,
      forward,
      keyframes: keyframeCountRef.current,
      last: keyframeRef.current,
      position,
      time,
    });
    if (!preSampleDecision.accepted) {
      return false;
    }

    const candidateStore: number[] = [];
    const appendStart = performanceNow();
    const added = appendDepthSurfels(
      depth,
      getCameraImage(),
      projectionMatrix,
      cameraToWorld,
      candidateStore,
      surfelCountRef.current
    );
    const appendMs = performanceNow() - appendStart;
    // @ref LLP 0020#keyframe-policy - A retained keyframe must contribute
    // enough valid depth samples, not merely pass the pose/time threshold.
    const sampleDecision = shouldAcceptPanoramicKeyframe({
      candidateSurfels: added.surfelCount,
      existingSurfels: surfelCountRef.current,
      forward,
      keyframes: keyframeCountRef.current,
      last: keyframeRef.current,
      position,
      time,
    });
    if (!sampleDecision.accepted) {
      if (sampleDecision.reason === 'too-few-surfels' && added.surfelCount > 0) {
        setFrameInfo(
          `waiting for fuller depth frame: ${added.surfelCount}/${MIN_KEYFRAME_SURFELS} samples`
        );
      }
      return false;
    }

    appendSurfelsToFusion(fusionRef.current, candidateStore);
    keyframeCountRef.current += 1;
    surfelCountRef.current += added.surfelCount;
    keyframeRef.current = { forward, position, time };
    coverageSectorsRef.current.add(panoramicCoverageKey(forward));
    setLiveSurfelCount(surfelCountRef.current);
    setCoveragePercent(panoramicCoveragePercent(coverageSectorsRef.current));
    setQualityInfo(
      `scan profile: append ${appendMs.toFixed(1)}ms - camera ${added.cameraColoredSurfels}/${added.surfelCount}`
    );
    setFrameInfo(
      `keyframes: ${keyframeCountRef.current}/${MAX_KEYFRAMES} - samples: ${surfelCountRef.current}/${MAX_SURFELS} - camera color: ${added.cameraColoredSurfels > 0 ? 'yes' : 'fallback'}`
    );
    logKeyframeProfile({
      appendMs,
      cameraColoredSurfels: added.cameraColoredSurfels,
      keyframes: keyframeCountRef.current,
      retainedSamples: surfelCountRef.current,
      surfelCount: added.surfelCount,
    });
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

function logCaptureMetrics(model: CaptureModel): void {
  const boundsMeters = [
    model.boundsMax[0] - model.boundsMin[0],
    model.boundsMax[1] - model.boundsMin[1],
    model.boundsMax[2] - model.boundsMin[2],
  ].map((value) => Number(Math.max(0, value).toFixed(3)));
  console.log('PANORAMIC_CAPTURE_METRICS', JSON.stringify({
    boundsMeters,
    buildMs: Number(model.buildMs.toFixed(2)),
    cameraColorPercent: Number((100 * model.cameraColoredSurfels / Math.max(model.surfelCount, 1)).toFixed(1)),
    colorSource: model.colorSource,
    fusionPercent: Number((100 * model.surfelCount / Math.max(model.rawSampleCount, 1)).toFixed(1)),
    keyframes: model.keyframes,
    normalPercent: Number((100 * model.normalEstimatedSurfels / Math.max(model.surfelCount, 1)).toFixed(1)),
    rawSampleCount: model.rawSampleCount,
    surfelCount: model.surfelCount,
    voxelSizeMeters: model.voxelSizeMeters,
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
  modelViewMode: ModelViewMode
): void {
  console.log('PANORAMIC_RENDER_METRICS', JSON.stringify({
    buildMs: Number(model.buildMs.toFixed(2)),
    cameraColorPercent: Number((100 * model.cameraColoredSurfels / Math.max(model.surfelCount, 1)).toFixed(1)),
    canvasHeight,
    canvasWidth,
    keyframes: model.keyframes,
    modelRevision,
    normalPercent: Number((100 * model.normalEstimatedSurfels / Math.max(model.surfelCount, 1)).toFixed(1)),
    presentationFormat,
    rawSampleCount: model.rawSampleCount,
    surfelCount: model.surfelCount,
    viewMode: MODEL_VIEW_MODES.find((mode) => mode.value === modelViewMode)?.label ?? modelViewMode,
  }));
}

function logKeyframeProfile({
  appendMs,
  cameraColoredSurfels,
  keyframes,
  retainedSamples,
  surfelCount,
}: {
  appendMs: number;
  cameraColoredSurfels: number;
  keyframes: number;
  retainedSamples: number;
  surfelCount: number;
}): void {
  console.log('PANORAMIC_KEYFRAME_PROFILE', JSON.stringify({
    appendMs: Number(appendMs.toFixed(2)),
    cameraColorPercent: Number((100 * cameraColoredSurfels / Math.max(surfelCount, 1)).toFixed(1)),
    keyframes,
    retainedSamples,
    surfelCount,
  }));
}

function modelFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `standard-camera-scene-${stamp}.ply`;
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
    minHeight: COMMAND_BUTTON_HEIGHT * 2 + COMMAND_BUTTON_GAP,
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
