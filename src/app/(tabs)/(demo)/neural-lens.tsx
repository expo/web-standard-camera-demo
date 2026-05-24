import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';

import { useCamera } from '@/contexts/CameraContext';
import { ImageCapture } from '../../../../modules/standard-camera';

// @ref LLP 0010#demo-3-tiny-webgpu-classifier — A no-WASM AI demo: camera
// frames become a WebGPU texture, a WGSL compute shader runs a tiny fixed
// classifier over sampled pixels, and JS only reads back the final logits.

const RENDER_SHADER = /* wgsl */ `
struct RenderUniforms {
  time: f32,
  label: f32,
  confidence: f32,
  _pad0: f32,
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

fn labelColor(label: f32) -> vec3f {
  if (label < 0.5) { return vec3f(0.35, 0.62, 1.0); }
  if (label < 1.5) { return vec3f(1.0, 0.47, 0.18); }
  if (label < 2.5) { return vec3f(0.18, 0.78, 0.92); }
  if (label < 3.5) { return vec3f(0.95, 0.95, 0.95); }
  return vec3f(0.25, 1.0, 0.58);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let c = textureSample(srcTex, srcSampler, clamp(in.uv, vec2f(0.0), vec2f(1.0))).rgb;
  let scan = 0.04 * sin((in.uv.y + u.time * 0.18) * 190.0);
  let tint = labelColor(u.label);
  let mixed = mix(c, tint, clamp(u.confidence * 0.18, 0.0, 0.22));
  return vec4f(clamp(mixed + scan, vec3f(0.0), vec3f(1.0)), 1.0);
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
@group(0) @binding(2) var<storage, read_write> outScores: array<f32, 8>;

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
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
  var warm = 0.0;
  var cool = 0.0;
  var contrast = 0.0;
  var saturation = 0.0;
  var edge = 0.0;

  for (var y = 0; y < 16; y = y + 1) {
    for (var x = 0; x < 16; x = x + 1) {
      let px = i32((f32(x) + 0.5) / 16.0 * u.width);
      let py = i32((f32(y) + 0.5) / 16.0 * u.height);
      let c = samplePixel(px, py);
      let y0 = luma(c);
      let cx = luma(samplePixel(px + 3, py));
      let cy = luma(samplePixel(px, py + 3));
      brightness = brightness + y0;
      warm = warm + max(c.r - c.b, 0.0);
      cool = cool + max(c.b - c.r, 0.0);
      contrast = contrast + abs(y0 - 0.5);
      saturation = saturation + (max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b));
      edge = edge + abs(cx - y0) + abs(cy - y0);
    }
  }

  let inv = 1.0 / 256.0;
  brightness = brightness * inv;
  warm = warm * inv;
  cool = cool * inv;
  contrast = contrast * inv;
  saturation = saturation * inv;
  edge = edge * inv;

  outScores[0] = (0.46 - brightness) * 4.0 + contrast * 1.2;
  outScores[1] = (warm - cool) * 5.0 + saturation * 1.1 + brightness * 0.35;
  outScores[2] = (cool - warm) * 5.0 + saturation * 1.1 + brightness * 0.25;
  outScores[3] = edge * 8.0 + contrast * 2.3 - saturation * 0.35;
  outScores[4] = brightness * 2.4 - contrast * 1.8 + saturation * 0.25;
  outScores[5] = brightness;
  outScores[6] = contrast;
  outScores[7] = edge;
}
`;

const SYNTHETIC_SIZE = 256;
const FRAME_UPLOAD_INTERVAL_MS = 100;
const INFERENCE_INTERVAL_MS = 450;
const RELAXED_CAMERA_RETRY_MS = 2500;
const SCORE_FLOATS = 8;
const DEMO_CAPTURE_CONSTRAINTS = { width: 640, height: 480, frameRate: 30 } as const;
const RELAXED_CAPTURE_CONSTRAINTS = { frameRate: 30 } as const;

