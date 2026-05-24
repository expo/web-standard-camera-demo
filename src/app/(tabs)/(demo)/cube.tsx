import * as React from 'react';
import { Dimensions, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';

// Rotating cube whose six faces all show a "live" texture. On simulator the
// texture is a JS-generated procedural pattern uploaded each frame via
// device.queue.writeTexture; on device this will swap to a CVPixelBuffer-backed
// GPUTexture imported via SharedTextureMemory, with everything else unchanged.
//
// Direct adaptation of the WebGPU samples' rotatingCube + videoUploading
// demos. The WGSL is byte-identical in spirit to the browser version; only the
// texture upload differs.

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

const TEX_SIZE = 256;

export default function CubeOfCamerasScreen(): React.JSX.Element {
  const ref = useCanvasRef();
  const { device, adapter } = useDevice();
  const [status, setStatus] = React.useState('initializing');
  const [error, setError] = React.useState<string | null>(null);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const start = (): void => {
      try {
        const context = ref.current?.getContext('webgpu');
        if (!context) {
          throw new Error('getContext("webgpu") returned null');
        }

        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'opaque' });

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
            targets: [{ format }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'back' },
          depthStencil: {
            format: 'depth24plus',
            depthWriteEnabled: true,
            depthCompare: 'less',
          },
        });

        const canvas = ref.current!.getNativeSurface();
        const canvasWidth = Math.max(1, Math.floor(canvas.width));
        const canvasHeight = Math.max(1, Math.floor(canvas.height));

        const depthTexture = device.createTexture({
          size: { width: canvasWidth, height: canvasHeight },
          format: 'depth24plus',
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });

        const cameraTexture = device.createTexture({
          size: { width: TEX_SIZE, height: TEX_SIZE },
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
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

        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: cameraTexture.createView() },
            { binding: 2, resource: sampler },
          ],
        });

        const pixelData = new Uint8Array(TEX_SIZE * TEX_SIZE * 4);

        const aspect = canvasWidth / canvasHeight;
        const projection = mat4Perspective((60 * Math.PI) / 180, aspect, 0.1, 100);
        const view = mat4Translate(0, 0, -5);
        const viewProjection = mat4Multiply(projection, view);

        const start = Date.now();
        let frames = 0;
        let lastReport = start;

        const renderFrame = (): void => {
          if (cancelled) return;
          const elapsed = (Date.now() - start) / 1000;

          // Procedural test pattern: time-varying color bars + diagonal sweep
          // so the texture is obviously alive across frames and clearly maps
          // onto each cube face without ambiguity. Stand-in for the camera.
          fillTestPattern(pixelData, TEX_SIZE, elapsed);
          device.queue.writeTexture(
            { texture: cameraTexture },
            pixelData,
            { bytesPerRow: TEX_SIZE * 4, rowsPerImage: TEX_SIZE },
            { width: TEX_SIZE, height: TEX_SIZE }
          );

          const model = mat4Multiply(mat4RotateY(elapsed * 0.7), mat4RotateX(elapsed * 0.4));
          const mvp = mat4Multiply(viewProjection, model);
          device.queue.writeBuffer(uniformBuffer, 0, mvp);

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

          frames++;
          const now = Date.now();
          if (now - lastReport >= 1000) {
            const fps = (frames / ((now - lastReport) / 1000)).toFixed(1);
            // eslint-disable-next-line no-console
            console.log(`CUBE_FPS ${JSON.stringify({ fps: +fps, frames })}`);
            frames = 0;
            lastReport = now;
          }

          rafRef.current = requestAnimationFrame(renderFrame);
        };

        setStatus(`ok — ${adapter?.info?.vendor ?? 'unknown adapter'}`);
        rafRef.current = requestAnimationFrame(renderFrame);

        cleanup = (): void => {
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          depthTexture.destroy();
          cameraTexture.destroy();
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
    const timer = setTimeout(start, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      cleanup?.();
    };
  }, [device, adapter, ref]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic">
      <Canvas ref={ref} style={styles.canvas} />
      <View style={styles.hud}>
        <Text style={styles.hudText}>Cube of cameras · {status}</Text>
        <Text style={styles.hudSub}>Simulator: synthetic frames stand in for the camera feed.</Text>
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
// whose phase shifts so the texture is obviously alive frame to frame.
function fillTestPattern(buf: Uint8Array, size: number, t: number): void {
  const phase = (t * 60) | 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const diag = (x + y + phase) & 0xff;
      const ring = ((x * x + y * y) >> 4) & 0xff;
      buf[i + 0] = diag;
      buf[i + 1] = (ring + phase) & 0xff;
      buf[i + 2] = (255 - diag + (phase >> 1)) & 0xff;
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
