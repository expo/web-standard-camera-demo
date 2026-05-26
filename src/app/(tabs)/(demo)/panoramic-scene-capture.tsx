import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import { Stack, useFocusEffect } from 'expo-router';
import * as Sharing from 'expo-sharing';
import * as React from 'react';
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';
import type { NativeStackHeaderItem } from 'expo-router/build/react-navigation/native-stack';
import type { SFSymbol } from 'sf-symbols-typescript';

import { DemoPageFrame } from '@/components/demo-page-frame';
import { useCamera } from '@/contexts/CameraContext';
import { configureWebGpuCanvas } from '@/lib/webgpu-canvas';
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

const MAX_KEYFRAMES = 36;
const MAX_SURFELS = 72000;
const KEYFRAME_MIN_INTERVAL_MS = 280;
const KEYFRAME_MIN_TRANSLATION_M = 0.1;
const KEYFRAME_MIN_ROTATION_DEG = 10;
const SAMPLE_GRID_X = 44;
const SAMPLE_GRID_Y = 34;
const MIN_DEPTH_M = 0.35;
const MAX_DEPTH_M = 4.8;
const VOXEL_SIZE_M = 0.045;
const SURFEL_STRIDE_FLOATS = 12;
const SURFEL_STRIDE_BYTES = SURFEL_STRIDE_FLOATS * 4;
const QUAD_VERTEX_COUNT = 6;

