import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';

import {
  Host,
  Picker,
  Text as UIText,
  disabled as disabledModifier,
  pickerStyle,
  tag,
} from '@/components/demo-platform-controls';
import { DemoPageFrame } from '@/components/demo-page-frame';
import { useCamera } from '@/contexts/CameraContext';
import {
  closeCameraFrame,
  getCameraFrameByteLength,
  getCameraFrameTextureFormat,
  type CameraFrameUploadSource,
  uploadCameraFrameToTexture,
} from '@/lib/camera-frame-upload';
import { cameraFrameFacingMode, displayFacingMode } from '@/lib/camera-facing';
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
// same shape an unmodified browser WebGPU demo would take.
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
  mirror: f32,
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
fn vs_main(@location(0) pos: vec3f, @location(1) uv: vec2f) -> VsOut {
  var out: VsOut;
  out.position = u.modelViewProjection * vec4f(pos, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  var uv = in.uv;
  if (u.mirror > 0.5) {
    uv.x = 1.0 - uv.x;
  }
  return textureSample(srcTex, srcSampler, uv);
}
`;

// 36 vertices for a unit cube centered at the origin, each with a position
// and a UV. Wound CCW when viewed from outside the cube so back-face culling
// keeps the inside hidden.
const CUBE_VERTEX_COUNT = 36;
const CAMERA_UPLOAD_INTERVAL_MS = 33;
const CAMERA_CAPTURE_SETTLE_MS = 180;
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

export default function CubeOfCamerasScreen(): React.JSX.Element {
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
  const cameraFacing = displayFacingMode({ constraints, settings });
  // @ref LLP 0021#decision — Demo Back controls stay visible but disabled
  // when the web provider proves no environment camera exists.
  const backFacingDisabled = facingModeAvailability.environment === 'unavailable';
  const setFacing = React.useCallback(
    (facingMode: 'user' | 'environment'): void => {
      if (facingMode === cameraFacing) return;
      if (facingMode === 'environment' && backFacingDisabled) return;
      applyConstraints({ facingMode });
    },
    [applyConstraints, backFacingDisabled, cameraFacing]
  );

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
  const [source, setSource] = React.useState<'pending' | 'camera'>('pending');
  const [lastGrabError, setLastGrabError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // The render loop reads from a ref so swapping the stream doesn't restart
  // the WebGPU pipeline. The effect below keeps the ref in sync with the
  // context's active stream.
  const imageCaptureRef = React.useRef<ImageCapture | null>(null);
  const imageCaptureMirroredRef = React.useRef(false);
  const imageCaptureAcceptAfterRef = React.useRef(0);
  /* eslint-disable react-hooks/set-state-in-effect -- Keep the existing stream-swap HUD reset timing. */
  React.useEffect(() => {
    if (!stream) {
      imageCaptureRef.current = null;
      imageCaptureMirroredRef.current = false;
      imageCaptureAcceptAfterRef.current = 0;
      setSource('pending');
      console.log(`CUBE_TRACE stream-cleared`);
      return;
    }
    setSource('pending');
    const track = stream.getVideoTracks()[0];
    if (!track) {
      imageCaptureRef.current = null;
      imageCaptureMirroredRef.current = false;
      imageCaptureAcceptAfterRef.current = 0;
      return;
    }
    try {
      const mirrored = cameraFrameFacingMode(track.getSettings()) === 'user';
      imageCaptureRef.current = new ImageCapture(track);
      imageCaptureMirroredRef.current = mirrored;
      // @ref LLP 0010#frame-bound-demo-mirroring — Avoid accepting the
      // replacement camera's transient exposure-settling frames without
      // depending on native-only frame diagnostics.
      imageCaptureAcceptAfterRef.current = Date.now() + CAMERA_CAPTURE_SETTLE_MS;
      const s = track.getSettings() as { width?: number; height?: number };
      console.log(
        `CUBE_TRACE stream-ready ${JSON.stringify({ trackId: track.id, label: track.label, w: s.width, h: s.height })}`
      );
    } catch (e) {
      imageCaptureRef.current = null;
      imageCaptureMirroredRef.current = false;
      imageCaptureAcceptAfterRef.current = 0;
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.log(`CUBE_TRACE ImageCapture-construct-fail ${JSON.stringify({ reason })}`);
    }
    return () => {
      imageCaptureRef.current = null;
      imageCaptureMirroredRef.current = false;
      imageCaptureAcceptAfterRef.current = 0;
    };
  }, [stream]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const rafRef = React.useRef<number | null>(null);

  useFocusEffect(
    React.useCallback(() => {
    if (!device) return undefined;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

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

        let depthTexture: GPUTexture | null = null;
        let depthWidth = 0;
        let depthHeight = 0;

        const sampler = device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        });

        const uniformBuffer = device.createBuffer({
          size: 80,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const uniformScratch = new Float32Array(20);

        // Lazy-created on the first frame so we size the texture to whatever
        // dimensions the camera (or fallback) actually delivers.
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

        const ensureDepthTexture = (width: number, height: number): GPUTexture => {
          if (depthTexture && depthWidth === width && depthHeight === height) {
            return depthTexture;
          }
          depthTexture?.destroy();
          depthTexture = device.createTexture({
            size: { width, height },
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          depthWidth = width;
          depthHeight = height;
          return depthTexture;
        };

        const startedAt = Date.now();
        let frames = 0;
        let lastReport = startedAt;
        let lastUpload = 0;
        let hasReportedCameraSource = false;
        let activeSource: 'pending' | 'camera' = 'pending';
        let activeWidth = 0;
        let activeHeight = 0;
        let grabsThisSecond = 0;
        let cameraGrabInFlight = false;
        let activeTextureMirrored = false;

        const aspect = canvasWidth / canvasHeight;
        const projection = mat4Perspective((60 * Math.PI) / 180, aspect, 0.1, 100);
        const view = mat4Translate(0, 0, -5);
        const viewProjection = mat4Multiply(projection, view);

        const uploadCameraFrame = (frame: CameraFrameUploadSource, mirrored: boolean): void => {
          if (cancelled) return;
          if (!hasReportedCameraSource) {
            hasReportedCameraSource = true;
            setSource('camera');
            console.log(
              `CUBE_TRACE source-change ${JSON.stringify({ source: 'camera', w: frame.width, h: frame.height })}`
            );
          }

          const currentBindGroup = ensureTexture(frame.width, frame.height, getCameraFrameTextureFormat(frame));
          profile.count('cameraUploads');
          profile.count('uploadedBytes', getCameraFrameByteLength(frame));
          profile.time('uploadTexture', () => uploadCameraFrameToTexture(device, cameraTexture!, frame));
          activeSource = 'camera';
          activeWidth = frame.width;
          activeHeight = frame.height;
          bindGroup = currentBindGroup;
          lastUpload = Date.now();
          activeTextureMirrored = mirrored;
        };

        const scheduleCameraUpload = (ic: ImageCapture, mirrored: boolean): void => {
          if (cameraGrabInFlight) return;
          cameraGrabInFlight = true;
          void (async () => {
            let frame: CameraFrameUploadSource | null = null;
            try {
              frame = await profile.timeAsync('grabFrame', () => ic.grabFrame());
              if (cancelled || imageCaptureRef.current !== ic) return;
              if (Date.now() < imageCaptureAcceptAfterRef.current) {
                lastUpload = Date.now();
                setLastGrabError(null);
                return;
              }
              grabsThisSecond++;
              uploadCameraFrame(frame, mirrored);
              setLastGrabError(null);
            } catch (e) {
              if (!cancelled && imageCaptureRef.current === ic) {
                const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                setLastGrabError(reason);
                lastUpload = Date.now();
              }
            } finally {
              if (frame) closeCameraFrame(frame);
              cameraGrabInFlight = false;
            }
          })();
        };

        const renderFrame = (): void => {
          if (cancelled) return;
          const now = Date.now();
          const elapsed = (now - startedAt) / 1000;
          const shouldUpload = now - lastUpload >= CAMERA_UPLOAD_INTERVAL_MS;

          if (shouldUpload) {
            // Pull from the active ImageCapture (set by the stream effect
            // whenever the context's stream changes). Camera grabs run
            // outside the render path so one
            // expensive browser ImageCapture copy cannot stop animation.
            const ic = imageCaptureRef.current;
            if (ic) {
              // @ref LLP 0010#frame-bound-demo-mirroring — Snapshot mirroring
              // with the capture object; stopped tracks can lose facingMode
              // before an in-flight grabFrame() resolves.
              scheduleCameraUpload(ic, imageCaptureMirroredRef.current);
            }
          }

          const model = mat4Multiply(mat4RotateY(elapsed * 0.7), mat4RotateX(elapsed * 0.4));
          const mvp = mat4Multiply(viewProjection, model);
          uniformScratch.set(mvp, 0);
          uniformScratch[16] = activeTextureMirrored ? 1 : 0;
          device.queue.writeBuffer(uniformBuffer, 0, uniformScratch);

          const renderStart = nowMs();
          const presentationTexture = context.getCurrentTexture();
          const presentationWidth = presentationTexture.width ?? canvasWidth;
          const presentationHeight = presentationTexture.height ?? canvasHeight;
          const encoder = device.createCommandEncoder();
          const colorAttachment = {
            view: presentationTexture.createView(),
            clearValue: { r: 0.04, g: 0.06, b: 0.1, a: 1 },
            loadOp: 'clear' as const,
            storeOp: 'store' as const,
          };
          const pass = bindGroup
            ? encoder.beginRenderPass({
                colorAttachments: [colorAttachment],
                depthStencilAttachment: {
                  view: ensureDepthTexture(presentationWidth, presentationHeight).createView(),
                  depthClearValue: 1,
                  depthLoadOp: 'clear',
                  depthStoreOp: 'store',
                },
              })
            : encoder.beginRenderPass({
                colorAttachments: [colorAttachment],
              });
          if (bindGroup) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.setVertexBuffer(0, vertexBuffer);
            pass.draw(CUBE_VERTEX_COUNT);
          }
          pass.end();
          device.queue.submit([encoder.finish()]);
          context.present();
          profile.duration('renderSubmitPresent', nowMs() - renderStart);

          frames++;
          profile.count('renderFrames');
          if (now - lastReport >= 1000) {
            const fps = (frames / ((now - lastReport) / 1000)).toFixed(1);
            console.log(
              `CUBE_FPS ${JSON.stringify({ fps: +fps, frames, source: activeSource, w: activeWidth, h: activeHeight, grabs: grabsThisSecond })}`
            );
            profile.report({
              fps: Number(fps),
              grabs: grabsThisSecond,
              height: activeHeight,
              source: activeSource,
              width: activeWidth,
            });
            frames = 0;
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
          depthTexture?.destroy();
          vertexBuffer.destroy();
          uniformBuffer.destroy();
        };
      } catch (e) {
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        setError(message);
        setStatus('error');
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
    ? 'Camera stopped. Tap Start camera to share the live feed with the Home tab too.'
    : source === 'camera'
      ? 'Live camera frames via getUserMedia → ImageCapture → WebGPU — shared with the Home tab.'
      : 'Opening the camera…';
  const isDesktop = windowWidth >= 1040;
  const isWebDesktop = Platform.OS === 'web' && isDesktop;
  const canvasWidth = isDesktop
    ? Math.max(320, Math.min(isWebDesktop ? windowWidth - 456 : windowWidth - 64, 960, Math.max(320, windowHeight - (isWebDesktop ? 180 : 240)) * 4 / 3))
    : Math.max(240, Math.min(windowWidth, windowHeight - 240));
  const canvasHeight = isDesktop ? Math.round(canvasWidth * 3 / 4) : canvasWidth;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic">
      <DemoPageFrame
        action="standard-camera"
        preview={<Canvas ref={ref} style={[styles.canvas, { height: canvasHeight, width: canvasWidth }]} />}
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
          </View>
        }
        hud={
          <View style={styles.hud}>
            <Text style={styles.hudText}>Cube of cameras · {status}</Text>
            <Text style={styles.hudSub}>{subtitle}</Text>
            <Text style={styles.hudSub}>· camera context: {cameraStatus}</Text>
            {cameraError ? <Text style={styles.hudError}>· camera error: {cameraError}</Text> : null}
            {lastGrabError && source !== 'camera' ? (
              <Text style={styles.hudSub}>· grabFrame: {lastGrabError}</Text>
            ) : null}
            {error ? <Text style={styles.hudError}>{error}</Text> : null}
          </View>
        }
      />
    </ScrollView>
  );
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
    backgroundColor: '#0a0e1a',
  },
  controls: {
    alignSelf: 'stretch',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  pickerHost: {
    alignSelf: 'stretch',
    height: 34,
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
