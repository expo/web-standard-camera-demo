import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';

import { useCamera } from '@/contexts/CameraContext';
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
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
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

fn sampleAt(uv: vec2f) -> vec4f {
  return textureSample(srcTex, srcSampler, clamp(uv, vec2f(0.0), vec2f(1.0)));
}

fn posterize(c: vec4f) -> vec4f {
  let levels = 4.0 + floor(u.intensity * 8.0);
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
  return vec4f(clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0)), 1.0);
}

fn kaleidoscope(uv: vec2f) -> vec4f {
  let center = uv - vec2f(0.5);
  let radius = length(center);
  let angle = atan2(center.y, center.x) + sin(u.time * 0.35) * 0.2;
  let pi = 3.14159265;
  let segments = 6.0 + floor(u.intensity * 6.0);
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
const FRAME_UPLOAD_INTERVAL_MS = 100;
const DEMO_CAPTURE_CONSTRAINTS = { width: 640, height: 480, frameRate: 30 } as const;

const EFFECTS = [
  { label: 'Original', value: 0 },
  { label: 'Posterize', value: 1 },
  { label: 'Edges', value: 2 },
  { label: 'Heat', value: 3 },
  { label: 'Kaleido', value: 4 },
] as const;

interface Frame {
  data: Uint8Array;
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
    start,
    stop,
    applyConstraints,
  } = useCamera();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [effect, setEffect] = React.useState<(typeof EFFECTS)[number]['value']>(2);
  const [intensity, setIntensity] = React.useState(0.65);
  const [status, setStatus] = React.useState('initializing');
  const [source, setSource] = React.useState<'pending' | 'camera' | 'synthetic'>('pending');
  const [fps, setFps] = React.useState('0.0');
  const [lastFrameNumber, setLastFrameNumber] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [lastGrabError, setLastGrabError] = React.useState<string | null>(null);

  const effectRef = React.useRef(effect);
  const intensityRef = React.useRef(intensity);
  const imageCaptureRef = React.useRef<ImageCapture | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const lastGrabErrorRef = React.useRef<string | null>(null);
  const didAutoStartCameraRef = React.useRef(false);

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
    if (didAutoStartCameraRef.current) return;
    if (cameraStatus === 'requesting' || cameraStatus === 'starting') return;
    didAutoStartCameraRef.current = true;
    void start({ ...constraints, ...DEMO_CAPTURE_CONSTRAINTS });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraStatus]);

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

        const ensureTexture = (width: number, height: number): GPUBindGroup => {
          if (cameraTexture && texWidth === width && texHeight === height) {
            return bindGroup!;
          }
          if (cameraTexture) cameraTexture.destroy();
          cameraTexture = device.createTexture({
            size: { width, height },
            format: 'bgra8unorm',
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
              setSource(frameSource);
            }

            ensureTexture(frame.width, frame.height);
            device.queue.writeTexture(
              { texture: cameraTexture! },
              frame.data,
              { bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
              { width: frame.width, height: frame.height }
            );
            lastUpload = now;
          }

          if (!bindGroup) {
            rafRef.current = requestAnimationFrame(() => {
              void renderFrame();
            });
            return;
          }

          device.queue.writeBuffer(
            uniformBuffer,
            0,
            new Float32Array([
              effectRef.current,
              elapsed,
              1 / texWidth,
              1 / texHeight,
              intensityRef.current,
              0,
              0,
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
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.draw(3);
          pass.end();
          device.queue.submit([encoder.finish()]);
          context.present();

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
  }, [adapter, device, ref, setGrabError]);

  const cameraOn = stream != null;
  const canvasSide = Math.max(260, Math.min(windowWidth - 32, windowHeight - 330));
  const activeEffect = EFFECTS.find((item) => item.value === effect)?.label ?? 'Original';
  const settingsFacing =
    settings?.facingMode === 'user' || settings?.facingMode === 'environment'
      ? settings.facingMode
      : undefined;
  const cameraFacing = constraints.facingMode ?? settingsFacing ?? 'environment';

  const setFacing = React.useCallback(
    (facingMode: 'user' | 'environment'): void => {
      applyConstraints({ ...DEMO_CAPTURE_CONSTRAINTS, facingMode });
    },
    [applyConstraints]
  );

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <Canvas ref={ref} style={[styles.canvas, { height: canvasSide, width: canvasSide }]} />

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

        <View style={styles.controlRow}>
          {EFFECTS.map((item) => (
            <Pressable
              key={item.value}
              onPress={() => setEffect(item.value)}
              style={[styles.chip, effect === item.value ? styles.chipActive : null]}>
              <Text style={[styles.chipText, effect === item.value ? styles.chipTextActive : null]}>
                {item.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.controlRow}>
          <Pressable
            onPress={() => setIntensity((value) => Math.max(0, value - 0.15))}
            style={styles.button}>
            <Text style={styles.buttonText}>Less</Text>
          </Pressable>
          <View style={styles.readout}>
            <Text style={styles.readoutText}>
              {activeEffect} · intensity {Math.round(intensity * 100)}%
            </Text>
          </View>
          <Pressable
            onPress={() => setIntensity((value) => Math.min(1, value + 0.15))}
            style={styles.button}>
            <Text style={styles.buttonText}>More</Text>
          </Pressable>
        </View>

        <Pressable
          onPress={() => (cameraOn ? stop() : void start())}
          style={[styles.button, styles.fullButton]}>
          <Text style={styles.buttonText}>{cameraOn ? 'Stop camera' : 'Start camera'}</Text>
        </Pressable>
      </View>

      <View style={styles.hud}>
        <Text style={styles.hudText}>Shader lens · {status}</Text>
        <Text style={styles.hudSub}>source: {source} · fps: {fps} · camera: {cameraStatus}</Text>
        {lastFrameNumber !== null && cameraOn ? (
          <Text style={styles.hudSub}>iOS frames delivered: {lastFrameNumber}</Text>
        ) : null}
        {cameraError ? <Text style={styles.hudError}>camera error: {cameraError}</Text> : null}
        {lastGrabError && source !== 'camera' ? (
          <Text style={styles.hudSub}>grabFrame: {lastGrabError}</Text>
        ) : null}
        {error ? <Text style={styles.hudError}>{error}</Text> : null}
      </View>
    </ScrollView>
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
  readout: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: 10,
  },
  readoutText: {
    color: '#f8fafc',
    fontFamily: 'Menlo',
    fontSize: 11,
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
