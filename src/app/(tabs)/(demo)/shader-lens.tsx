import * as Device from 'expo-device';
import { useFocusEffect } from 'expo-router';
import * as React from 'react';
import { Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';

import {
  Host,
  Picker,
  Slider,
  SymbolView,
  Text as UIText,
  disabled as disabledModifier,
  pickerStyle,
  tag,
} from '@/components/demo-platform-controls';
import { DemoPageFrame } from '@/components/demo-page-frame';
import { useCamera } from '@/contexts/CameraContext';
import {
  closeCameraFrame,
  createBgraCameraFrameSource,
  getCameraFrameByteLength,
  getCameraFrameNumber,
  getCameraFrameTextureFormat,
  type CameraFrameUploadSource,
  uploadCameraFrameToTexture,
} from '@/lib/camera-frame-upload';
import { displayFacingMode } from '@/lib/camera-facing';
import { configureWebGpuCanvas } from '@/lib/webgpu-canvas';
import { createWebGpuPerfProbe, nowMs } from '@/lib/webgpu-perf';
import { ImageCapture } from '../../../../modules/standard-camera';

// @ref LLP 0010#demo-2-shader-playground — Live camera frames flow through
// getUserMedia + ImageCapture into a WebGPU texture, then selectable WGSL
// fragment shaders process the frame without a WASM or native CV runtime.

const SHADER = /* wgsl */ `
struct Uniforms {
  effect: f32,
  time: f32,
  texelX: f32,
  texelY: f32,
  intensity: f32,
  rotate: f32,
  mirror: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  let p = positions[idx];
  var out: VsOut;
  out.position = vec4f(p, 0.0, 1.0);
  out.uv = vec2f((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
  return out;
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn previewUv(uv: vec2f) -> vec2f {
  var s = uv;
  if (u.mirror > 0.5) {
    s.x = 1.0 - s.x;
  }
  if (u.rotate < 0.5) {
    return s;
  }
  return vec2f(s.y, 1.0 - s.x);
}

fn sampleAt(uv: vec2f) -> vec4f {
  return textureSample(srcTex, srcSampler, clamp(previewUv(uv), vec2f(0.0), vec2f(1.0)));
}

fn posterize(c: vec4f) -> vec4f {
  let levels = 3.0 + floor((1.0 - u.intensity) * 21.0);
  return vec4f(floor(c.rgb * levels) / levels, c.a);
}

fn edges(uv: vec2f) -> vec4f {
  let t = vec2f(u.texelX, u.texelY);
  let tl = luma(sampleAt(uv + t * vec2f(-1.0, -1.0)).rgb);
  let tc = luma(sampleAt(uv + t * vec2f( 0.0, -1.0)).rgb);
  let tr = luma(sampleAt(uv + t * vec2f( 1.0, -1.0)).rgb);
  let ml = luma(sampleAt(uv + t * vec2f(-1.0,  0.0)).rgb);
  let mr = luma(sampleAt(uv + t * vec2f( 1.0,  0.0)).rgb);
  let bl = luma(sampleAt(uv + t * vec2f(-1.0,  1.0)).rgb);
  let bc = luma(sampleAt(uv + t * vec2f( 0.0,  1.0)).rgb);
  let br = luma(sampleAt(uv + t * vec2f( 1.0,  1.0)).rgb);
  let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  let e = clamp(length(vec2f(gx, gy)) * (2.0 + u.intensity * 5.0), 0.0, 1.0);
  return vec4f(vec3f(e), 1.0);
}

fn heat(c: vec4f) -> vec4f {
  let y = luma(c.rgb);
  let r = smoothstep(0.25, 0.85, y);
  let g = 1.0 - abs(y - 0.55) * 2.0;
  let b = 1.0 - smoothstep(0.1, 0.65, y);
  let heatColor = clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0));
  return vec4f(mix(c.rgb, heatColor, clamp(u.intensity, 0.0, 1.0)), 1.0);
}

fn kaleidoscope(uv: vec2f) -> vec4f {
  let segments = 1.0 + floor(clamp(u.intensity, 0.0, 1.0) * 9.0);
  if (segments < 1.5) {
    return sampleAt(uv);
  }
  let center = uv - vec2f(0.5);
  let radius = length(center);
  let pi = 3.14159265;
  let angle = atan2(center.y, center.x) + sin(u.time * 0.35) * 0.2;
  let folded = abs(fract(angle / (2.0 * pi) * segments) - 0.5) * (2.0 * pi / segments);
  let sampleUv = vec2f(0.5) + vec2f(cos(folded), sin(folded)) * radius;
  return sampleAt(sampleUv);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let color = sampleAt(in.uv);
  if (u.effect < 0.5) {
    return color;
  }
  if (u.effect < 1.5) {
    return posterize(color);
  }
  if (u.effect < 2.5) {
    return edges(in.uv);
  }
  if (u.effect < 3.5) {
    return heat(color);
  }
  return kaleidoscope(in.uv);
}
`;

const SYNTHETIC_SIZE = 256;
const SYNTHETIC_FALLBACK_DELAY_MS = 3000;
const FRAME_UPLOAD_INTERVAL_MS = 33;
const CAMERA_SWITCH_PREVIEW_HOLD_MS = 1800;
const DEMO_CAPTURE_CONSTRAINTS = { width: 640, height: 480, frameRate: 30 } as const;

const EFFECTS = [
  { label: 'Original', value: 0 },
  { label: 'Posterize', value: 1 },
  { label: 'Edges', value: 2 },
  { label: 'Heat', value: 3 },
  { label: 'Kaleido', value: 4 },
] as const;

interface FrameDimensions {
  height: number;
  width: number;
}

export default function ShaderLensScreen(): React.JSX.Element {
  const ref = useCanvasRef();
  const { device, adapter } = useDevice();
  const {
    stream,
    status: cameraStatus,
    error: cameraError,
    constraints,
    settings,
    facingModeAvailability,
    userStopped,
    externalLocked,
    start,
    applyConstraints,
  } = useCamera();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [effect, setEffect] = React.useState<(typeof EFFECTS)[number]['value']>(0);
  const [intensity, setIntensity] = React.useState(0.65);
  const [status, setStatus] = React.useState('initializing');
  const [source, setSource] = React.useState<'pending' | 'camera' | 'synthetic'>('pending');
  const [fps, setFps] = React.useState('0.0');
  const [frameDimensions, setFrameDimensions] = React.useState<FrameDimensions | null>(null);
  const [lastFrameNumber, setLastFrameNumber] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [lastGrabError, setLastGrabError] = React.useState<string | null>(null);

  const effectRef = React.useRef(effect);
  const intensityRef = React.useRef(intensity);
  const cameraStatusRef = React.useRef(cameraStatus);
  const imageCaptureRef = React.useRef<ImageCapture | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const frameDimensionsRef = React.useRef<FrameDimensions | null>(null);
  const lastGrabErrorRef = React.useRef<string | null>(null);
  const preserveCameraPreviewUntilRef = React.useRef(0);
  const previewRotatesRef = React.useRef(false);
  const mirrorRef = React.useRef(false);
  const sourceRef = React.useRef(source);
  const didAutoStartCameraRef = React.useRef(false);
  // On real hardware we always suppress the synthetic test pattern — both
  // the brief flash before the first real frame arrives and the post-Stop
  // case look misleading. The placeholder overlay covers the canvas during
  // those windows. On the simulator (no AVCaptureDevice) we keep synthetic
  // as the demo's hero animation. `Device.isDevice` is stable for the
  // process lifetime, so a ref initialized once is sufficient.
  const suppressSyntheticRef = React.useRef(Device.isDevice);

  const setFrameInfo = React.useCallback((width: number, height: number): void => {
    const previous = frameDimensionsRef.current;
    if (previous?.width === width && previous.height === height) return;
    const next = { height, width };
    frameDimensionsRef.current = next;
    setFrameDimensions(next);
  }, []);

  const setGrabError = React.useCallback((message: string | null): void => {
    if (lastGrabErrorRef.current === message) return;
    lastGrabErrorRef.current = message;
    setLastGrabError(message);
  }, []);

  React.useEffect(() => {
    effectRef.current = effect;
  }, [effect]);

  React.useEffect(() => {
    intensityRef.current = intensity;
  }, [intensity]);

  React.useEffect(() => {
    cameraStatusRef.current = cameraStatus;
  }, [cameraStatus]);

  React.useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  React.useEffect(() => {
    if (stream || (cameraStatus !== 'idle' && cameraStatus !== 'stopping' && cameraStatus !== 'ended')) {
      return;
    }
    preserveCameraPreviewUntilRef.current = 0;
    sourceRef.current = 'pending';
    frameDimensionsRef.current = null;
    setGrabError(null);
    setSource('pending');
    setFrameDimensions(null);
    setLastFrameNumber(null);
  }, [cameraStatus, setGrabError, stream]);

  // Auto-start only when there is no live stream. We deliberately consume
  // whatever resolution Home (or the previous demo) negotiated — the demo's
  // WGSL pipeline scales to whatever frames arrive, and tearing down a live
  // stream to demand exact 1280x720 used to leave the rest of the app
  // camera-less if gUM rejected the new constraints. The user can change
  // resolution from Home if they want a different mode for the demo.
  React.useEffect(() => {
    if (didAutoStartCameraRef.current) return;
    if (userStopped || externalLocked) return;
    if (cameraStatus === 'requesting' || cameraStatus === 'starting' || cameraStatus === 'stopping') return;
    didAutoStartCameraRef.current = true;
    if (stream) return;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraStatus, userStopped, externalLocked, stream]);

  React.useEffect(() => {
    if (!stream) {
      imageCaptureRef.current = null;
      setGrabError(null);
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      imageCaptureRef.current = null;
      setGrabError(null);
      return;
    }
    try {
      imageCaptureRef.current = new ImageCapture(track);
      setGrabError(null);
    } catch (e) {
      imageCaptureRef.current = null;
      setGrabError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    return () => {
      imageCaptureRef.current = null;
    };
  }, [setGrabError, stream]);

  useFocusEffect(
    React.useCallback(() => {
    if (!device) return undefined;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const startRender = (): void => {
      try {
        const profile = createWebGpuPerfProbe('shader-lens', {
          uploadIntervalMs: FRAME_UPLOAD_INTERVAL_MS,
        });
        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        const { context } = configureWebGpuCanvas(ref, device, presentationFormat);

        const shaderModule = device.createShaderModule({ code: SHADER });
        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module: shaderModule, entryPoint: 'vs_main' },
          fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: presentationFormat }] },
          primitive: { topology: 'triangle-list' },
        });

        const sampler = device.createSampler({
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
          magFilter: 'linear',
          minFilter: 'linear',
        });

        const uniformBuffer = device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        let cameraTexture: GPUTexture | null = null;
        let bindGroup: GPUBindGroup | null = null;
        let texWidth = 0;
        let texHeight = 0;
        let texFormat: GPUTextureFormat | null = null;

        const ensureTexture = (width: number, height: number, format: GPUTextureFormat): GPUBindGroup => {
          if (cameraTexture && texWidth === width && texHeight === height && texFormat === format) {
            return bindGroup!;
          }
          if (cameraTexture) cameraTexture.destroy();
          cameraTexture = device.createTexture({
            size: { width, height },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: cameraTexture.createView() },
              { binding: 2, resource: sampler },
            ],
          });
          texWidth = width;
          texHeight = height;
          texFormat = format;
          return bindGroup;
        };

        const syntheticPixels = new Uint8Array(SYNTHETIC_SIZE * SYNTHETIC_SIZE * 4);
        const startedAt = Date.now();
        let frames = 0;
        let lastReport = startedAt;
        let lastUpload = 0;
        let lastReportedSource: 'camera' | 'synthetic' | null = null;
        let lastSeenFrameNumber: number | null = null;

        const renderFrame = async (): Promise<void> => {
          if (cancelled) return;
          const now = Date.now();
          const elapsed = (now - startedAt) / 1000;
          const shouldUpload = bindGroup == null || now - lastUpload >= FRAME_UPLOAD_INTERVAL_MS;
          let frameToClose: CameraFrameUploadSource | null = null;

          if (shouldUpload) {
            const cameraStatusNow = cameraStatusRef.current;
            const cameraMayDeliverFrames =
              cameraStatusNow === 'requesting' ||
              cameraStatusNow === 'starting' ||
              cameraStatusNow === 'playing';
            let frame: CameraFrameUploadSource | null = null;
            let frameSource: 'camera' | 'synthetic' = 'synthetic';
            const imageCapture = imageCaptureRef.current;

            if (!cameraMayDeliverFrames && sourceRef.current === 'camera') {
              lastReportedSource = null;
              sourceRef.current = 'pending';
              setSource('pending');
              setGrabError(null);
            }

            if (imageCapture && cameraMayDeliverFrames) {
              if (imageCapture.track.readyState === 'ended') {
                if (imageCaptureRef.current === imageCapture) {
                  imageCaptureRef.current = null;
                }
                setGrabError(null);
              } else {
                try {
                  const bitmap = await profile.timeAsync('grabFrame', () => imageCapture.grabFrame());
                  frame = bitmap;
                  frameSource = 'camera';
                  preserveCameraPreviewUntilRef.current = 0;
                  lastSeenFrameNumber = getCameraFrameNumber(bitmap);
                  if (lastSeenFrameNumber !== null) profile.recordFrameNumber(lastSeenFrameNumber);
                  setGrabError(null);
                } catch (e) {
                  if (isEndedTrackGrabError(e)) {
                    if (imageCaptureRef.current === imageCapture) {
                      imageCaptureRef.current = null;
                    }
                    setGrabError(null);
                  } else {
                    setGrabError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
                  }
                }
              }
            }

            if (
              !frame &&
              bindGroup &&
              sourceRef.current === 'camera' &&
              cameraMayDeliverFrames &&
              now < preserveCameraPreviewUntilRef.current
            ) {
              lastUpload = now;
            } else if (
              !frame &&
              !suppressSyntheticRef.current &&
              now - startedAt >= SYNTHETIC_FALLBACK_DELAY_MS
            ) {
              fillTestPattern(syntheticPixels, SYNTHETIC_SIZE, elapsed);
              frame = createBgraCameraFrameSource(SYNTHETIC_SIZE, SYNTHETIC_SIZE, syntheticPixels);
            } else if (!frame) {
              lastUpload = now;
              profile.count('uploadSkips');
            }
            if (cancelled) return;

            if (frame) {
              if (frameSource !== lastReportedSource || sourceRef.current !== frameSource) {
                lastReportedSource = frameSource;
                sourceRef.current = frameSource;
                setSource(frameSource);
              }

              setFrameInfo(frame.width, frame.height);
              ensureTexture(frame.width, frame.height, getCameraFrameTextureFormat(frame));
              profile.count(frameSource === 'camera' ? 'cameraUploads' : 'syntheticUploads');
              profile.count('uploadedBytes', getCameraFrameByteLength(frame));
              profile.time('uploadTexture', () => uploadCameraFrameToTexture(device, cameraTexture!, frame));
              frameToClose = frame;
              lastUpload = now;
            }
          }

          if (!bindGroup) {
            rafRef.current = requestAnimationFrame(() => {
              void renderFrame();
            });
            return;
          }

          const rotatesPreview = previewRotatesRef.current && texWidth > texHeight;
          device.queue.writeBuffer(
            uniformBuffer,
            0,
            new Float32Array([
              effectRef.current,
              elapsed,
              1 / (rotatesPreview ? texHeight : texWidth),
              1 / (rotatesPreview ? texWidth : texHeight),
              intensityRef.current,
              rotatesPreview ? 1 : 0,
              mirrorRef.current ? 1 : 0,
              0,
            ])
          );

          const renderStart = nowMs();
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0.03, g: 0.04, b: 0.06, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.draw(3);
          pass.end();
          device.queue.submit([encoder.finish()]);
          context.present();
          if (frameToClose) closeCameraFrame(frameToClose);
          profile.duration('renderSubmitPresent', nowMs() - renderStart);

          frames += 1;
          profile.count('renderFrames');
          if (now - lastReport >= 1000) {
            const fpsValue = frames / ((now - lastReport) / 1000);
            setFps(fpsValue.toFixed(1));
            if (lastSeenFrameNumber !== null) {
              setLastFrameNumber(lastSeenFrameNumber);
            }
            profile.report({
              cameraStatus: cameraStatusRef.current,
              fps: Number(fpsValue.toFixed(1)),
              height: texHeight,
              source: sourceRef.current,
              width: texWidth,
            });
            frames = 0;
            lastReport = now;
          }

          rafRef.current = requestAnimationFrame(() => {
            void renderFrame();
          });
        };

        setStatus(`ok - ${adapter?.info?.vendor ?? 'unknown adapter'}`);
        rafRef.current = requestAnimationFrame(() => {
          void renderFrame();
        });

        cleanup = (): void => {
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          if (cameraTexture) cameraTexture.destroy();
          uniformBuffer.destroy();
        };
      } catch (e) {
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        setError(message);
        setStatus('error');
      }
    };

    const timer = setTimeout(startRender, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      cleanup?.();
    };
  }, [adapter, device, ref, setFrameInfo, setGrabError])
  );

  // Drive Start/Stop off the context's status machine, not `stream != null`.
  // The stream stays non-null across the 'ended' transition (track ended by
  // the OS or another app), and using `stream != null` there left the nav
  // button claiming "Stop" against a camera that had already stopped. The
  // status machine flips to 'idle'/'ended'/'error' in those cases and the
  // button switches back to Start, matching the real device state.
  const cameraOn = cameraStatus === 'playing';
  const isDesktop = windowWidth >= 1040;
  const isWebDesktop = Platform.OS === 'web' && isDesktop;
  previewRotatesRef.current = !isDesktop;
  const targetPreviewAspect = isDesktop ? 4 / 3 : DEMO_CAPTURE_CONSTRAINTS.height / DEMO_CAPTURE_CONSTRAINTS.width;
  const previewAspect = frameDimensions
    ? isDesktop
      ? frameDimensions.width / frameDimensions.height
      : frameDimensions.width > frameDimensions.height
        ? frameDimensions.height / frameDimensions.width
        : frameDimensions.width / frameDimensions.height
    : targetPreviewAspect;
  const previewMaxHeight = Math.max(240, windowHeight - (isWebDesktop ? 180 : 440));
  const previewMaxWidth = Math.max(240, isWebDesktop ? windowWidth - 456 : windowWidth - 32);
  const previewStageWidth = Math.max(240, Math.min(previewMaxWidth, previewMaxHeight * targetPreviewAspect));
  const previewStageHeight = previewStageWidth / targetPreviewAspect;
  const previewWidth = Math.min(previewStageWidth, previewStageHeight * previewAspect);
  const previewHeight = previewWidth / previewAspect;
  const cameraFacing = displayFacingMode({ constraints, settings });
  // @ref LLP 0021#decision — Demo Back controls stay visible but disabled
  // when the web provider proves no environment camera exists.
  const backFacingDisabled = facingModeAvailability.environment === 'unavailable';
  React.useEffect(() => {
    mirrorRef.current = cameraFacing === 'user';
  }, [cameraFacing]);

  const setFacing = React.useCallback(
    (facingMode: 'user' | 'environment'): void => {
      if (facingMode === 'environment' && backFacingDisabled) return;
      if (sourceRef.current === 'camera') {
        preserveCameraPreviewUntilRef.current = Date.now() + CAMERA_SWITCH_PREVIEW_HOLD_MS;
      }
      // Pass only `facingMode` so applyConstraints merges into whatever
      // resolution Home is using — overriding with `DEMO_CAPTURE_CONSTRAINTS`
      // would force a restart and risk a failed gUM dropping the global
      // stream.
      applyConstraints({ facingMode });
    },
    [applyConstraints, backFacingDisabled]
  );

  // On real hardware we cover the canvas with a centered SF Symbol any time
  // the demo isn't actively rendering camera frames — that includes the
  // post-Stop case and the brief startup window before the first frame
  // lands. On the simulator we keep the synthetic pattern as the visual.
  const showStoppedPlaceholder = Device.isDevice && source !== 'camera';

  const cameraLine = (() => {
    if (typeof settings?.width === 'number' && typeof settings?.height === 'number') {
      const fpsPart = typeof settings.frameRate === 'number'
        ? ` @ ${Math.round(settings.frameRate)} fps`
        : '';
      return `${settings.width}x${settings.height}${fpsPart} · ${cameraStatus}`;
    }
    return cameraStatus;
  })();

  return (
    <>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic">
        <DemoPageFrame
          action="standard-camera"
          preview={
            <View style={[styles.previewStage, { height: previewStageHeight, width: previewStageWidth }]}>
              <Canvas ref={ref} style={[styles.canvas, { height: previewHeight, width: previewWidth }]} />
              {showStoppedPlaceholder ? (
                <View pointerEvents="none" style={styles.stoppedOverlay}>
                  <SymbolView
                    name="video.slash.fill"
                    size={56}
                    weight="semibold"
                    tintColor="#94a3b8"
                  />
                </View>
              ) : null}
            </View>
          }
          controls={
            <View style={styles.controls}>
              <Host style={styles.pickerHost}>
                <Picker
                  modifiers={[pickerStyle('segmented')]}
                  label="Camera"
                  selection={cameraFacing}
                  onSelectionChange={(value) => setFacing(value as 'user' | 'environment')}>
                  <UIText modifiers={[tag('environment'), disabledModifier(backFacingDisabled)]}>Back</UIText>
                  <UIText modifiers={[tag('user')]}>Front</UIText>
                </Picker>
              </Host>

              <Host style={styles.pickerHost}>
                <Picker
                  modifiers={[pickerStyle('segmented')]}
                  label="Effect"
                  selection={effect}
                  onSelectionChange={(value) =>
                    setEffect(value as (typeof EFFECTS)[number]['value'])
                  }>
                  {EFFECTS.map((item) => (
                    <UIText key={item.value} modifiers={[tag(item.value)]}>
                      {item.label}
                    </UIText>
                  ))}
                </Picker>
              </Host>

              <View style={styles.intensityBlock}>
                <View style={styles.intensityHeader}>
                  <Text style={styles.intensityLabel}>Intensity</Text>
                  <Text style={styles.intensityValue}>{Math.round(intensity * 100)}%</Text>
                </View>
                <View style={styles.sliderInset}>
                  <Host style={styles.sliderHost}>
                    <Slider value={intensity} min={0} max={1} onValueChange={setIntensity} />
                  </Host>
                </View>
              </View>
            </View>
          }
          hud={
            <View style={styles.hud}>
              <Text style={styles.hudText}>Shader lens · {status}</Text>
              <Text style={styles.hudSub}>camera: {cameraLine}</Text>
              <Text style={styles.hudSub}>render: {fps} fps · source: {source}</Text>
              {lastFrameNumber !== null && cameraOn ? (
                <Text style={styles.hudSub}>iOS frames delivered: {lastFrameNumber}</Text>
              ) : null}
              {cameraError ? <Text style={styles.hudError}>camera error: {cameraError}</Text> : null}
              {lastGrabError && source !== 'camera' ? (
                <Text style={styles.hudSub}>grabFrame: {lastGrabError}</Text>
              ) : null}
              {error ? <Text style={styles.hudError}>{error}</Text> : null}
            </View>
          }
        />
      </ScrollView>
    </>
  );
}

