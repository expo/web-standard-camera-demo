import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { Dimensions, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';

import { useCamera } from '@/contexts/CameraContext';
import { configureWebGpuCanvas } from '@/lib/webgpu-canvas';
import { createWebGpuPerfProbe, nowMs } from '@/lib/webgpu-perf';
import { ImageCapture } from '../../../../modules/standard-camera';

// @ref LLP 0010#demo-1-rotating-cube-of-cameras — Existing WebGPU camera
// demo remains a first-class selectable route in the demo catalog.
//
// Rotating cube whose six faces all show the live camera. The demo reads the
// active MediaStream from CameraContext (shared with the Home screen — both
// surfaces see the same stream), wraps the first video track in a W3C
// `ImageCapture`, and uploads a fresh `grabFrame()` result at a 30 fps target
// while the cube still renders every animation tick. The frame is uploaded into
// a `bgra8unorm` GPU texture and sampled by the cube's fragment shader — the
// same shape an unmodified browser WebGPU demo would take. When no stream is
// active (camera stopped or simulator with no AVCaptureDevice), the loop falls
// back to a procedurally-generated test pattern uploaded the same way.
//
// Spec surface used:
//   - navigator.mediaDevices.getUserMedia (Media Capture and Streams)
//   - ImageCapture(track) + grabFrame()    (W3C Image Capture)
//   - navigator.gpu / WGSL                  (WebGPU)
//
// The only non-spec piece is the bridge ImageCapture pulls bytes through; see
// LLP 0010 + 0011 for context.

const SHADER = /* wgsl */ `
struct Uniforms {
  modelViewProjection: mat4x4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var srcSampler: sampler;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VsOut {
  var out: VsOut;
  out.position = u.modelViewProjection * vec4f(pos, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  return textureSample(srcTex, srcSampler, in.uv);
}
`;

// 36 vertices for a unit cube centered at the origin, each with a position
// and a UV. Wound CCW when viewed from outside the cube so back-face culling
// keeps the inside hidden.
const CUBE_VERTEX_COUNT = 36;
const CAMERA_UPLOAD_INTERVAL_MS = 33;
const CUBE_VERTICES = new Float32Array([
  // +Z (front)
  -1, -1, 1, 0, 1,
  1, -1, 1, 1, 1,
  1, 1, 1, 1, 0,
  -1, -1, 1, 0, 1,
  1, 1, 1, 1, 0,
  -1, 1, 1, 0, 0,
  // -Z (back)
  1, -1, -1, 0, 1,
  -1, -1, -1, 1, 1,
  -1, 1, -1, 1, 0,
  1, -1, -1, 0, 1,
  -1, 1, -1, 1, 0,
  1, 1, -1, 0, 0,
  // +X (right)
  1, -1, 1, 0, 1,
  1, -1, -1, 1, 1,
  1, 1, -1, 1, 0,
  1, -1, 1, 0, 1,
  1, 1, -1, 1, 0,
  1, 1, 1, 0, 0,
  // -X (left)
  -1, -1, -1, 0, 1,
  -1, -1, 1, 1, 1,
  -1, 1, 1, 1, 0,
  -1, -1, -1, 0, 1,
  -1, 1, 1, 1, 0,
  -1, 1, -1, 0, 0,
  // +Y (top)
  -1, 1, 1, 0, 1,
  1, 1, 1, 1, 1,
  1, 1, -1, 1, 0,
  -1, 1, 1, 0, 1,
  1, 1, -1, 1, 0,
  -1, 1, -1, 0, 0,
  // -Y (bottom)
  -1, -1, -1, 0, 1,
  1, -1, -1, 1, 1,
  1, -1, 1, 1, 0,
  -1, -1, -1, 0, 1,
  1, -1, 1, 1, 0,
  -1, -1, 1, 0, 0,
]);

const SYNTHETIC_SIZE = 256;

interface Frame {
  width: number;
  height: number;
  data: Uint8Array;
}

export default function CubeOfCamerasScreen(): React.JSX.Element {
  const ref = useCanvasRef();
  const { device, adapter } = useDevice();
  const { stream, status: cameraStatus, error: cameraError, userStopped, externalLocked, start } = useCamera();

  // Defense-in-depth start-on-mount: the provider auto-starts at app launch,
  // but Fast Refresh can strand that effect. Honor an explicit user Stop so
  // this effect doesn't fight the Stop button. Also bail while `externalLocked`
  // so we don't fight ARKit (the LiDAR demo) for the AVCaptureDevice when its
  // screen sits above ours in the stack.
  React.useEffect(() => {
    if (userStopped || externalLocked) return;
    if (
      !stream &&
      cameraStatus !== 'requesting' &&
      cameraStatus !== 'starting' &&
      cameraStatus !== 'stopping' &&
      cameraStatus !== 'error'
    ) {
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, cameraStatus, userStopped, externalLocked]);
  const [status, setStatus] = React.useState('initializing');
  const [source, setSource] = React.useState<'pending' | 'camera' | 'synthetic'>('pending');
  const [lastGrabError, setLastGrabError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [lastFrameNumber, setLastFrameNumber] = React.useState<number | null>(null);

  // The render loop reads from a ref so swapping the stream doesn't restart
  // the WebGPU pipeline. The effect below keeps the ref in sync with the
  // context's active stream.
  const imageCaptureRef = React.useRef<ImageCapture | null>(null);
  React.useEffect(() => {
    if (!stream) {
      imageCaptureRef.current = null;
      // eslint-disable-next-line no-console
      console.log(`CUBE_TRACE stream-cleared`);
      return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      imageCaptureRef.current = null;
      return;
    }
    try {
      imageCaptureRef.current = new ImageCapture(track);
      const s = track.getSettings() as { width?: number; height?: number };
      // eslint-disable-next-line no-console
      console.log(
        `CUBE_TRACE stream-ready ${JSON.stringify({ trackId: track.id, label: track.label, w: s.width, h: s.height })}`
      );
    } catch (e) {
      imageCaptureRef.current = null;
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      // eslint-disable-next-line no-console
      console.log(`CUBE_TRACE ImageCapture-construct-fail ${JSON.stringify({ reason })}`);
    }
    return () => {
      imageCaptureRef.current = null;
    };
  }, [stream]);

  const rafRef = React.useRef<number | null>(null);

  useFocusEffect(
    React.useCallback(() => {
    if (!device) return undefined;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    // eslint-disable-next-line no-console
    console.log(`CUBE_TRACE mount @ ${new Date().toISOString()}`);

    const startRender = (): void => {
      try {
        const profile = createWebGpuPerfProbe('cube', {
          uploadIntervalMs: CAMERA_UPLOAD_INTERVAL_MS,
        });
        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        const canvas = configureWebGpuCanvas(ref, device, presentationFormat);
        const context = canvas.context;

        const shaderModule = device.createShaderModule({ code: SHADER });

        const vertexBuffer = device.createBuffer({
          size: CUBE_VERTICES.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexBuffer, 0, CUBE_VERTICES);

        const pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: shaderModule,
            entryPoint: 'vs_main',
            buffers: [
              {
                arrayStride: 5 * 4,
                attributes: [
                  { shaderLocation: 0, offset: 0, format: 'float32x3' },
                  { shaderLocation: 1, offset: 3 * 4, format: 'float32x2' },
                ],
              },
            ],
          },
          fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [{ format: presentationFormat }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'back' },
          depthStencil: {
            format: 'depth24plus',
            depthWriteEnabled: true,
            depthCompare: 'less',
          },
        });

        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;

        const depthTexture = device.createTexture({
          size: { width: canvasWidth, height: canvasHeight },
          format: 'depth24plus',
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });

        const sampler = device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        });

        const uniformBuffer = device.createBuffer({
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Lazy-created on the first frame so we size the texture to whatever
        // dimensions the camera (or fallback) actually delivers.
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
        let activeSource: 'camera' | 'synthetic' = 'synthetic';
        let activeWidth = SYNTHETIC_SIZE;
        let activeHeight = SYNTHETIC_SIZE;
        let lastSeenFrameNumber: number | null = null;
        let newFramesThisSecond = 0;
        let grabsThisSecond = 0;

        const aspect = canvasWidth / canvasHeight;
        const projection = mat4Perspective((60 * Math.PI) / 180, aspect, 0.1, 100);
        const view = mat4Translate(0, 0, -5);
        const viewProjection = mat4Multiply(projection, view);

        const renderFrame = async (): Promise<void> => {
          if (cancelled) return;
          const now = Date.now();
          const elapsed = (now - startedAt) / 1000;
          const shouldUpload = bindGroup == null || now - lastUpload >= CAMERA_UPLOAD_INTERVAL_MS;

          if (shouldUpload) {
            // Pull from the active ImageCapture (set by the stream effect
            // whenever the context's stream changes). Fall back to synthetic
            // whenever there's no capture or the camera hasn't produced a
            // frame yet. Uploads are capped at 30 fps so one expensive
            // pixel-buffer copy cannot slow every visual animation frame.
            const ic = imageCaptureRef.current;
            let frame: Frame | null = null;
            let frameSource: 'camera' | 'synthetic' = 'synthetic';
            if (ic) {
              try {
                const bitmap = await profile.timeAsync('grabFrame', () => ic.grabFrame());
                frame = { width: bitmap.width, height: bitmap.height, data: bitmap._data };
                frameSource = 'camera';
                grabsThisSecond++;
                profile.recordFrameNumber(bitmap._frameNumber);
                if (bitmap._frameNumber !== lastSeenFrameNumber) {
                  newFramesThisSecond++;
                  lastSeenFrameNumber = bitmap._frameNumber;
                }
                bitmap.close();
              } catch (e) {
                const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                setLastGrabError(reason);
              }
            }
            if (!frame) {
              fillTestPattern(syntheticPixels, SYNTHETIC_SIZE, elapsed);
              frame = { width: SYNTHETIC_SIZE, height: SYNTHETIC_SIZE, data: syntheticPixels };
            }
            if (cancelled) return;

            if (frameSource !== lastReportedSource) {
              lastReportedSource = frameSource;
              setSource(frameSource);
              // eslint-disable-next-line no-console
              console.log(
                `CUBE_TRACE source-change ${JSON.stringify({ source: frameSource, w: frame.width, h: frame.height })}`
              );
            }

            const currentBindGroup = ensureTexture(frame.width, frame.height);
            profile.count(frameSource === 'camera' ? 'cameraUploads' : 'syntheticUploads');
            profile.count('uploadedBytes', frame.data.byteLength);
            profile.time('writeTexture', () =>
              device.queue.writeTexture(
                { texture: cameraTexture! },
                frame.data,
                { bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
                { width: frame.width, height: frame.height }
              )
            );
            activeSource = frameSource;
            activeWidth = frame.width;
            activeHeight = frame.height;
            bindGroup = currentBindGroup;
            lastUpload = now;
          }

          if (!bindGroup) {
            rafRef.current = requestAnimationFrame(() => {
              void renderFrame();
            });
            return;
          }

          const model = mat4Multiply(mat4RotateY(elapsed * 0.7), mat4RotateX(elapsed * 0.4));
          const mvp = mat4Multiply(viewProjection, model);
          device.queue.writeBuffer(uniformBuffer, 0, mvp);

          const renderStart = nowMs();
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0.04, g: 0.06, b: 0.1, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
            depthStencilAttachment: {
              view: depthTexture.createView(),
              depthClearValue: 1,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
            },
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.setVertexBuffer(0, vertexBuffer);
          pass.draw(CUBE_VERTEX_COUNT);
          pass.end();
          device.queue.submit([encoder.finish()]);
          context.present();
          profile.duration('renderSubmitPresent', nowMs() - renderStart);

          frames++;
          profile.count('renderFrames');
          if (now - lastReport >= 1000) {
            const fps = (frames / ((now - lastReport) / 1000)).toFixed(1);
            // eslint-disable-next-line no-console
            console.log(
              `CUBE_FPS ${JSON.stringify({ fps: +fps, frames, source: activeSource, w: activeWidth, h: activeHeight, newFrames: newFramesThisSecond, grabs: grabsThisSecond, lastN: lastSeenFrameNumber })}`
            );
            if (lastSeenFrameNumber !== null) {
              setLastFrameNumber(lastSeenFrameNumber);
            }
            profile.report({
              fps: Number(fps),
              grabs: grabsThisSecond,
              height: activeHeight,
              newFrames: newFramesThisSecond,
              source: activeSource,
              width: activeWidth,
            });
            frames = 0;
            newFramesThisSecond = 0;
            grabsThisSecond = 0;
            lastReport = now;
          }

          rafRef.current = requestAnimationFrame(() => {
            void renderFrame();
          });
        };

        setStatus(`ok — ${adapter?.info?.vendor ?? 'unknown adapter'}`);
        rafRef.current = requestAnimationFrame(() => {
          void renderFrame();
        });

        cleanup = (): void => {
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          if (cameraTexture) cameraTexture.destroy();
          depthTexture.destroy();
          vertexBuffer.destroy();
          uniformBuffer.destroy();
        };
      } catch (e) {
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        setError(message);
        setStatus('error');
        // eslint-disable-next-line no-console
        console.log(`CUBE_RESULT ${JSON.stringify({ status: 'fail', error: message })}`);
      }
    };

    // Give the surface a tick to attach before grabbing the context.
    const timer = setTimeout(startRender, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      cleanup?.();
    };
  }, [device, adapter, ref])
  );

  // Driven by the status machine, not `stream != null`, so an externally
  // ended track (status='ended', stream still set) doesn't leave the nav
  // button claiming "Stop" against a dead camera.
  const cameraOn = cameraStatus === 'playing';
  const subtitle = !cameraOn
    ? 'Camera stopped — synthetic frames standing in. Tap Start camera to share the live feed with the Home tab too.'
    : source === 'camera'
      ? 'Live camera frames via getUserMedia → ImageCapture → WebGPU — shared with the Home tab.'
      : source === 'synthetic'
        ? 'Stream live but no frames yet (cold start or simulator without an AVCaptureDevice).'
        : 'Opening the camera…';

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic">
      <Canvas ref={ref} style={styles.canvas} />
      <View style={styles.hud}>
        <Text style={styles.hudText}>Cube of cameras · {status}</Text>
        <Text style={styles.hudSub}>{subtitle}</Text>
        <Text style={styles.hudSub}>· camera context: {cameraStatus}</Text>
        {lastFrameNumber !== null && cameraOn ? (
          <Text style={styles.hudSub}>· iOS frames delivered: {lastFrameNumber}</Text>
        ) : null}
        {cameraError ? <Text style={styles.hudError}>· camera error: {cameraError}</Text> : null}
        {lastGrabError && source !== 'camera' ? (
          <Text style={styles.hudSub}>· grabFrame: {lastGrabError}</Text>
        ) : null}
        {error ? <Text style={styles.hudError}>{error}</Text> : null}
      </View>
    </ScrollView>
  );
}

// The canvas takes the smaller of (window width) and (window height − header
// allowance) so the cube renders square within a ScrollView. ScrollView
// requires children with explicit dimensions; we can't use flex:1 here.
const WINDOW = Dimensions.get('window');
const CANVAS_SIDE = Math.min(WINDOW.width, WINDOW.height - 240);

// Time-modulated test pattern: diagonal stripes whose hue shifts with t and
// whose phase shifts so the texture is obviously alive frame to frame. The
// channel order is B, G, R, A so the bytes go into a `bgra8unorm` texture
// without a swap — matching what the camera path delivers.
function fillTestPattern(buf: Uint8Array, size: number, t: number): void {
  const phase = (t * 60) | 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const diag = (x + y + phase) & 0xff;
      const ring = ((x * x + y * y) >> 4) & 0xff;
      buf[i + 0] = (255 - diag + (phase >> 1)) & 0xff;
      buf[i + 1] = (ring + phase) & 0xff;
      buf[i + 2] = diag;
      buf[i + 3] = 255;
    }
  }
}

// Column-major 4x4 matrix helpers. WebGPU uniforms expect column-major
// storage and the WGSL math operates on column vectors via M * v.

function mat4Perspective(fovYRad: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mat4Identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Translate(x: number, y: number, z: number): Float32Array {
  const m = mat4Identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function mat4RotateX(angle: number): Float32Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const m = mat4Identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

function mat4RotateY(angle: number): Float32Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const m = mat4Identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + j] * b[i * 4 + k];
      }
      out[i * 4 + j] = sum;
    }
  }
  return out;
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#0a0e1a',
  },
  scrollContent: {
    alignItems: 'center',
    paddingBottom: 32,
  },
  canvas: {
    width: CANVAS_SIDE,
    height: CANVAS_SIDE,
  },
  hud: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 4,
    alignSelf: 'stretch',
  },
  hudText: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#f8fafc',
  },
  hudSub: {
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#cbd5e1',
  },
  hudError: {
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#fca5a5',
    marginTop: 4,
  },
});
