import * as Device from 'expo-device';
import { useFocusEffect } from 'expo-router';
import * as React from 'react';
import { Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';

import {
  Host,
  Picker,
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
  getCameraFrameTextureFormat,
  type CameraFrameUploadSource,
  uploadCameraFrameToTexture,
} from '@/lib/camera-frame-upload';
import { cameraFrameFacingMode, displayFacingMode, reportedFacingMode } from '@/lib/camera-facing';
import { configureWebGpuCanvas } from '@/lib/webgpu-canvas';
import { createWebGpuPerfProbe, nowMs } from '@/lib/webgpu-perf';
import { ImageCapture } from '../../../../modules/standard-camera';

// @ref LLP 0010#demo-3-tiny-webgpu-classifier — A no-WASM AI demo: camera
// frames become a WebGPU texture, a WGSL compute shader runs a tiny fixed
// classifier over sampled pixels, and JS only reads back the final scores.

const RENDER_SHADER = /* wgsl */ `
struct RenderUniforms {
  time: f32,
  label: f32,
  confidence: f32,
  rotate: f32,
  mirror: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: RenderUniforms;
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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let uv = previewUv(in.uv);
  let c = textureSample(srcTex, srcSampler, clamp(uv, vec2f(0.0), vec2f(1.0))).rgb;
  return vec4f(c, 1.0);
}
`;

const COMPUTE_SHADER = /* wgsl */ `
struct ComputeUniforms {
  width: f32,
  height: f32,
  time: f32,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> u: ComputeUniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outScores: array<f32, 14>;

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn clamp01(v: f32) -> f32 {
  return clamp(v, 0.0, 1.0);
}

fn samplePixel(x: i32, y: i32) -> vec3f {
  let maxX = max(i32(u.width) - 1, 0);
  let maxY = max(i32(u.height) - 1, 0);
  let p = clamp(vec2i(x, y), vec2i(0), vec2i(maxX, maxY));
  return textureLoad(srcTex, p, 0).rgb;
}

@compute @workgroup_size(1)
fn classify() {
  var brightness = 0.0;
  var lumaSquared = 0.0;
  var warm = 0.0;
  var cool = 0.0;
  var saturation = 0.0;
  var edge = 0.0;
  var topBlue = 0.0;
  var lowerGreen = 0.0;

  for (var y = 0; y < 16; y = y + 1) {
    for (var x = 0; x < 16; x = x + 1) {
      let px = i32((f32(x) + 0.5) / 16.0 * u.width);
      let py = i32((f32(y) + 0.5) / 16.0 * u.height);
      let c = samplePixel(px, py);
      let y0 = luma(c);
      let cx = luma(samplePixel(px + 3, py));
      let cy = luma(samplePixel(px, py + 3));
      let maxChannel = max(max(c.r, c.g), c.b);
      let minChannel = min(min(c.r, c.g), c.b);
      let colorSpread = maxChannel - minChannel;
      let sampleEdge = abs(cx - y0) + abs(cy - y0);

      brightness = brightness + y0;
      lumaSquared = lumaSquared + y0 * y0;
      warm = warm + max(c.r - c.b, 0.0);
      cool = cool + max(c.b - c.r, 0.0);
      saturation = saturation + colorSpread;
      edge = edge + sampleEdge;
      if (y < 5) {
        topBlue = topBlue + max(c.b - max(c.r, c.g) * 0.92, 0.0);
      }
      if (y > 8) {
        lowerGreen = lowerGreen + max(c.g - max(c.r, c.b) * 0.90, 0.0);
      }
    }
  }

  let inv = 1.0 / 256.0;
  brightness = brightness * inv;
  let localContrast = sqrt(max(lumaSquared * inv - brightness * brightness, 0.0));
  warm = warm * inv;
  cool = cool * inv;
  saturation = saturation * inv;
  edge = edge * inv;
  topBlue = topBlue * (1.0 / 80.0);
  lowerGreen = lowerGreen * (1.0 / 112.0);

  let texture = clamp01(smoothstep(0.025, 0.14, edge) * 0.65 + smoothstep(0.035, 0.18, localContrast) * 0.35);
  let lowTexture = 1.0 - smoothstep(0.015, 0.08, edge + localContrast);
  let lowSaturation = 1.0 - smoothstep(0.03, 0.16, saturation);
  let darkness = 1.0 - smoothstep(0.025, 0.14, brightness);
  let covered = clamp01(darkness * (0.25 + lowTexture * 0.45 + lowSaturation * 0.30));
  let colorBias = clamp(warm - cool, -1.0, 1.0);
  let outdoorCue = clamp01(
    smoothstep(0.42, 0.72, brightness) * 0.32 +
    smoothstep(0.012, 0.08, topBlue) * 0.38 +
    smoothstep(0.010, 0.07, lowerGreen) * 0.30
  );

  outScores[0] = covered;
  outScores[1] = clamp01((1.0 - smoothstep(0.16, 0.36, brightness)) * (1.0 - covered * 0.88) * (0.60 + texture * 0.40));
  outScores[2] = clamp01(smoothstep(0.48, 0.78, brightness) * (1.0 - covered));
  outScores[3] = clamp01(smoothstep(0.03, 0.20, colorBias) * smoothstep(0.04, 0.22, saturation) * (1.0 - covered * 0.80));
  outScores[4] = clamp01(smoothstep(0.03, 0.20, -colorBias) * smoothstep(0.04, 0.22, saturation) * (1.0 - covered * 0.80));
  outScores[5] = clamp01(texture * (1.0 - covered * 0.75));
  outScores[6] = clamp01((1.0 - texture) * smoothstep(0.08, 0.35, brightness) * (1.0 - covered));
  outScores[7] = brightness;
  outScores[8] = localContrast;
  outScores[9] = edge;
  outScores[10] = saturation;
  outScores[11] = colorBias;
  outScores[12] = outdoorCue;
  outScores[13] = texture;
}
`;

const SYNTHETIC_SIZE = 256;
const SYNTHETIC_FALLBACK_DELAY_MS = 3000;
const FRAME_UPLOAD_INTERVAL_MS = 33;
const INFERENCE_INTERVAL_MS = 450;
const RELAXED_CAMERA_RETRY_MS = 2500;
const CAMERA_SWITCH_PREVIEW_HOLD_MS = 1800;
const CAMERA_CAPTURE_SETTLE_MS = 180;
const SCORE_FLOATS = 14;
const DEMO_CAPTURE_CONSTRAINTS = { width: 1280, height: 720, frameRate: 30 } as const;
const RELAXED_CAPTURE_CONSTRAINTS = { frameRate: 30 } as const;

const LABELS = [
  { color: '#94a3b8', name: 'Lens covered' },
  { color: '#60a5fa', name: 'Low light' },
  { color: '#facc15', name: 'Bright scene' },
  { color: '#fb923c', name: 'Warm scene' },
  { color: '#22d3ee', name: 'Cool scene' },
  { color: '#f8fafc', name: 'Detailed scene' },
  { color: '#c084fc', name: 'Flat color' },
] as const;

interface FrameDimensions {
  height: number;
  width: number;
}

interface Prediction {
  confidence: number;
  features: {
    brightness: number;
    contrast: number;
    edge: number;
    saturation: number;
  };
  labelIndex: number;
  scores: number[];
  signals: {
    environment: SceneSignal;
    palette: SceneSignal;
    texture: SceneSignal;
  };
}

interface SceneSignal {
  confidence: number;
  label: string;
}

type CaptureProfile = 'demo' | 'relaxed';

const INITIAL_PREDICTION: Prediction = {
  confidence: 0,
  features: { brightness: 0, contrast: 0, edge: 0, saturation: 0 },
  labelIndex: 0,
  scores: LABELS.map(() => 0),
  signals: {
    environment: { confidence: 0, label: 'pending' },
    palette: { confidence: 0, label: 'pending' },
    texture: { confidence: 0, label: 'pending' },
  },
};

export default function NeuralLensScreen(): React.JSX.Element {
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
  const [status, setStatus] = React.useState('initializing');
  const [source, setSource] = React.useState<'pending' | 'camera' | 'synthetic'>('pending');
  const [fps, setFps] = React.useState('0.0');
  const [frameSize, setFrameSize] = React.useState('pending');
  const [frameDimensions, setFrameDimensions] = React.useState<FrameDimensions | null>(null);
  const [prediction, setPrediction] = React.useState<Prediction>(INITIAL_PREDICTION);
  const [error, setError] = React.useState<string | null>(null);
  const [lastGrabError, setLastGrabError] = React.useState<string | null>(null);
  const [inferenceError, setInferenceError] = React.useState<string | null>(null);
  const [captureProfile, setCaptureProfile] = React.useState<CaptureProfile>('demo');

  const imageCaptureRef = React.useRef<ImageCapture | null>(null);
  const imageCaptureMirroredRef = React.useRef(false);
  const imageCaptureAcceptAfterRef = React.useRef(0);
  const rafRef = React.useRef<number | null>(null);
  const lastGrabErrorRef = React.useRef<string | null>(null);
  const frameDimensionsRef = React.useRef<FrameDimensions | null>(null);
  const frameSizeRef = React.useRef('pending');
  const predictionRef = React.useRef(prediction);
  const preserveCameraPreviewUntilRef = React.useRef(0);
  const previewRotatesRef = React.useRef(false);
  const sourceRef = React.useRef(source);
  const didAutoStartCameraRef = React.useRef(false);
  const didRetryRelaxedCameraRef = React.useRef(false);
  // On real hardware we always suppress the synthetic test pattern so the
  // brief startup flash and the post-Stop frame both look intentional. On
  // the simulator we keep synthetic as the visual. Device.isDevice is
  // stable for the process lifetime, so a single initialization is enough.
  const suppressSyntheticRef = React.useRef(Device.isDevice);
  const settingsFacing = reportedFacingMode(settings);
  const cameraFacing = displayFacingMode({ constraints, settings });
  // @ref LLP 0021#decision — Demo Back controls stay visible but disabled
  // when the web provider proves no environment camera exists.
  const backFacingDisabled = facingModeAvailability.environment === 'unavailable';

  const setGrabError = React.useCallback((message: string | null): void => {
    if (lastGrabErrorRef.current === message) return;
    lastGrabErrorRef.current = message;
    setLastGrabError(message);
  }, []);

  const setFrameInfo = React.useCallback((width: number, height: number): void => {
    const previous = frameDimensionsRef.current;
    if (!previous || previous.width !== width || previous.height !== height) {
      const nextDimensions = { height, width };
      frameDimensionsRef.current = nextDimensions;
      setFrameDimensions(nextDimensions);
    }
    const next = `${width}x${height}`;
    if (frameSizeRef.current === next) return;
    frameSizeRef.current = next;
    setFrameSize(next);
  }, []);

  const resetFrameState = React.useCallback((options?: { preserveCameraPreview?: boolean }): void => {
    setGrabError(null);
    if (options?.preserveCameraPreview && sourceRef.current === 'camera') {
      preserveCameraPreviewUntilRef.current = Date.now() + CAMERA_SWITCH_PREVIEW_HOLD_MS;
      return;
    }
    preserveCameraPreviewUntilRef.current = 0;
    sourceRef.current = 'pending';
    frameDimensionsRef.current = null;
    frameSizeRef.current = 'pending';
    setSource('pending');
    setFrameDimensions(null);
    setFrameSize('pending');
  }, [setGrabError]);

  /* eslint-disable react-hooks/set-state-in-effect -- Preserve the existing camera-idle reset sequence. */
  React.useEffect(() => {
    if (stream || (cameraStatus !== 'idle' && cameraStatus !== 'stopping' && cameraStatus !== 'ended')) {
      return;
    }
    didRetryRelaxedCameraRef.current = false;
    setCaptureProfile('demo');
    resetFrameState();
  }, [cameraStatus, resetFrameState, stream]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const retryRelaxedCamera = React.useCallback((): void => {
    if (didRetryRelaxedCameraRef.current) return;
    didRetryRelaxedCameraRef.current = true;
    setCaptureProfile('relaxed');
    resetFrameState();
    void start({
      ...RELAXED_CAPTURE_CONSTRAINTS,
      facingMode: cameraFacing,
    });
  }, [cameraFacing, resetFrameState, start]);

  React.useEffect(() => {
    predictionRef.current = prediction;
  }, [prediction]);

  React.useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  // Auto-start only while focused and only when there is no live stream — see
  // shader-lens for the rationale. We still mark the capture profile as
  // 'demo' for the HUD; the relaxed-fallback effect handles the case where
  // Home's chosen mode can't deliver frames the classifier expects.
  /* eslint-disable react-hooks/set-state-in-effect -- Preserve the existing auto-start profile/reset timing. */
  useFocusEffect(
    React.useCallback(() => {
      if (didAutoStartCameraRef.current) return undefined;
      if (userStopped || externalLocked) return undefined;
      if (cameraStatus === 'requesting' || cameraStatus === 'starting' || cameraStatus === 'stopping') {
        return undefined;
      }
      didAutoStartCameraRef.current = true;
      setCaptureProfile('demo');
      if (!stream) {
        resetFrameState();
        void start();
      }
      return undefined;
    }, [cameraStatus, externalLocked, resetFrameState, start, stream, userStopped])
  );
  /* eslint-enable react-hooks/set-state-in-effect */

  React.useEffect(() => {
    if (didRetryRelaxedCameraRef.current || source === 'camera' || cameraStatus !== 'error' || stream) {
      return;
    }
    retryRelaxedCamera();
  }, [cameraStatus, retryRelaxedCamera, source, stream]);

  React.useEffect(() => {
    if (!stream || source === 'camera' || didRetryRelaxedCameraRef.current) return;
    const timer = setTimeout(() => {
      if (sourceRef.current === 'camera' || didRetryRelaxedCameraRef.current) return;
      retryRelaxedCamera();
    }, RELAXED_CAMERA_RETRY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [retryRelaxedCamera, source, stream]);

  React.useEffect(() => {
    if (!stream) {
      imageCaptureRef.current = null;
      imageCaptureMirroredRef.current = false;
      imageCaptureAcceptAfterRef.current = 0;
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      imageCaptureRef.current = null;
      imageCaptureMirroredRef.current = false;
      imageCaptureAcceptAfterRef.current = 0;
      return;
    }
    try {
      // @ref LLP 0010#frame-bound-demo-mirroring — Snapshot mirroring with
      // the ImageCapture; stopped/replacing iOS tracks can lose facingMode
      // before an awaited grabFrame() returns.
      const mirrored = cameraFrameFacingMode(track.getSettings()) === 'user';
      imageCaptureRef.current = new ImageCapture(track);
      imageCaptureMirroredRef.current = mirrored;
      // @ref LLP 0010#frame-bound-demo-mirroring — Avoid accepting the
      // replacement camera's transient exposure-settling frames without
      // depending on native-only frame diagnostics.
      imageCaptureAcceptAfterRef.current = Date.now() + CAMERA_CAPTURE_SETTLE_MS;
    } catch (e) {
      imageCaptureRef.current = null;
      imageCaptureMirroredRef.current = false;
      imageCaptureAcceptAfterRef.current = 0;
      setGrabError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    return () => {
      imageCaptureRef.current = null;
      imageCaptureMirroredRef.current = false;
      imageCaptureAcceptAfterRef.current = 0;
    };
  }, [setGrabError, stream]);

  useFocusEffect(
    React.useCallback(() => {
    if (!device) return undefined;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const startRender = (): void => {
      try {
        const profile = createWebGpuPerfProbe('neural-lens', {
          inferenceIntervalMs: INFERENCE_INTERVAL_MS,
          uploadIntervalMs: FRAME_UPLOAD_INTERVAL_MS,
        });
        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        const { context } = configureWebGpuCanvas(ref, device, presentationFormat);

        const renderModule = device.createShaderModule({ code: RENDER_SHADER });
        const computeModule = device.createShaderModule({ code: COMPUTE_SHADER });
        const renderPipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module: renderModule, entryPoint: 'vs_main' },
          fragment: { module: renderModule, entryPoint: 'fs_main', targets: [{ format: presentationFormat }] },
          primitive: { topology: 'triangle-list' },
        });
        const computePipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: computeModule, entryPoint: 'classify' },
        });

        const sampler = device.createSampler({
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
          magFilter: 'linear',
          minFilter: 'linear',
        });
        const renderUniformBuffer = device.createBuffer({
          size: 32,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const computeUniformBuffer = device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const scoreBuffer = device.createBuffer({
          size: SCORE_FLOATS * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const readbackBuffer = device.createBuffer({
          size: SCORE_FLOATS * 4,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });

        let cameraTexture: GPUTexture | null = null;
        let renderBindGroup: GPUBindGroup | null = null;
        let computeBindGroup: GPUBindGroup | null = null;
        let texWidth = 0;
        let texHeight = 0;
        let texFormat: GPUTextureFormat | null = null;

        const ensureTexture = (width: number, height: number, format: GPUTextureFormat): void => {
          if (cameraTexture && texWidth === width && texHeight === height && texFormat === format) return;
          if (cameraTexture) cameraTexture.destroy();
          cameraTexture = device.createTexture({
            size: { width, height },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          const view = cameraTexture.createView();
          renderBindGroup = device.createBindGroup({
            layout: renderPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: renderUniformBuffer } },
              { binding: 1, resource: view },
              { binding: 2, resource: sampler },
            ],
          });
          computeBindGroup = device.createBindGroup({
            layout: computePipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: computeUniformBuffer } },
              { binding: 1, resource: view },
              { binding: 2, resource: { buffer: scoreBuffer } },
            ],
          });
          texWidth = width;
          texHeight = height;
          texFormat = format;
        };

        const syntheticPixels = new Uint8Array(SYNTHETIC_SIZE * SYNTHETIC_SIZE * 4);
        const startedAt = Date.now();
        let frames = 0;
        let lastReport = startedAt;
        let lastUpload = 0;
        let lastInference = 0;
        let inferencePending = false;
        let lastReportedSource: 'camera' | 'synthetic' | null = null;
        let activeTextureMirrored = false;

        const runInference = async (elapsed: number): Promise<void> => {
          if (!computeBindGroup || !cameraTexture || !texWidth || !texHeight || inferencePending) return;
          inferencePending = true;
          try {
            device.queue.writeBuffer(
              computeUniformBuffer,
              0,
              new Float32Array([texWidth, texHeight, elapsed, 0])
            );
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(computePipeline);
            pass.setBindGroup(0, computeBindGroup);
            pass.dispatchWorkgroups(1);
            pass.end();
            encoder.copyBufferToBuffer(scoreBuffer, 0, readbackBuffer, 0, SCORE_FLOATS * 4);
            device.queue.submit([encoder.finish()]);
            await profile.timeAsync('inferenceReadback', () => readbackBuffer.mapAsync(GPUMapMode.READ));
            if (cancelled) {
              readbackBuffer.unmap();
              return;
            }
            const mapped = readbackBuffer.getMappedRange();
            const values = new Float32Array(mapped.slice(0));
            readbackBuffer.unmap();
            const next = makePrediction(values);
            predictionRef.current = next;
            setPrediction(next);
            profile.count('inferences');
            setInferenceError(null);
          } catch (e) {
            setInferenceError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
          } finally {
            inferencePending = false;
          }
        };

        const renderFrame = async (): Promise<void> => {
          if (cancelled) return;
          const now = Date.now();
          const elapsed = (now - startedAt) / 1000;
          const shouldUpload = renderBindGroup == null || now - lastUpload >= FRAME_UPLOAD_INTERVAL_MS;
          let frameToClose: CameraFrameUploadSource | null = null;

          if (shouldUpload) {
            let frame: CameraFrameUploadSource | null = null;
            let frameSource: 'camera' | 'synthetic' = 'synthetic';
            let frameMirrored = false;
            const imageCapture = imageCaptureRef.current;
            const imageCaptureMirrored = imageCaptureMirroredRef.current;

            if (imageCapture) {
              try {
                const bitmap = await profile.timeAsync('grabFrame', () => imageCapture.grabFrame());
                if (cancelled || imageCaptureRef.current !== imageCapture) {
                  closeCameraFrame(bitmap);
                } else if (Date.now() < imageCaptureAcceptAfterRef.current) {
                  closeCameraFrame(bitmap);
                  lastUpload = Date.now();
                  setGrabError(null);
                } else {
                  frame = bitmap;
                  frameSource = 'camera';
                  frameMirrored = imageCaptureMirrored;
                  preserveCameraPreviewUntilRef.current = 0;
                  setGrabError(null);
                }
              } catch (e) {
                setGrabError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
              }
            }

            if (
              !frame &&
              renderBindGroup &&
              sourceRef.current === 'camera' &&
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
                if (__DEV__) {
                  console.log(
                    `NEURAL_LENS_SOURCE ${JSON.stringify({
                      height: frame.height,
                      source: frameSource,
                      width: frame.width,
                    })}`
                  );
                }
              }

              setFrameInfo(frame.width, frame.height);
              ensureTexture(frame.width, frame.height, getCameraFrameTextureFormat(frame));
              profile.count(frameSource === 'camera' ? 'cameraUploads' : 'syntheticUploads');
              profile.count('uploadedBytes', getCameraFrameByteLength(frame));
              profile.time('uploadTexture', () => uploadCameraFrameToTexture(device, cameraTexture!, frame));
              activeTextureMirrored = frameSource === 'camera' ? frameMirrored : false;
              frameToClose = frame;
              lastUpload = now;
            }
          }

          if (!renderBindGroup) {
            rafRef.current = requestAnimationFrame(() => {
              void renderFrame();
            });
            return;
          }

          const currentPrediction = predictionRef.current;
          device.queue.writeBuffer(
            renderUniformBuffer,
            0,
            new Float32Array([
              elapsed,
              currentPrediction.labelIndex,
              currentPrediction.confidence,
              previewRotatesRef.current && texWidth > texHeight ? 1 : 0,
              activeTextureMirrored ? 1 : 0,
              0,
              0,
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
          pass.setPipeline(renderPipeline);
          pass.setBindGroup(0, renderBindGroup);
          pass.draw(3);
          pass.end();
          device.queue.submit([encoder.finish()]);
          context.present();
          if (frameToClose) closeCameraFrame(frameToClose);
          profile.duration('renderSubmitPresent', nowMs() - renderStart);

          if (now - lastInference >= INFERENCE_INTERVAL_MS) {
            lastInference = now;
            void runInference(elapsed);
          }

          frames += 1;
          profile.count('renderFrames');
          if (now - lastReport >= 1000) {
            const fpsValue = frames / ((now - lastReport) / 1000);
            setFps(fpsValue.toFixed(1));
            profile.report({
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
          renderUniformBuffer.destroy();
          computeUniformBuffer.destroy();
          scoreBuffer.destroy();
          readbackBuffer.destroy();
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

  const isDesktop = windowWidth >= 1040;
  const isWebDesktop = Platform.OS === 'web' && isDesktop;
  // eslint-disable-next-line react-hooks/refs -- The long-lived WebGPU loop reads this ref between renders.
  previewRotatesRef.current = !isDesktop;
  const targetPreviewAspect = isDesktop ? 4 / 3 : DEMO_CAPTURE_CONSTRAINTS.height / DEMO_CAPTURE_CONSTRAINTS.width;
  const previewAspect = frameDimensions
    ? isDesktop
      ? frameDimensions.width / frameDimensions.height
      : frameDimensions.width > frameDimensions.height
        ? frameDimensions.height / frameDimensions.width
        : frameDimensions.width / frameDimensions.height
    : targetPreviewAspect;
  const previewMaxHeight = Math.max(300, windowHeight - (isWebDesktop ? 180 : 500));
  const previewMaxWidth = Math.max(240, isWebDesktop ? windowWidth - 456 : windowWidth - 32);
  const previewStageWidth = Math.max(240, Math.min(previewMaxWidth, previewMaxHeight * targetPreviewAspect));
  const previewStageHeight = previewStageWidth / targetPreviewAspect;
  const previewWidth = Math.min(previewStageWidth, previewStageHeight * previewAspect);
  const previewHeight = previewWidth / previewAspect;
  const activeLabel = LABELS[prediction.labelIndex] ?? LABELS[0];
  const captureProfileLabel = captureProfile === 'demo' ? 'demo 1280x720@30' : 'relaxed @30';
  const reportedFrameRate =
    typeof settings?.frameRate === 'number' ? `${Math.round(settings.frameRate)} fps` : 'fps pending';
  const cameraSettingsLine =
    typeof settings?.width === 'number' && typeof settings?.height === 'number'
      ? `${settings.width}x${settings.height} · ${reportedFrameRate} · ${settingsFacing ?? 'facing pending'}`
      : 'settings pending';
  const sourceLabel =
    source === 'camera' ? 'Camera frames' : source === 'pending' ? 'Opening camera' : 'Synthetic fallback';
  const signalRows = [
    { label: 'Environment', signal: prediction.signals.environment },
    { label: 'Palette', signal: prediction.signals.palette },
    { label: 'Texture', signal: prediction.signals.texture },
  ] as const;

  const setFacing = React.useCallback(
    (facingMode: 'user' | 'environment'): void => {
      if (facingMode === cameraFacing) return;
      if (facingMode === 'environment' && backFacingDisabled) return;
      didRetryRelaxedCameraRef.current = false;
      setCaptureProfile('demo');
      resetFrameState({ preserveCameraPreview: true });
      // Don't override the user's chosen resolution — applyConstraints
      // merges into the stored constraints, so passing only `facingMode`
      // keeps whatever width/height/frameRate Home had.
      applyConstraints({ facingMode });
    },
    [applyConstraints, backFacingDisabled, cameraFacing, resetFrameState]
  );
  const showStoppedPlaceholder = Device.isDevice && source !== 'camera';

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
            <>
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
              </View>

              <View style={styles.predictionPanel}>
                <Text style={[styles.predictionLabel, { color: activeLabel.color }]}>{activeLabel.name}</Text>
                <Text style={styles.predictionMeta}>{Math.round(prediction.confidence * 100)}% match</Text>
                <View style={styles.captureStatus}>
                  <Text
                    style={[
                      styles.captureBadge,
                      source === 'camera' ? styles.captureBadgeLive : styles.captureBadgeFallback,
                    ]}>
                    {sourceLabel}
                  </Text>
                  <Text style={styles.captureText}>camera: {cameraSettingsLine}</Text>
                  <Text style={styles.captureText}>request: {captureProfileLabel}</Text>
                  <Text style={styles.captureText}>
                    uploaded: {frameSize}
                  </Text>
                </View>
                <View style={styles.signalGrid}>
                  {signalRows.map(({ label, signal }) => (
                    <View key={label} style={styles.signalPill}>
                      <Text style={styles.signalName}>{label}</Text>
                      <Text style={styles.signalValue}>{signal.label}</Text>
                      <Text style={styles.signalConfidence}>{Math.round(signal.confidence * 100)}%</Text>
                    </View>
                  ))}
                </View>
                <View style={styles.bars}>
                  {LABELS.map((label, index) => (
                    <View key={label.name} style={styles.barRow}>
                      <Text style={styles.barLabel}>{label.name}</Text>
                      <View style={styles.barTrack}>
                        <View
                          style={[
                            styles.barFill,
                            {
                              backgroundColor: label.color,
                              width: `${Math.round((prediction.scores[index] ?? 0) * 100)}%`,
                            },
                          ]}
                        />
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            </>
          }
          hud={
            <View style={styles.hud}>
              <Text style={styles.hudText}>Neural lens · {status}</Text>
              <Text style={styles.hudSub}>render: {fps} fps · source: {source} · uploaded: {frameSize}</Text>
              <Text style={styles.hudSub}>
                features: brightness {prediction.features.brightness.toFixed(2)} · contrast{' '}
                {prediction.features.contrast.toFixed(2)} · edge {prediction.features.edge.toFixed(2)} · saturation{' '}
                {prediction.features.saturation.toFixed(2)}
              </Text>
              {cameraError ? <Text style={styles.hudError}>camera error: {cameraError}</Text> : null}
              {lastGrabError && source !== 'camera' ? (
                <Text style={styles.hudSub}>grabFrame: {lastGrabError}</Text>
              ) : null}
              {inferenceError ? <Text style={styles.hudError}>inference: {inferenceError}</Text> : null}
              {error ? <Text style={styles.hudError}>{error}</Text> : null}
            </View>
          }
        />
      </ScrollView>
    </>
  );
}

function makePrediction(values: Float32Array): Prediction {
  const scores = Array.from(values.slice(0, LABELS.length), finite01);
  let labelIndex = 0;
  for (let i = 1; i < scores.length; i += 1) {
    if (scores[i] > scores[labelIndex]) labelIndex = i;
  }
  const covered = scores[0] ?? 0;
  const brightness = finite01(values[7]);
  const contrast = finite01(values[8]);
  const edge = finite01(values[9]);
  const saturation = finite01(values[10]);
  const colorBias = finiteSigned(values[11]);
  const outdoorCue = finite01(values[12]);
  const texture = finite01(values[13]);

  return {
    confidence: scores[labelIndex] ?? 0,
    features: { brightness, contrast, edge, saturation },
    labelIndex,
    scores,
    signals: {
      environment: makeEnvironmentSignal(outdoorCue, covered),
      palette: makePaletteSignal(colorBias, saturation),
      texture: makeTextureSignal(texture),
    },
  };
}

function finite01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function finiteSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function makeEnvironmentSignal(outdoorCue: number, covered: number): SceneSignal {
  if (covered > 0.72) return { confidence: covered, label: 'blocked' };
  if (outdoorCue >= 0.58) return { confidence: outdoorCue, label: 'outdoor-ish' };
  if (outdoorCue <= 0.36) return { confidence: Math.min(0.92, 1 - outdoorCue), label: 'indoor-ish' };
  return { confidence: 1 - Math.abs(outdoorCue - 0.5), label: 'mixed light' };
}

function makePaletteSignal(colorBias: number, saturation: number): SceneSignal {
  const strength = Math.min(1, Math.abs(colorBias) * 4 + saturation * 0.8);
  if (colorBias > 0.08) return { confidence: Math.max(0.36, strength), label: 'warm' };
  if (colorBias < -0.08) return { confidence: Math.max(0.36, strength), label: 'cool' };
  return { confidence: Math.max(0.35, 1 - Math.abs(colorBias) * 6), label: 'neutral' };
}

function makeTextureSignal(texture: number): SceneSignal {
  if (texture >= 0.62) return { confidence: texture, label: 'high detail' };
  if (texture >= 0.34) return { confidence: Math.min(0.78, texture + 0.18), label: 'some detail' };
  return { confidence: Math.min(0.9, 1 - texture), label: 'flat' };
}

function fillTestPattern(buf: Uint8Array, size: number, t: number): void {
  const phase = (t * 70) | 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const cx = x - size / 2;
      const cy = y - size / 2;
      const ring = Math.sin(Math.sqrt(cx * cx + cy * cy) * 0.08 - t * 3) * 0.5 + 0.5;
      const sweep = ((x + phase) & 0xff) / 255;
      buf[i] = Math.round((0.25 + ring * 0.65) * 255);
      buf[i + 1] = Math.round((0.18 + sweep * 0.62) * 255);
      buf[i + 2] = Math.round((0.25 + (1 - ring) * 0.55) * 255);
      buf[i + 3] = 255;
    }
  }
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#080b12',
  },
  content: {
    alignItems: 'center',
    gap: 12,
    paddingBottom: 136,
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
  predictionPanel: {
    alignSelf: 'stretch',
    gap: 8,
    paddingHorizontal: 16,
  },
  predictionLabel: {
    fontSize: 24,
    fontWeight: '800',
  },
  predictionMeta: {
    color: '#cbd5e1',
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  bars: {
    gap: 6,
  },
  captureStatus: {
    gap: 4,
    paddingTop: 4,
  },
  captureBadge: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    fontFamily: 'Menlo',
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  captureBadgeFallback: {
    backgroundColor: 'rgba(251, 191, 36, 0.16)',
    color: '#fcd34d',
  },
  captureBadgeLive: {
    backgroundColor: 'rgba(74, 222, 128, 0.16)',
    color: '#86efac',
  },
  captureText: {
    color: '#cbd5e1',
    fontFamily: 'Menlo',
    fontSize: 10,
  },
  signalGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingTop: 2,
  },
  signalPill: {
    borderColor: 'rgba(148, 163, 184, 0.28)',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: '48%',
    flexGrow: 1,
    gap: 2,
    minWidth: 136,
    padding: 8,
  },
  signalName: {
    color: '#94a3b8',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '700',
  },
  signalValue: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '700',
  },
  signalConfidence: {
    color: '#cbd5e1',
    fontFamily: 'Menlo',
    fontSize: 10,
  },
  barRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  barLabel: {
    color: '#cbd5e1',
    fontFamily: 'Menlo',
    fontSize: 10,
    width: 88,
  },
  barTrack: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 999,
    flex: 1,
    height: 7,
    overflow: 'hidden',
  },
  barFill: {
    height: 7,
  },
  controls: {
    alignSelf: 'stretch',
    gap: 12,
    paddingHorizontal: 16,
  },
  pickerHost: {
    alignSelf: 'stretch',
    height: 34,
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