const LABELS = [
  { color: '#60a5fa', name: 'Low light' },
  { color: '#fb923c', name: 'Warm scene' },
  { color: '#22d3ee', name: 'Cool scene' },
  { color: '#f8fafc', name: 'High contrast' },
  { color: '#4ade80', name: 'Bright scene' },
] as const;

interface Frame {
  data: Uint8Array;
  height: number;
  width: number;
}

interface Prediction {
  confidence: number;
  features: {
    brightness: number;
    contrast: number;
    edge: number;
  };
  labelIndex: number;
  probabilities: number[];
}

const INITIAL_PREDICTION: Prediction = {
  confidence: 0,
  features: { brightness: 0, contrast: 0, edge: 0 },
  labelIndex: 3,
  probabilities: LABELS.map(() => 0),
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
    start,
    stop,
    applyConstraints,
  } = useCamera();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [status, setStatus] = React.useState('initializing');
  const [source, setSource] = React.useState<'pending' | 'camera' | 'synthetic'>('pending');
  const [fps, setFps] = React.useState('0.0');
  const [frameSize, setFrameSize] = React.useState('pending');
  const [prediction, setPrediction] = React.useState<Prediction>(INITIAL_PREDICTION);
  const [lastFrameNumber, setLastFrameNumber] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [lastGrabError, setLastGrabError] = React.useState<string | null>(null);
  const [inferenceError, setInferenceError] = React.useState<string | null>(null);

  const imageCaptureRef = React.useRef<ImageCapture | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const lastGrabErrorRef = React.useRef<string | null>(null);
  const frameSizeRef = React.useRef('pending');
  const predictionRef = React.useRef(prediction);
  const sourceRef = React.useRef(source);
  const didAutoStartCameraRef = React.useRef(false);
  const didRetryRelaxedCameraRef = React.useRef(false);
  const settingsFacing =
    settings?.facingMode === 'user' || settings?.facingMode === 'environment'
      ? settings.facingMode
      : undefined;

  const setGrabError = React.useCallback((message: string | null): void => {
    if (lastGrabErrorRef.current === message) return;
    lastGrabErrorRef.current = message;
    setLastGrabError(message);
  }, []);

  const setFrameInfo = React.useCallback((width: number, height: number): void => {
    const next = `${width}x${height}`;
    if (frameSizeRef.current === next) return;
    frameSizeRef.current = next;
    setFrameSize(next);
  }, []);

  React.useEffect(() => {
    predictionRef.current = prediction;
  }, [prediction]);

  React.useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  React.useEffect(() => {
    if (didAutoStartCameraRef.current) return;
    if (cameraStatus === 'requesting' || cameraStatus === 'starting') return;
    didAutoStartCameraRef.current = true;
    void start({ ...constraints, ...DEMO_CAPTURE_CONSTRAINTS });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraStatus]);

  React.useEffect(() => {
    if (didRetryRelaxedCameraRef.current || source === 'camera' || cameraStatus !== 'error' || stream) {
      return;
    }
    didRetryRelaxedCameraRef.current = true;
    void start({
      ...RELAXED_CAPTURE_CONSTRAINTS,
      facingMode: constraints.facingMode ?? settingsFacing ?? 'environment',
    });
  }, [cameraStatus, constraints.facingMode, settingsFacing, source, start, stream]);

  React.useEffect(() => {
    if (!stream || source === 'camera' || didRetryRelaxedCameraRef.current) return;
    const timer = setTimeout(() => {
      if (sourceRef.current === 'camera' || didRetryRelaxedCameraRef.current) return;
      didRetryRelaxedCameraRef.current = true;
      void start({
        ...RELAXED_CAPTURE_CONSTRAINTS,
        facingMode: constraints.facingMode ?? settingsFacing ?? 'environment',
      });
    }, RELAXED_CAMERA_RETRY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [constraints.facingMode, settingsFacing, source, start, stream]);

  React.useEffect(() => {
    if (!stream) {
      imageCaptureRef.current = null;
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      imageCaptureRef.current = null;
      return;
    }
    try {
      imageCaptureRef.current = new ImageCapture(track);
    } catch (e) {
      imageCaptureRef.current = null;
      setGrabError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
    return () => {
      imageCaptureRef.current = null;
    };
  }, [setGrabError, stream]);

  React.useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const startRender = (): void => {
      try {
        const context = ref.current?.getContext('webgpu');
        if (!context) {
          throw new Error('getContext("webgpu") returned null');
        }

        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format: presentationFormat, alphaMode: 'opaque' });

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
          size: 16,
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

        const ensureTexture = (width: number, height: number): void => {
          if (cameraTexture && texWidth === width && texHeight === height) return;
          if (cameraTexture) cameraTexture.destroy();
          cameraTexture = device.createTexture({
            size: { width, height },
            format: 'bgra8unorm',
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
        };

        const syntheticPixels = new Uint8Array(SYNTHETIC_SIZE * SYNTHETIC_SIZE * 4);
        const startedAt = Date.now();
        let frames = 0;
        let lastReport = startedAt;
        let lastUpload = 0;
        let lastInference = 0;
        let inferencePending = false;
        let lastReportedSource: 'camera' | 'synthetic' | null = null;
        let lastSeenFrameNumber: number | null = null;

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
            await readbackBuffer.mapAsync(GPUMapMode.READ);
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

          if (shouldUpload) {
            let frame: Frame | null = null;
            let frameSource: 'camera' | 'synthetic' = 'synthetic';
            const imageCapture = imageCaptureRef.current;

            if (imageCapture) {
              try {
                const bitmap = await imageCapture.grabFrame();
                frame = { data: bitmap._data, height: bitmap.height, width: bitmap.width };
                frameSource = 'camera';
                lastSeenFrameNumber = bitmap._frameNumber;
                bitmap.close();
                setGrabError(null);
              } catch (e) {
                setGrabError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
              }
            }

            if (!frame) {
              fillTestPattern(syntheticPixels, SYNTHETIC_SIZE, elapsed);
              frame = { data: syntheticPixels, height: SYNTHETIC_SIZE, width: SYNTHETIC_SIZE };
            }
            if (cancelled) return;

            if (frameSource !== lastReportedSource) {
              lastReportedSource = frameSource;
              sourceRef.current = frameSource;
              setSource(frameSource);
              if (__DEV__) {
                // eslint-disable-next-line no-console
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
            ensureTexture(frame.width, frame.height);
            device.queue.writeTexture(
              { texture: cameraTexture! },
              frame.data,
              { bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
              { width: frame.width, height: frame.height }
            );
            lastUpload = now;
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
              0,
            ])
          );

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

          if (now - lastInference >= INFERENCE_INTERVAL_MS) {
            lastInference = now;
            void runInference(elapsed);
          }

          frames += 1;
          if (now - lastReport >= 1000) {
            setFps((frames / ((now - lastReport) / 1000)).toFixed(1));
            if (lastSeenFrameNumber !== null) {
              setLastFrameNumber(lastSeenFrameNumber);
            }
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
  }, [adapter, device, ref, setFrameInfo, setGrabError]);

  const cameraOn = stream != null;
  const canvasSide = Math.max(260, Math.min(windowWidth - 32, windowHeight - 360));
  const activeLabel = LABELS[prediction.labelIndex] ?? LABELS[0];
  const cameraFacing = constraints.facingMode ?? settingsFacing ?? 'environment';

  const setFacing = React.useCallback(
    (facingMode: 'user' | 'environment'): void => {
      didRetryRelaxedCameraRef.current = false;
      applyConstraints({ ...DEMO_CAPTURE_CONSTRAINTS, facingMode });
    },
    [applyConstraints]
  );
  const startDemoCamera = React.useCallback((): void => {
    didRetryRelaxedCameraRef.current = false;
    void start({ ...constraints, ...DEMO_CAPTURE_CONSTRAINTS });
  }, [constraints, start]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <Canvas ref={ref} style={[styles.canvas, { height: canvasSide, width: canvasSide }]} />

      <View style={styles.predictionPanel}>
        <Text style={[styles.predictionLabel, { color: activeLabel.color }]}>{activeLabel.name}</Text>
        <Text style={styles.predictionMeta}>{Math.round(prediction.confidence * 100)}% confidence</Text>
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
                      width: `${Math.round((prediction.probabilities[index] ?? 0) * 100)}%`,
                    },
                  ]}
                />
              </View>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.controls}>
        <View style={styles.controlRow}>
          <Pressable
            onPress={() => setFacing('environment')}
            style={[styles.chip, cameraFacing === 'environment' ? styles.chipActive : null]}>
            <Text style={[styles.chipText, cameraFacing === 'environment' ? styles.chipTextActive : null]}>
              Back
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setFacing('user')}
            style={[styles.chip, cameraFacing === 'user' ? styles.chipActive : null]}>
            <Text style={[styles.chipText, cameraFacing === 'user' ? styles.chipTextActive : null]}>
              Front
            </Text>
          </Pressable>
        </View>

        <Pressable
          onPress={() => (cameraOn ? stop() : startDemoCamera())}
          style={[styles.button, styles.fullButton]}>
          <Text style={styles.buttonText}>{cameraOn ? 'Stop camera' : 'Start camera'}</Text>
        </Pressable>
      </View>

      <View style={styles.hud}>
        <Text style={styles.hudText}>Neural lens · {status}</Text>
        <Text style={styles.hudSub}>
          source: {source} · frame: {frameSize} · fps: {fps} · camera: {cameraStatus}
        </Text>
        <Text style={styles.hudSub}>
          features: brightness {prediction.features.brightness.toFixed(2)} · contrast{' '}
          {prediction.features.contrast.toFixed(2)} · edge {prediction.features.edge.toFixed(2)}
        </Text>
        {lastFrameNumber !== null && cameraOn ? (
          <Text style={styles.hudSub}>iOS frames delivered: {lastFrameNumber}</Text>
        ) : null}
        {cameraError ? <Text style={styles.hudError}>camera error: {cameraError}</Text> : null}
        {lastGrabError && source !== 'camera' ? (
          <Text style={styles.hudSub}>grabFrame: {lastGrabError}</Text>
        ) : null}
        {inferenceError ? <Text style={styles.hudError}>inference: {inferenceError}</Text> : null}
        {error ? <Text style={styles.hudError}>{error}</Text> : null}
      </View>
    </ScrollView>
  );
}