const CAPTURE_MODEL_SHADER = /* wgsl */ `
struct Uniforms {
  viewProjection: mat4x4f,
  pointScale: vec2f,
  time: f32,
  _pad0: f32,
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
  return out;
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
  let lit = in.color.rgb * (diffuse + alpha * 0.18);
  return vec4f(lit, 1.0);
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

interface CaptureModel {
  boundsMax: Vec3;
  boundsMin: Vec3;
  cameraColoredSurfels: number;
  colorSource: 'camera' | 'depth' | 'mixed';
  keyframes: number;
  normalEstimatedSurfels: number;
  rawSampleCount: number;
  surfelCount: number;
  surfels: Float32Array;
  voxelSizeMeters: number;
}

interface KeyframeSnapshot {
  forward: Vec3;
  position: Vec3;
  time: number;
}

interface SurfelVoxelAccumulator {
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

interface ViewerState {
  distanceScale: number;
  pitch: number;
  yaw: number;
}

type Vec3 = [number, number, number];

const DEFAULT_VIEWER_STATE: ViewerState = {
  distanceScale: 1,
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
  const pointStoreRef = React.useRef<number[]>([]);
  const keyframeRef = React.useRef<KeyframeSnapshot | null>(null);
  const keyframeCountRef = React.useRef(0);
  const modelRef = React.useRef<CaptureModel | null>(null);
  const modelRevisionRef = React.useRef(0);
  const statusRef = React.useRef<CaptureStatus>('checking');
  const surfelCountRef = React.useRef(0);
  const supportCheckedRef = React.useRef(false);
  const viewerRef = React.useRef<ViewerState>(DEFAULT_VIEWER_STATE);
  const viewerGestureStartRef = React.useRef<ViewerState>(DEFAULT_VIEWER_STATE);
  const pinchDistanceStartRef = React.useRef<number | null>(null);
  const [session, setSession] = React.useState<WebXRSession | null>(null);
  const [status, setStatus] = React.useState<CaptureStatus>('checking');
  const [support, setSupport] = React.useState('checking WebXR camera/depth support');
  const [error, setError] = React.useState<string | null>(null);
  const [model, setModel] = React.useState<CaptureModel | null>(null);
  const [viewer, setViewer] = React.useState<ViewerState>(DEFAULT_VIEWER_STATE);
  const [frameInfo, setFrameInfo] = React.useState('waiting for depth frames');
  const [modelInfo, setModelInfo] = React.useState('no capture yet');
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

  React.useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);

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
    pointStoreRef.current = [];
    keyframeRef.current = null;
    keyframeCountRef.current = 0;
    surfelCountRef.current = 0;
    viewerRef.current = DEFAULT_VIEWER_STATE;
    publishModel(null);
    setViewer(DEFAULT_VIEWER_STATE);
    setFrameInfo('waiting for depth frames');
    setModelInfo('no capture yet');
    setLiveSurfelCount(0);
    setCoveragePercent(0);
    setSaveInfo('save after capture');
    setError(null);
    if (!sessionRef.current) {
      setStatus((current) => (current === 'unsupported' ? current : 'idle'));
    }
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
      setStatus(model ? 'captured' : 'idle');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }

  async function captureModel(): Promise<void> {
    const nextModel = buildModel(pointStoreRef.current, keyframeCountRef.current);
    if (!nextModel || nextModel.surfelCount === 0) {
      setError('No valid depth samples have been captured yet.');
      return;
    }
    publishModel(nextModel);
    setModelInfo(formatModelInfo(nextModel));
    setSaveInfo('ready to save .ply');
    setStatus('captured');
    await stopActiveSession();
  }

  // @ref LLP 0020#privacy-and-permissions - Export is an explicit user action
  // and uses the system share sheet; captures are not uploaded or saved silently.
  async function saveModel(): Promise<void> {
    if (!model || saving) return;
    setSaving(true);
    setError(null);
    setSaveInfo('writing .ply');
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        throw new Error('System file sharing is unavailable on this platform.');
      }
      const filename = modelFileName();
      const file = new File(Paths.document, filename);
      const ply = serializeModelAsPly(model);
      file.create({ overwrite: true });
      file.write(ply);
      const savedSize = file.exists ? file.size : ply.length;
      setSaveInfo(`Documents: ${filename} (${formatBytes(savedSize)})`);
      await Sharing.shareAsync(file.uri, {
        dialogTitle: 'Save scene model',
        mimeType: 'model/ply',
        UTI: 'public.data',
      });
      setSaveInfo(`export ready: ${filename} (${formatBytes(savedSize)})`);
    } catch (e) {
      setSaveInfo('save failed');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    } finally {
      setSaving(false);
    }
  }

  const running = session !== null;
  const canStart = status === 'idle' || status === 'captured';
  const canCapture = status === 'scanning' && liveSurfelCount > 0;
  const canSave = model !== null && !saving;
  const transitioning = status === 'requesting' || status === 'ending';
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
        },
        onPanResponderMove: (event, gesture) => {
          if (!model) return;
          const start = viewerGestureStartRef.current;
          const pinchDistance = touchDistance(event.nativeEvent.touches);
          if (pinchDistance !== null && pinchDistanceStartRef.current !== null) {
            setViewer({
              ...start,
              distanceScale: clamp(start.distanceScale * pinchDistanceStartRef.current / pinchDistance, 0.45, 2.4),
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
        },
        onPanResponderTerminate: () => {
          pinchDistanceStartRef.current = null;
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
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
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
          if (modelRevisionRef.current !== lastModelRevision) {
            lastModelRevision = modelRevisionRef.current;
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
          uniforms[16] = 10 / Math.max(width, 1);
          uniforms[17] = 10 / Math.max(height, 1);
          uniforms[18] = elapsed;
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
          if (surfelBuffer && currentModel && currentModel.surfelCount > 0) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.setVertexBuffer(0, surfelBuffer);
            pass.draw(QUAD_VERTEX_COUNT, currentModel.surfelCount);
          }
          pass.end();
          device.queue.submit([encoder.finish()]);
          context.present();

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
                <Text style={styles.stageReadoutValue}>{model ? `${model.surfelCount}` : liveSurfelCount}</Text>
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
              <View style={[styles.commandRow, { width: stageWidth }]}>
                <CommandButton
                  disabled={transitioning || (!running && !canStart) || unsupported}
                  label={running ? 'Stop' : 'Start'}
                  onPress={running ? () => void stopSession() : () => void startSession()}
                  tone={running ? 'danger' : 'primary'}
                />
                <CommandButton
                  disabled={!canCapture}
                  label="Capture"
                  onPress={() => void captureModel()}
                  tone="primary"
                />
                <CommandButton
                  disabled={!canSave}
                  label={saving ? 'Saving' : 'Save'}
                  onPress={() => void saveModel()}
                  tone="primary"
                />
                <CommandButton
                  disabled={transitioning}
                  label="Reset"
                  onPress={resetCapture}
                  tone="secondary"
                />
              </View>

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
        const xrCamera = view.camera;
        const camera = xrCamera ? cameraBinding.getCameraImage(xrCamera) : null;
        const accepted = maybeCaptureKeyframe(
          depth,
          camera,
          view.projectionMatrix,
          view.transform.matrix,
          frame.predictedDisplayTime
        );
        if (accepted) {
          const nextModel = buildModel(pointStoreRef.current, keyframeCountRef.current);
          if (nextModel) {
            publishModel(nextModel);
            setModelInfo(formatModelInfo(nextModel));
          }
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
    }
  }

  function maybeCaptureKeyframe(
    depth: WebXRCPUDepthInformation,
    camera: WebXRCPUCameraImage | null,
    projectionMatrix: Float32Array,
    cameraToWorld: Float32Array,
    time: number
  ): boolean {
    if (keyframeCountRef.current >= MAX_KEYFRAMES || surfelCountRef.current >= MAX_SURFELS) {
      return false;
    }
    const position = extractPosition(cameraToWorld);
    const forward = extractForward(cameraToWorld);
    const last = keyframeRef.current;
    if (last) {
      const elapsed = time - last.time;
      const translation = distance(position, last.position);
      const rotationDeg = angleDegrees(forward, last.forward);
      if (
        elapsed < KEYFRAME_MIN_INTERVAL_MS ||
        (translation < KEYFRAME_MIN_TRANSLATION_M && rotationDeg < KEYFRAME_MIN_ROTATION_DEG)
      ) {
        return false;
      }
    }

    const added = appendDepthSurfels(
      depth,
      camera,
      projectionMatrix,
      cameraToWorld,
      pointStoreRef.current,
      surfelCountRef.current
    );
    if (added.surfelCount <= 0) return false;
    keyframeCountRef.current += 1;
    surfelCountRef.current += added.surfelCount;
    keyframeRef.current = { forward, position, time };
    setCoveragePercent(Math.min(100, Math.round(keyframeCountRef.current / MAX_KEYFRAMES * 100)));
    setFrameInfo(
      `keyframes: ${keyframeCountRef.current}/${MAX_KEYFRAMES} - samples: ${surfelCountRef.current}/${MAX_SURFELS} - camera color: ${added.cameraColoredSurfels > 0 ? 'yes' : 'fallback'}`
    );
    return true;
  }
}

function CommandButton({
  disabled,
  label,
  onPress,
  tone,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  tone: 'danger' | 'primary' | 'secondary';
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.commandButton,
        tone === 'primary' ? styles.commandPrimary : tone === 'danger' ? styles.commandDanger : styles.commandSecondary,
        disabled && styles.commandDisabled,
        pressed && !disabled && styles.commandPressed,
      ]}>
      <Text style={[styles.commandText, tone === 'secondary' && styles.commandTextSecondary]}>{label}</Text>
    </Pressable>
  );
}

function appendDepthSurfels(
  depth: WebXRCPUDepthInformation,
  camera: WebXRCPUCameraImage | null,
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

function sampleDepthMeters(
  values: Float32Array,
  depth: WebXRCPUDepthInformation,
  normDepthBufferFromNormView: Float32Array,
  viewX: number,
  viewY: number
): number {
  const depthPoint = transformNormalizedPoint(normDepthBufferFromNormView, viewX, viewY);
  if (!Number.isFinite(depthPoint.x) || !Number.isFinite(depthPoint.y)) return Number.NaN;
  const px = Math.round(clamp01(depthPoint.x) * Math.max(0, depth.width - 1));
  const py = Math.round(clamp01(depthPoint.y) * Math.max(0, depth.height - 1));
  const rawDepth = values[py * depth.width + px] ?? 0;
  return rawDepth * depth.rawValueToMeters;
}

function estimateWorldNormal(
  values: Float32Array,
  depth: WebXRCPUDepthInformation,
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
function fuseSurfels(points: number[]): SurfelVoxelAccumulator[] {
  const voxels = new Map<string, SurfelVoxelAccumulator>();
  for (let i = 0; i + SURFEL_STRIDE_FLOATS <= points.length; i += SURFEL_STRIDE_FLOATS) {
    const x = points[i] ?? 0;
    const y = points[i + 1] ?? 0;
    const z = points[i + 2] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const rawWeight = points[i + 7] ?? 1;
    const weight = Math.max(Math.abs(rawWeight), 1e-4);
    const key = voxelKey(x, y, z);
    let voxel = voxels.get(key);
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
      voxels.set(key, voxel);
    }
    addSampleToVoxel(voxel, points, i, weight, rawWeight > 0);
  }
  return [...voxels.values()];
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

function buildModel(points: number[], keyframes: number): CaptureModel | null {
  const rawSampleCount = Math.floor(points.length / SURFEL_STRIDE_FLOATS);
  if (rawSampleCount <= 0) return null;
  const fused = fuseSurfels(points);
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

function formatModelInfo(model: CaptureModel): string {
  const size = [
    model.boundsMax[0] - model.boundsMin[0],
    model.boundsMax[1] - model.boundsMin[1],
    model.boundsMax[2] - model.boundsMin[2],
  ];
  return `model: ${model.keyframes} keyframes - ${model.surfelCount} surfels from ${model.rawSampleCount} samples - ${model.normalEstimatedSurfels} normals - ${model.colorSource} color - ${size
    .map((value) => `${Math.max(0, value).toFixed(1)}m`)
    .join(' x ')}`;
}

function serializeModelAsPly(model: CaptureModel): string {
  const lines = [
    'ply',
    'format ascii 1.0',
    'comment standard-camera-app panoramic WebXR depth capture',
    `comment color_source ${model.colorSource}`,
    `comment camera_colored_surfels ${model.cameraColoredSurfels}`,
    `comment estimated_normal_surfels ${model.normalEstimatedSurfels}`,
    `comment raw_surfel_samples ${model.rawSampleCount}`,
    `comment voxel_size_meters ${model.voxelSizeMeters.toFixed(3)}`,
    `element vertex ${model.surfelCount}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header',
  ];
  for (let i = 0; i < model.surfels.length; i += SURFEL_STRIDE_FLOATS) {
    lines.push([
      plyNumber(model.surfels[i] ?? 0),
      plyNumber(model.surfels[i + 1] ?? 0),
      plyNumber(model.surfels[i + 2] ?? 0),
      plyNumber(model.surfels[i + 8] ?? 0),
      plyNumber(model.surfels[i + 9] ?? 1),
      plyNumber(model.surfels[i + 10] ?? 0),
      colorByte(model.surfels[i + 4] ?? 0),
      colorByte(model.surfels[i + 5] ?? 0),
      colorByte(model.surfels[i + 6] ?? 0),
    ].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

function modelFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `standard-camera-scene-${stamp}.ply`;
}

function plyNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(5) : '0.00000';
}

function colorByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 1 : 2)} MB`;
}

function sampleCameraColor(
  camera: WebXRCPUCameraImage,
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

function touchDistance(touches: readonly { pageX: number; pageY: number }[]): number | null {
  if (touches.length < 2) return null;
  const [a, b] = touches;
  if (!a || !b) return null;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

function unprojectViewSample(inverseProjection: Float32Array, viewX: number, viewY: number, depthMeters: number): Vec3 {
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

function transformPoint(matrix: Float32Array, point: Vec3): Vec3 {
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

function transformNormalizedPoint(matrix: Float32Array, x: number, y: number): { x: number; y: number } {
  const tx = matrix[0] * x + matrix[4] * y + matrix[12];
  const ty = matrix[1] * x + matrix[5] * y + matrix[13];
  const tw = matrix[3] * x + matrix[7] * y + matrix[15];
  if (tw !== 0 && tw !== 1) {
    return { x: tx / tw, y: ty / tw };
  }
  return { x: tx, y: ty };
}

function depthPalette(depthMeters: number): Vec3 {
  const t = clamp01((depthMeters - MIN_DEPTH_M) / (MAX_DEPTH_M - MIN_DEPTH_M));
  const near: Vec3 = [1.0, 0.42, 0.14];
  const mid: Vec3 = [0.1, 0.86, 0.72];
  const far: Vec3 = [0.25, 0.34, 1.0];
  return t < 0.55
    ? mixVec3(near, mid, smoothstep(0, 0.55, t))
    : mixVec3(mid, far, smoothstep(0.48, 1, t));
}

function makeModelViewProjection(
  model: CaptureModel | null,
  aspect: number,
  orbit: number,
  viewer: ViewerState
): Float32Array {
  if (!model) {
    return mat4Multiply(perspective(Math.PI / 3.1, aspect, 0.01, 100), lookAt([0, 0.4, 3.4], [0, 0, 0], [0, 1, 0]));
  }
  const center: Vec3 = [
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
  const eye: Vec3 = [
    center[0] + Math.sin(yaw) * horizontalRadius,
    center[1] + Math.sin(viewer.pitch) * radius,
    center[2] + Math.cos(yaw) * horizontalRadius,
  ];
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

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
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

function invertMatrix4(input: Float32Array): Float32Array | null {
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

function extractPosition(matrix: Float32Array): Vec3 {
  return [matrix[12] ?? 0, matrix[13] ?? 0, matrix[14] ?? 0];
}

function extractForward(matrix: Float32Array): Vec3 {
  return normalize([-(matrix[8] ?? 0), -(matrix[9] ?? 0), -(matrix[10] ?? 1)]);
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scaleVec3(v: Vec3, scale: number): Vec3 {
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

function observationFacingNormal(cameraToWorld: Float32Array, cameraPoint: Vec3): Vec3 {
  const pointToCamera = normalize([-cameraPoint[0], -cameraPoint[1], -cameraPoint[2]]);
  return normalize(transformDirection(cameraToWorld, pointToCamera));
}

function angleDegrees(a: Vec3, b: Vec3): number {
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function performanceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
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
  commandRow: {
    flexDirection: 'row',
    gap: 8,
  },
  commandButton: {
    alignItems: 'center',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    minHeight: 42,
    paddingHorizontal: 10,
  },
  commandPrimary: {
    backgroundColor: '#14b8a6',
  },
  commandDanger: {
    backgroundColor: '#ef4444',
  },
  commandSecondary: {
    backgroundColor: 'rgba(148, 163, 184, 0.16)',
    borderColor: 'rgba(148, 163, 184, 0.28)',
    borderWidth: 1,
  },
  commandDisabled: {
    opacity: 0.38,
  },
  commandPressed: {
    opacity: 0.72,
  },
  commandText: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '800',
  },
  commandTextSecondary: {
    color: '#cbd5e1',
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