function fillTestPattern(buf: Uint8Array, size: number, t: number): void {
  const phase = (t * 60) | 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const wave = (Math.sin((x + phase) * 0.08) + Math.cos((y - phase) * 0.07)) * 0.5 + 0.5;
      const diag = (x + y + phase) & 0xff;
      buf[i] = (255 - diag) & 0xff;
      buf[i + 1] = Math.round(wave * 255);
      buf[i + 2] = diag;
      buf[i + 3] = 255;
    }
  }
}

function isEndedTrackGrabError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'InvalidStateError' &&
    /ended/.test(error.message)
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#080b12',
  },
  content: {
    alignItems: 'center',
    gap: 12,
    paddingBottom: 32,
  },
  canvas: {
    backgroundColor: '#080b12',
  },
  previewStage: {
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  stoppedOverlay: {
    alignItems: 'center',
    backgroundColor: '#000',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  controls: {
    alignSelf: 'stretch',
    gap: 14,
    paddingHorizontal: 16,
  },
  pickerHost: {
    alignSelf: 'stretch',
    height: 34,
  },
  sliderHost: {
    alignSelf: 'stretch',
    height: 32,
  },
  sliderInset: {
    paddingHorizontal: 20,
  },
  intensityBlock: {
    gap: 6,
  },
  intensityHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  intensityLabel: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '700',
  },
  intensityValue: {
    color: '#f8fafc',
    fontFamily: 'Menlo',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  hud: {
    alignSelf: 'stretch',
    gap: 4,
    paddingHorizontal: 16,
    paddingTop: 2,
  },
  hudText: {
    color: '#f8fafc',
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  hudSub: {
    color: '#cbd5e1',
    fontFamily: 'Menlo',
    fontSize: 11,
  },
  hudError: {
    color: '#fca5a5',
    fontFamily: 'Menlo',
    fontSize: 11,
  },
});