function makePrediction(values: Float32Array): Prediction {
  const logits = Array.from(values.slice(0, LABELS.length));
  const maxLogit = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - maxLogit));
  const sum = exps.reduce((acc, v) => acc + v, 0) || 1;
  const probabilities = exps.map((v) => v / sum);
  let labelIndex = 0;
  for (let i = 1; i < probabilities.length; i += 1) {
    if (probabilities[i] > probabilities[labelIndex]) labelIndex = i;
  }
  return {
    confidence: probabilities[labelIndex] ?? 0,
    features: {
      brightness: finite01(values[5]),
      contrast: finite01(values[6]),
      edge: finite01(values[7]),
    },
    labelIndex,
    probabilities,
  };
}

function finite01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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
    paddingBottom: 32,
  },
  canvas: {
    backgroundColor: '#080b12',
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
    gap: 10,
    paddingHorizontal: 16,
  },
  controlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    backgroundColor: 'rgba(255, 255, 255, 0.11)',
    borderRadius: 8,
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  chipActive: {
    backgroundColor: '#f8fafc',
  },
  chipText: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '700',
  },
  chipTextActive: {
    color: '#0f172a',
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#60a5fa',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: 12,
  },
  fullButton: {
    alignSelf: 'stretch',
  },
  buttonText: {
    color: '#07111f',
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
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
