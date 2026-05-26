import { Button as UIButton, Host, Picker, Text as UIText } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize, disabled, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import * as Device from 'expo-device';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import * as React from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';

import { useCamera } from '@/contexts/CameraContext';
import { configureWebGpuCanvas } from '@/lib/webgpu-canvas';
import { createWebGpuPerfProbe, nowMs } from '@/lib/webgpu-perf';
import {
  NativeStandardCamera,
  type NativeLiDARDepthFrame,
} from '../../../../modules/standard-camera';

// @ref LLP 0012#demo-lidar-depth-field — Native ARKit camera and LiDAR depth
// frames are uploaded into WebGPU textures; WGSL fuses that native mobile
// sensor stream into web-rendered camera, depth, and focus views.

const FULLSCREEN_VERTEX_COUNT = 6;
const FRAME_UPLOAD_INTERVAL_MS = 33;
const DEFAULT_OCCLUSION_DEPTH_M = 1.25;
const MIN_OCCLUSION_DEPTH_M = 0.45;
const MAX_OCCLUSION_DEPTH_M = 3.5;
const OCCLUSION_DEPTHS_M = [0.8, 1.25, 2.0];
const COMPARE_DEPTH_SPLIT = 0.5;
const VIEW_MODES = [
  { label: 'Compare', value: 2 },
  { label: 'Focus', value: 3 },
  { label: 'Depth', value: 1 },
  { label: 'Camera', value: 0 },
] as const;

const DEPTH_SHADER = /* wgsl */ `
struct Uniforms {
  depthWidth: f32,
  depthHeight: f32,
  colorWidth: f32,
  colorHeight: f32,
  minDepth: f32,
  maxDepth: f32,
  time: f32,
  canvasAspect: f32,
  frameNumber: f32,
  targetDepth: f32,
  rotate: f32,
  mode: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var depthTex: texture_2d<f32>;
@group(0) @binding(2) var cameraTex: texture_2d<f32>;
@group(0) @binding(3) var cameraSampler: sampler;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

fn fullScreenCorner(i: u32) -> vec2f {
  let corners = array<vec2f, 6>(
    vec2f(-1.0,  1.0),
    vec2f( 1.0,  1.0),
    vec2f(-1.0, -1.0),
    vec2f(-1.0, -1.0),
    vec2f( 1.0,  1.0),
    vec2f( 1.0, -1.0),
  );
  return corners[i];
}

fn sourceAspect(width: f32, height: f32) -> f32 {
  let rawAspect = max(width / max(height, 1.0), 0.001);
  if (u.rotate < 0.5) {
    return rawAspect;
  }
  return 1.0 / rawAspect;
}

fn fitUvForAspect(screenUv: vec2f, width: f32, height: f32, viewportAspect: f32) -> vec2f {
  let dataAspect = sourceAspect(width, height);
  var uv = screenUv;
  if (viewportAspect > dataAspect) {
    uv.x = (screenUv.x - 0.5) * viewportAspect / dataAspect + 0.5;
  } else {
    uv.y = (screenUv.y - 0.5) * dataAspect / max(viewportAspect, 0.001) + 0.5;
  }
  return uv;
}

fn sourceUvForAspect(screenUv: vec2f, width: f32, height: f32, viewportAspect: f32) -> vec2f {
  let fitted = fitUvForAspect(screenUv, width, height, viewportAspect);
  if (u.rotate < 0.5) {
    return fitted;
  }
  return vec2f(fitted.y, 1.0 - fitted.x);
}

fn sourceUvForScreen(screenUv: vec2f, width: f32, height: f32) -> vec2f {
  return sourceUvForAspect(screenUv, width, height, u.canvasAspect);
}

fn mixDepthValue(a: f32, b: f32, amount: f32) -> f32 {
  if (!(a > 0.0)) {
    return b;
  }
  if (!(b > 0.0)) {
    return a;
  }
  return mix(a, b, amount);
}

fn sampleDepth(depthUv: vec2f) -> f32 {
  let maxCoord = vec2i(max(i32(u.depthWidth) - 1, 0), max(i32(u.depthHeight) - 1, 0));
  let maxCoordFloat = vec2f(f32(maxCoord.x), f32(maxCoord.y));
  let pos = clamp(depthUv, vec2f(0.0), vec2f(1.0)) * maxCoordFloat;
  let baseCoord = clamp(vec2i(floor(pos)), vec2i(0), maxCoord);
  let nextCoord = min(baseCoord + vec2i(1), maxCoord);
  let f = fract(pos);
  let d00 = textureLoad(depthTex, baseCoord, 0).r;
  let d10 = textureLoad(depthTex, vec2i(nextCoord.x, baseCoord.y), 0).r;
  let d01 = textureLoad(depthTex, vec2i(baseCoord.x, nextCoord.y), 0).r;
  let d11 = textureLoad(depthTex, nextCoord, 0).r;
  let top = mixDepthValue(d00, d10, f.x);
  let bottom = mixDepthValue(d01, d11, f.x);
  return mixDepthValue(top, bottom, f.y);
}

fn palette(depth01: f32) -> vec3f {
  let near = vec3f(1.0, 0.36, 0.12);
  let mid = vec3f(0.20, 0.92, 0.78);
  let far = vec3f(0.18, 0.24, 0.74);
  let a = smoothstep(0.0, 0.58, depth01);
  let b = smoothstep(0.38, 1.0, depth01);
  return mix(mix(near, mid, a), far, b);
}

fn depthRelief(depth: f32, depthUv: vec2f) -> vec3f {
  let nearDepth = max(u.minDepth, 0.05);
  let farDepth = max(max(u.maxDepth, u.targetDepth + 0.9), nearDepth + 0.75);
  let depth01 = clamp((depth - nearDepth) / (farDepth - nearDepth), 0.0, 1.0);

  let texelStep = 1.0 / vec2f(max(u.depthWidth, 1.0), max(u.depthHeight, 1.0));
  let dL = sampleDepth(clamp(depthUv + vec2f(-texelStep.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let dR = sampleDepth(clamp(depthUv + vec2f( texelStep.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let dU = sampleDepth(clamp(depthUv + vec2f(0.0, -texelStep.y), vec2f(0.0), vec2f(1.0)));
  let dD = sampleDepth(clamp(depthUv + vec2f(0.0,  texelStep.y), vec2f(0.0), vec2f(1.0)));
  let normal = normalize(vec3f((dL - dR) * 2.8, (dU - dD) * 2.8, 1.0));
  let light = clamp(dot(normal, normalize(vec3f(-0.45, -0.55, 1.0))), 0.0, 1.0);

  let phase = fract(depth * 2.8);
  let contourDistance = min(phase, 1.0 - phase);
  let contour = 1.0 - smoothstep(0.0, 0.038, contourDistance);
  var color = palette(depth01) * (0.48 + light * 0.58);
  color += contour * vec3f(0.95, 0.98, 0.90) * 0.22;
  return color;
}

fn targetDepthBand(depth: f32, mask: f32) -> f32 {
  let distanceToPlane = abs(depth - u.targetDepth);
  return (1.0 - smoothstep(0.0, 0.12, distanceToPlane)) * mask;
}

fn foregroundDepth(depth: f32) -> f32 {
  return 1.0 - smoothstep(u.targetDepth - 0.22, u.targetDepth - 0.035, depth);
}

fn depthDiscontinuity(depth: f32, depthUv: vec2f) -> f32 {
  let texelStep = 1.0 / vec2f(max(u.depthWidth, 1.0), max(u.depthHeight, 1.0));
  let dL = sampleDepth(clamp(depthUv + vec2f(-texelStep.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let dR = sampleDepth(clamp(depthUv + vec2f( texelStep.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let dU = sampleDepth(clamp(depthUv + vec2f(0.0, -texelStep.y), vec2f(0.0), vec2f(1.0)));
  let dD = sampleDepth(clamp(depthUv + vec2f(0.0,  texelStep.y), vec2f(0.0), vec2f(1.0)));
  let jump = max(max(abs(depth - dL), abs(depth - dR)), max(abs(depth - dU), abs(depth - dD)));
  return smoothstep(0.035, 0.16, jump);
}

fn foregroundRim(depth: f32, depthUv: vec2f) -> f32 {
  let fg = foregroundDepth(depth);
  let edge = depthDiscontinuity(depth, depthUv);
  return max(edge * fg, fg * 0.08);
}

fn sampleCamera(colorUv: vec2f, offset: vec2f, radius: f32) -> vec3f {
  let maxCoord = vec2i(max(i32(u.colorWidth) - 1, 0), max(i32(u.colorHeight) - 1, 0));
  let coord = clamp(
    vec2i(colorUv * vec2f(u.colorWidth, u.colorHeight) + offset * radius),
    vec2i(0),
    maxCoord
  );
  return textureLoad(cameraTex, coord, 0).rgb;
}

fn depthFocus(camera: vec3f, colorUv: vec2f, screenUv: vec2f, depth: f32, depthUv: vec2f) -> vec3f {
  let distanceToTarget = abs(depth - u.targetDepth);
  let focusBand = 1.0 - smoothstep(0.035, 0.24, distanceToTarget);
  let blurStrength = smoothstep(0.10, 0.82, distanceToTarget);
  let blurRadius = mix(1.0, 8.0, blurStrength);
  let diagonalRadius = blurRadius * 0.72;

  var blurred = sampleCamera(colorUv, vec2f(0.0, 0.0), blurRadius) * 0.18;
  blurred += sampleCamera(colorUv, vec2f( 1.0,  0.0), blurRadius) * 0.10;
  blurred += sampleCamera(colorUv, vec2f(-1.0,  0.0), blurRadius) * 0.10;
  blurred += sampleCamera(colorUv, vec2f( 0.0,  1.0), blurRadius) * 0.10;
  blurred += sampleCamera(colorUv, vec2f( 0.0, -1.0), blurRadius) * 0.10;
  blurred += sampleCamera(colorUv, vec2f( 1.0,  1.0), diagonalRadius) * 0.08;
  blurred += sampleCamera(colorUv, vec2f(-1.0,  1.0), diagonalRadius) * 0.08;
  blurred += sampleCamera(colorUv, vec2f( 1.0, -1.0), diagonalRadius) * 0.08;
  blurred += sampleCamera(colorUv, vec2f(-1.0, -1.0), diagonalRadius) * 0.08;
  blurred += sampleCamera(colorUv, vec2f( 2.0,  0.7), diagonalRadius) * 0.05;
  blurred += sampleCamera(colorUv, vec2f(-2.0, -0.7), diagonalRadius) * 0.05;

  var color = mix(camera, blurred, blurStrength * 0.88);
  let rim = foregroundRim(depth, depthUv);
  let targetBand = targetDepthBand(depth, 1.0);
  color = mix(color, camera * 1.08 + vec3f(0.08, 0.05, 0.0), targetBand * 0.34);
  color += focusBand * vec3f(0.02, 0.08, 0.07);
  color = mix(color, vec3f(1.0, 0.67, 0.18), rim * 0.28);
  return color;
}

fn compareView(screenUv: vec2f, camera: vec3f, depth: f32, depthUv: vec2f) -> vec3f {
  let targetBand = targetDepthBand(depth, 1.0);
  let rim = foregroundRim(depth, depthUv);
  let relief = depthRelief(depth, depthUv);

  let cameraSide = camera;
  var depthSide = mix(relief, vec3f(1.0, 0.80, 0.24), targetBand * 0.24);
  depthSide = mix(depthSide, vec3f(1.0, 0.56, 0.16), rim * 0.18);

  let splitX = ${COMPARE_DEPTH_SPLIT.toFixed(2)};
  let isDepthSide = step(splitX, screenUv.x);
  let divider = 1.0 - smoothstep(0.0, 0.006, abs(screenUv.x - splitX));
  var color = mix(cameraSide, depthSide, isDepthSide);
  color = mix(color, vec3f(0.02, 0.08, 0.09), divider * 0.84);
  color += divider * vec3f(0.34, 1.0, 0.86) * 0.18;
  return color;
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VsOut {
  var out: VsOut;
  let pos = fullScreenCorner(vertexIndex);
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = vec2f(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let colorUv = sourceUvForScreen(in.uv, u.colorWidth, u.colorHeight);
  let camera = textureSample(cameraTex, cameraSampler, clamp(colorUv, vec2f(0.0), vec2f(1.0))).rgb;
  if (u.frameNumber < 1.0 || u.depthWidth < 1.0 || u.depthHeight < 1.0) {
    return vec4f(camera, 1.0);
  }

  let depthUv = sourceUvForScreen(in.uv, u.depthWidth, u.depthHeight);
  let inDepthFrame = all(depthUv >= vec2f(0.0)) && all(depthUv <= vec2f(1.0));
  if (!inDepthFrame) {
    return vec4f(camera * 0.42, 1.0);
  }

  let depth = sampleDepth(depthUv);
  if (!(depth > 0.0)) {
    return vec4f(camera, 1.0);
  }

  let relief = depthRelief(depth, depthUv);
  var color = camera;
  if (u.mode > 2.5) {
    color = depthFocus(camera, colorUv, in.uv, depth, depthUv);
  } else if (u.mode > 1.5) {
    color = compareView(in.uv, camera, depth, depthUv);
  } else if (u.mode > 0.5) {
    let rim = foregroundRim(depth, depthUv);
    color = mix(relief, vec3f(1.0, 0.68, 0.18), rim * 0.54);
  }

  let vignette = smoothstep(1.28, 0.28, length((in.uv - 0.5) * vec2f(u.canvasAspect, 1.0)));
  color *= 0.72 + vignette * 0.38;
  return vec4f(color, 1.0);
}
`;

export default function LiDARDepthScreen(): React.JSX.Element {
  const ref = useCanvasRef();
  const { adapter, device } = useDevice();
  const { lidarStatus, lidarCapabilities, lidarError, startLiDAR, stopLiDAR } = useCamera();
  const { autorun } = useLocalSearchParams<{ autorun?: string }>();
  const { width: windowWidth } = useWindowDimensions();
  // Start idle and wait for an explicit Start tap. The mount no longer
  // auto-launches ARKit because acquiring the AVCaptureDevice is a heavy,
  // exclusive action that should be the user's choice — and starting on
  // mount used to tear down the standard camera unannounced, leaving every
  // other demo stranded in a "Start" state the user never asked for.
  const [status, setStatus] = React.useState('idle');
  const [frameInfo, setFrameInfo] = React.useState('waiting for depth');
  const [depthRange, setDepthRange] = React.useState('range pending');
  const [centerDepth, setCenterDepth] = React.useState('pending');
  const [fps, setFps] = React.useState('0.0');
  const [error, setError] = React.useState<string | null>(null);
  const [foregroundPercent, setForegroundPercent] = React.useState(0);
  const [maskInfo, setMaskInfo] = React.useState('mask pending');
  const [targetDepth, setTargetDepth] = React.useState(DEFAULT_OCCLUSION_DEPTH_M);
  const [cameraInfo, setCameraInfo] = React.useState('waiting for preview');
  const [lastCenterDepthMeters, setLastCenterDepthMeters] = React.useState<number | null>(null);
  const [viewMode, setViewMode] = React.useState(2);
  const lastCenterDepthRef = React.useRef<number | null>(null);
  const didAutorunRef = React.useRef(false);
  const targetDepthRef = React.useRef(targetDepth);
  const viewModeRef = React.useRef(viewMode);

  const stageWidth = Math.min(Math.max(288, windowWidth - 32), 420);
  const stageHeight = Math.round(stageWidth * 4 / 3);

  const resetLiDARReadouts = React.useCallback((nextStatus: string): void => {
    setStatus(nextStatus);
    setFrameInfo('waiting for depth');
    setDepthRange('range pending');
    setCenterDepth('pending');
    setFps('0.0');
    setForegroundPercent(0);
    setMaskInfo('mask pending');
    setCameraInfo('waiting for preview');
    setLastCenterDepthMeters(null);
    lastCenterDepthRef.current = null;
  }, []);

  // @ref LLP 0012#validation — Normal users opt into ARKit with Start; the
  // autorun query param gives device validation a non-interactive launch path.
  React.useEffect(() => {
    if (autorun !== '1' || didAutorunRef.current) return;
    didAutorunRef.current = true;
    void startLiDAR();
  }, [autorun, startLiDAR]);

  // Blur/unmount cleanup: ARKit always gets torn down and the context lock
  // released. Expo Router can keep route components mounted after navigation,
  // so tying cleanup to focus prevents hidden LiDAR sessions from continuing.
  // We deliberately do not auto-start ARKit on mount — see the
  // `useState('idle')` rationale.
  useFocusEffect(React.useCallback(() => {
    return () => {
      void stopLiDAR();
    };
  }, [stopLiDAR]));

  React.useEffect(() => {
    if (lidarStatus === 'stopping') {
      resetLiDARReadouts('stopped');
    } else if (lidarStatus === 'stopped') {
      resetLiDARReadouts('stopped');
      setError(null);
    } else if (lidarStatus === 'unsupported') {
      resetLiDARReadouts('unsupported');
    } else if (lidarStatus === 'error') {
      resetLiDARReadouts('error');
    } else if (lidarStatus === 'interrupted') {
      resetLiDARReadouts('interrupted');
    }
  }, [lidarStatus, resetLiDARReadouts]);

  React.useEffect(() => {
    targetDepthRef.current = targetDepth;
  }, [targetDepth]);

  React.useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  useFocusEffect(
    React.useCallback(() => {
    if (!device) return undefined;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    const startRender = (): void => {
      try {
        const profile = createWebGpuPerfProbe('lidar-depth', {
          uploadIntervalMs: FRAME_UPLOAD_INTERVAL_MS,
        });
        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        const { context } = configureWebGpuCanvas(ref, device, presentationFormat);

        device.pushErrorScope('validation');
        const shaderModule = device.createShaderModule({ code: DEPTH_SHADER });
        void shaderModule.getCompilationInfo().then((info) => {
          if (info.messages.length === 0 || !__DEV__) return;
          // eslint-disable-next-line no-console
          console.log(
            `LIDAR_DEPTH_SHADER ${JSON.stringify(
              info.messages.map((message) => ({
                line: message.lineNum,
                message: message.message,
                type: message.type,
              }))
            )}`
          );
        });
        const bindGroupLayout = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
              buffer: { type: 'uniform' },
            },
            {
              binding: 1,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
            },
            {
              binding: 2,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'float', viewDimension: '2d' },
            },
            {
              binding: 3,
              visibility: GPUShaderStage.FRAGMENT,
              sampler: { type: 'filtering' },
            },
          ],
        });
        const pipelineLayout = device.createPipelineLayout({
          bindGroupLayouts: [bindGroupLayout],
        });
        const pipeline = device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: { module: shaderModule, entryPoint: 'vs_main' },
          fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [
              {
                format: presentationFormat,
                blend: {
                  color: {
                    srcFactor: 'src-alpha',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                  alpha: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                  },
                },
              },
            ],
          },
          primitive: { topology: 'triangle-list' },
        });
        void device.popErrorScope().then((error) => {
          if (!error) return;
          const message = error.message;
          setError(message);
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.log(`LIDAR_DEPTH_WEBGPU_ERROR ${message}`);
          }
        });

        const uniformBuffer = device.createBuffer({
          size: 48,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const cameraSampler = device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
        });

        let depthTexture: GPUTexture | null = null;
        let cameraTexture: GPUTexture | null = null;
        let bindGroup: GPUBindGroup | null = null;
        let depthWidth = 0;
        let depthHeight = 0;
        let colorWidth = 0;
        let colorHeight = 0;
        let minDepth = 0.2;
        let maxDepth = 4.0;
        let centerDepthMeters = 0;
        let lastUpload = 0;
        let lastFrameNumber = 0;
        let lastLoggedFrameNumber = 0;
        let frames = 0;
        let lastStatsReport = Date.now();
        let lastFpsReport = Date.now();
        let rafId: number | null = null;
        let reportedLiveFrame = false;
        const startedAt = Date.now();

        const rebuildBindGroup = (): void => {
          if (!depthTexture || !cameraTexture) return;
          bindGroup = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: depthTexture.createView() },
              { binding: 2, resource: cameraTexture.createView() },
              { binding: 3, resource: cameraSampler },
            ],
          });
        };

        const ensureDepthTexture = (width: number, height: number): void => {
          if (depthTexture && width === depthWidth && height === depthHeight) return;
          depthTexture?.destroy();
          depthTexture = device.createTexture({
            size: { width, height },
            format: 'r32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          depthWidth = width;
          depthHeight = height;
          rebuildBindGroup();
        };

        const ensureCameraTexture = (width: number, height: number): void => {
          if (cameraTexture && width === colorWidth && height === colorHeight) return;
          cameraTexture?.destroy();
          cameraTexture = device.createTexture({
            size: { width, height },
            format: 'bgra8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          colorWidth = width;
          colorHeight = height;
          rebuildBindGroup();
        };

        ensureDepthTexture(1, 1);
        device.queue.writeTexture(
          { texture: depthTexture! },
          new Uint8Array(new Float32Array([DEFAULT_OCCLUSION_DEPTH_M]).buffer),
          { bytesPerRow: 256, rowsPerImage: 1 },
          { width: 1, height: 1 }
        );
        ensureCameraTexture(1, 1);
        device.queue.writeTexture(
          { texture: cameraTexture! },
          new Uint8Array([31, 36, 48, 255]),
          { bytesPerRow: 256, rowsPerImage: 1 },
          { width: 1, height: 1 }
        );

        const uploadFrame = (frame: NativeLiDARDepthFrame): void => {
          ensureDepthTexture(frame.width, frame.height);
          const depthUpload = profile.time('makeDepthUpload', () => makeDepthUpload(frame));
          profile.count('uploadedBytes', depthUpload.data.byteLength);
          profile.time('writeDepthTexture', () =>
            device.queue.writeTexture(
              { texture: depthTexture! },
              depthUpload.data,
              { bytesPerRow: depthUpload.bytesPerRow, rowsPerImage: frame.height },
              { width: frame.width, height: frame.height }
            )
          );
          const colorFrame =
            frame.colorData && frame.colorWidth && frame.colorHeight
              ? {
                  data: frame.colorData,
                  height: frame.colorHeight,
                  width: frame.colorWidth,
                }
              : {
                  data: new Uint8Array([0, 0, 0, 255]),
                  height: 1,
                  width: 1,
                };
          ensureCameraTexture(colorFrame.width, colorFrame.height);
          const colorUpload = profile.time('makeColorUpload', () =>
            makeColorUpload(colorFrame.width, colorFrame.height, colorFrame.data)
          );
          profile.count('uploadedBytes', colorUpload.data.byteLength);
          profile.time('writeColorTexture', () =>
            device.queue.writeTexture(
              { texture: cameraTexture! },
              colorUpload.data,
              { bytesPerRow: colorUpload.bytesPerRow, rowsPerImage: colorFrame.height },
              { width: colorFrame.width, height: colorFrame.height }
            )
          );
          profile.count('nativeUploads');
          lastFrameNumber = frame.frameNumber;
          minDepth = frame.minDepth > 0 ? frame.minDepth : 0.2;
          maxDepth = frame.maxDepth > minDepth ? frame.maxDepth : minDepth + 1.0;
          centerDepthMeters = profile.time('sampleCenterDepth', () => sampleCenterDepth(frame));
        };

        const renderFrame = (): void => {
          if (cancelled) return;
          const now = Date.now();
          const latest =
            now - lastUpload >= FRAME_UPLOAD_INTERVAL_MS
              ? profile.time('getLatestLiDARDepthFrame', () => NativeStandardCamera.getLatestLiDARDepthFrame())
              : null;

          if (latest && latest.frameNumber !== lastFrameNumber) {
            uploadFrame(latest);
            lastUpload = now;
            if (__DEV__ && latest.frameNumber - lastLoggedFrameNumber >= 60) {
              lastLoggedFrameNumber = latest.frameNumber;
              // eslint-disable-next-line no-console
              console.log(
                `LIDAR_DEPTH_FRAME ${JSON.stringify({
                  frameNumber: latest.frameNumber,
                  height: latest.height,
                  colorHeight: latest.colorHeight,
                  colorWidth: latest.colorWidth,
                  maxDepth: latest.maxDepth,
                  meanDepth: latest.meanDepth,
                  minDepth: latest.minDepth,
                  width: latest.width,
                })}`
              );
            }
            if (now - lastStatsReport >= 500) {
              const maskStats = sampleOcclusionStats(latest, targetDepthRef.current);
              setFrameInfo(`${latest.width}x${latest.height} #${latest.frameNumber}`);
              setDepthRange(
                `${latest.minDepth.toFixed(2)}m-${latest.maxDepth.toFixed(2)}m mean ${latest.meanDepth.toFixed(2)}m`
              );
              setCameraInfo(
                latest.colorWidth && latest.colorHeight
                  ? `${latest.colorWidth}x${latest.colorHeight} ARKit`
                  : 'preview unavailable'
              );
              if (centerDepthMeters > 0) {
                lastCenterDepthRef.current = centerDepthMeters;
                setLastCenterDepthMeters(centerDepthMeters);
                setCenterDepth(`${centerDepthMeters.toFixed(2)}m`);
              } else {
                lastCenterDepthRef.current = null;
                setLastCenterDepthMeters(null);
                setCenterDepth('no return');
              }
              setForegroundPercent(Math.round(maskStats.foregroundRatio * 100));
              setMaskInfo(
                `${formatPercent(maskStats.foregroundRatio)} closer · ${formatPercent(maskStats.targetRatio)} at target`
              );
              if (!reportedLiveFrame) {
                if (__DEV__) {
                  // @ref LLP 0012#validation — The physical-device check looks
                  // for one structured live frame log before manual inspection.
                  // eslint-disable-next-line no-console
                  console.log(
                    `LIDAR_DEPTH_LIVE ${JSON.stringify({
                      centerDepthMeters,
                      colorHeight: latest.colorHeight,
                      colorWidth: latest.colorWidth,
                      foregroundRatio: maskStats.foregroundRatio,
                      frameNumber: latest.frameNumber,
                      height: latest.height,
                      maxDepth: latest.maxDepth,
                      meanDepth: latest.meanDepth,
                      minDepth: latest.minDepth,
                      width: latest.width,
                    })}`
                  );
                }
                setStatus(`live - ${adapter?.info?.vendor ?? 'unknown adapter'}`);
                reportedLiveFrame = true;
              }
              lastStatsReport = now;
            }
          }

          const elapsed = (now - startedAt) / 1000;
          device.queue.writeBuffer(
            uniformBuffer,
            0,
            // @ref LLP 0012#demo-lidar-depth-field — The shader samples the
            // ARKit camera texture in the same orientation as the paired depth
            // map, then uses LiDAR depth to drive the web-rendered depth cues.
            new Float32Array([
              depthWidth,
              depthHeight,
              colorWidth,
              colorHeight,
              minDepth,
              maxDepth,
              elapsed,
              stageWidth / stageHeight,
              lastFrameNumber,
              targetDepthRef.current,
              colorWidth > 1 ? (colorWidth > colorHeight ? 1 : 0) : depthWidth > depthHeight ? 1 : 0,
              viewModeRef.current,
            ])
          );

          const renderStart = nowMs();
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0.015, g: 0.018, b: 0.026, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
          });
          if (bindGroup) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(FULLSCREEN_VERTEX_COUNT);
          }
          pass.end();
          device.queue.submit([encoder.finish()]);
          context.present();
          profile.duration('renderSubmitPresent', nowMs() - renderStart);

          frames += 1;
          profile.count('renderFrames');
          if (now - lastFpsReport >= 1000) {
            const fpsValue = frames / ((now - lastFpsReport) / 1000);
            setFps(fpsValue.toFixed(1));
            profile.report({
              colorHeight,
              colorWidth,
              depthHeight,
              depthWidth,
              fps: Number(fpsValue.toFixed(1)),
              frameNumber: lastFrameNumber,
            });
            frames = 0;
            lastFpsReport = now;
          }

          rafId = requestAnimationFrame(renderFrame);
        };

        setStatus(`ready - ${adapter?.info?.vendor ?? 'unknown adapter'}`);
        rafId = requestAnimationFrame(renderFrame);

        cleanup = (): void => {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
          }
          depthTexture?.destroy();
          cameraTexture?.destroy();
          uniformBuffer.destroy();
        };
      } catch (e) {
        setStatus('error');
        setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      }
    };

    const timer = setTimeout(startRender, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      cleanup?.();
    };
  }, [adapter, device, ref, stageHeight, stageWidth])
  );

  const displayStatus = (() => {
    if (status === 'error') return 'error';
    if (lidarStatus === 'starting') return 'starting LiDAR';
    if (lidarStatus === 'running') return status.startsWith('live') ? status : 'running';
    if (lidarStatus === 'interrupted') return 'interrupted LiDAR';
    if (lidarStatus === 'stopping') return 'stopping LiDAR';
    if (lidarStatus === 'stopped') return 'stopped';
    if (lidarStatus === 'unsupported') return 'unsupported';
    if (lidarStatus === 'error') return 'error';
    return status;
  })();
  const displayError = lidarError ?? error;
  const supportLine = lidarCapabilities
    ? lidarCapabilities.supported
      ? `scene depth ${lidarCapabilities.smoothedSceneDepth ? 'smoothed' : 'raw'}`
      : lidarCapabilities.reason ?? 'unsupported'
    : 'checking support';
  const badgeState = (() => {
    if (lidarStatus === 'error' || status === 'error') {
      return { label: 'LiDAR error', style: styles.badgeWarn };
    }
    if (lidarStatus === 'unsupported' || lidarCapabilities?.supported === false) {
      return { label: 'LiDAR unsupported', style: styles.badgeWarn };
    }
    if (lidarStatus === 'running' && status.startsWith('live')) {
      return { label: 'LiDAR live', style: styles.badgeLive };
    }
    if (lidarStatus === 'starting') {
      return { label: 'LiDAR starting', style: styles.badgeWarn };
    }
    if (lidarStatus === 'interrupted') {
      return { label: 'LiDAR interrupted', style: styles.badgeWarn };
    }
    if (lidarStatus === 'stopping') {
      return { label: 'LiDAR stopping', style: styles.badgeWarn };
    }
    if (lidarCapabilities?.supported) {
      return { label: 'LiDAR ready', style: styles.badgeWarn };
    }
    return { label: 'LiDAR', style: styles.badgeWarn };
  })();
  const canPinCenterDepth =
    lastCenterDepthMeters !== null && lidarStatus === 'running' && status.startsWith('live');
  const pinCenterDepth = (): void => {
    const center = lastCenterDepthRef.current;
    if (!center || !Number.isFinite(center)) return;
    setTargetDepth(clampDepth(center));
  };
  // Resolve the segmented Picker selection to one of the discrete preset
  // depths when targetDepth matches one. After Pin center, targetDepth may
  // be an arbitrary value with no matching segment — in that case selection
  // stays undefined and the segmented control shows nothing highlighted.
  const planeSelection = OCCLUSION_DEPTHS_M.find((depth) => Math.abs(targetDepth - depth) < 0.01);

  // The session has settled into a running ARKit feed once status crosses
  // into "running" or "live ...". Everything else (initializing, starting,
  // stopped, error, unsupported) means the user can ask to start again.
  const lidarRunning = lidarStatus === 'running' && status.startsWith('live');
  const showStoppedPlaceholder = Device.isDevice && !lidarRunning;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <View style={[styles.stage, { height: stageHeight, width: stageWidth }]}>
        <Canvas ref={ref} style={styles.canvas} />
        <View pointerEvents="none" style={styles.reticle}>
          <View style={styles.reticleHorizontal} />
          <View style={styles.reticleVertical} />
        </View>
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
        <View pointerEvents="none" style={styles.stageReadout}>
          <Text style={styles.stageReadoutLabel}>CENTER</Text>
          <Text style={styles.stageReadoutValue}>{centerDepth}</Text>
        </View>
        <View pointerEvents="none" style={styles.stageModePill}>
          <Text style={styles.stageModeLabel}>TARGET</Text>
          <Text style={styles.stageModeValue}>{targetDepth.toFixed(2)}m</Text>
        </View>
        {viewMode === 2 ? (
          <View pointerEvents="none" style={styles.fusionLabels}>
            <Text style={styles.fusionLabel}>Camera</Text>
            <Text style={styles.fusionLabel}>LiDAR depth</Text>
          </View>
        ) : null}
        <View pointerEvents="none" style={styles.maskReadout}>
          <View style={styles.maskReadoutHeader}>
            <Text style={styles.maskReadoutLabel}>CLOSER THAN TARGET</Text>
            <Text style={styles.maskReadoutValue}>{foregroundPercent}%</Text>
          </View>
          <View style={styles.maskBarTrack}>
            <View style={[styles.maskBarFill, { width: `${Math.min(100, foregroundPercent)}%` }]} />
          </View>
        </View>
      </View>

      <View style={styles.controls}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>LiDAR Depth Studio</Text>
          <Text style={styles.subtitle}>ARKit camera and scene depth rendered through WebGPU</Text>
        </View>

        <View style={styles.statusRow}>
          <Text style={[styles.badge, badgeState.style]}>{badgeState.label}</Text>
          <Text style={styles.statusText}>{displayStatus}</Text>
        </View>

        <Text style={styles.metric}>{supportLine}</Text>
        <Text style={styles.metric}>camera: {cameraInfo}</Text>
        <Text style={styles.metric}>depth: {frameInfo}</Text>
        <Text style={styles.metric}>center: {centerDepth}</Text>
        <Text style={styles.metric}>target: {maskInfo}</Text>
        <Text style={styles.metric}>range: {depthRange}</Text>
        <Text style={styles.metric}>webgpu: {fps} fps</Text>
        {displayError ? <Text style={styles.error}>{displayError}</Text> : null}

        <View style={styles.depthControl}>
          <Text style={styles.depthControlLabel}>View</Text>
          <Host style={styles.pickerHost}>
            <Picker
              modifiers={[pickerStyle('segmented')]}
              label="View"
              selection={viewMode}
              onSelectionChange={(value) => setViewMode(value as number)}>
              {VIEW_MODES.map((mode) => (
                <UIText key={mode.value} modifiers={[tag(mode.value)]}>
                  {mode.label}
                </UIText>
              ))}
            </Picker>
          </Host>
        </View>

        <View style={styles.depthControl}>
          <Text style={styles.depthControlLabel}>Target distance</Text>
          <Host style={styles.pickerHost}>
            <Picker
              modifiers={[pickerStyle('segmented')]}
              label="Target distance"
              selection={planeSelection}
              onSelectionChange={(value) => setTargetDepth(value as number)}>
              {OCCLUSION_DEPTHS_M.map((depth) => (
                <UIText key={depth} modifiers={[tag(depth)]}>
                  {depth.toFixed(depth % 1 === 0 ? 0 : 2)}m
                </UIText>
              ))}
            </Picker>
          </Host>
        </View>

        <View style={styles.buttonRow}>
          <Host matchContents>
            <UIButton
              modifiers={[buttonStyle('bordered'), controlSize('large'), disabled(!canPinCenterDepth)]}
              systemImage="scope"
              label="Pin center"
              onPress={pinCenterDepth}
            />
          </Host>
        </View>
        </View>
    </ScrollView>
  );
}

function makeDepthUpload(frame: NativeLiDARDepthFrame): { bytesPerRow: number; data: Uint8Array } {
  const srcRowBytes = frame.width * 4;
  const bytesPerRow = Math.ceil(srcRowBytes / 256) * 256;
  if (bytesPerRow === srcRowBytes) {
    return { bytesPerRow, data: frame.depthData };
  }

  const padded = new Uint8Array(bytesPerRow * frame.height);
  for (let y = 0; y < frame.height; y += 1) {
    padded.set(
      frame.depthData.subarray(y * srcRowBytes, (y + 1) * srcRowBytes),
      y * bytesPerRow
    );
  }
  return { bytesPerRow, data: padded };
}

function makeColorUpload(
  width: number,
  height: number,
  data: Uint8Array
): { bytesPerRow: number; data: Uint8Array } {
  const srcRowBytes = width * 4;
  const bytesPerRow = Math.ceil(srcRowBytes / 256) * 256;
  if (bytesPerRow === srcRowBytes) {
    return { bytesPerRow, data };
  }

  const padded = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    const srcRow = y * srcRowBytes;
    const dstRow = y * bytesPerRow;
    padded.set(data.subarray(srcRow, srcRow + srcRowBytes), dstRow);
  }
  return { bytesPerRow, data: padded };
}

function sampleCenterDepth(frame: NativeLiDARDepthFrame): number {
  const values = new Float32Array(
    frame.depthData.buffer,
    frame.depthData.byteOffset,
    Math.min(frame.width * frame.height, Math.floor(frame.depthData.byteLength / 4))
  );
  const cx = Math.floor(frame.width / 2);
  const cy = Math.floor(frame.height / 2);
  let sum = 0;
  let count = 0;
  for (let y = Math.max(0, cy - 2); y <= Math.min(frame.height - 1, cy + 2); y += 1) {
    for (let x = Math.max(0, cx - 2); x <= Math.min(frame.width - 1, cx + 2); x += 1) {
      const depth = values[y * frame.width + x] ?? 0;
      if (Number.isFinite(depth) && depth > 0) {
        sum += depth;
        count += 1;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

interface OcclusionStats {
  foregroundRatio: number;
  targetRatio: number;
}

// @ref LLP 0012#demo-lidar-depth-field — This CPU-side readout samples the same
// tight Float32 depth frame that WebGPU consumes, so the UI can prove the native
// LiDAR target-distance mask is live while the shader uses it for depth cues.
function sampleOcclusionStats(frame: NativeLiDARDepthFrame, targetDepth: number): OcclusionStats {
  const values = new Float32Array(
    frame.depthData.buffer,
    frame.depthData.byteOffset,
    Math.min(frame.width * frame.height, Math.floor(frame.depthData.byteLength / 4))
  );
  const x0 = Math.floor(frame.width * 0.33);
  const x1 = Math.max(x0 + 1, Math.floor(frame.width * 0.67));
  const y0 = Math.floor(frame.height * 0.22);
  const y1 = Math.max(y0 + 1, Math.floor(frame.height * 0.78));
  const stepX = Math.max(1, Math.floor((x1 - x0) / 36));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 48));
  let foreground = 0;
  let targetPlane = 0;
  let valid = 0;

  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const depth = values[y * frame.width + x] ?? 0;
      if (!Number.isFinite(depth) || depth <= 0) continue;
      valid += 1;
      if (depth < targetDepth - 0.035) foreground += 1;
      if (Math.abs(depth - targetDepth) <= 0.12) targetPlane += 1;
    }
  }

  return {
    foregroundRatio: valid > 0 ? foreground / valid : 0,
    targetRatio: valid > 0 ? targetPlane / valid : 0,
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function clampDepth(depth: number): number {
  return Math.min(MAX_OCCLUSION_DEPTH_M, Math.max(MIN_OCCLUSION_DEPTH_M, depth));
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
  stoppedOverlay: {
    alignItems: 'center',
    backgroundColor: '#000',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 1,
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
  reticle: {
    alignItems: 'center',
    height: 34,
    justifyContent: 'center',
    left: '50%',
    marginLeft: -17,
    marginTop: -17,
    position: 'absolute',
    top: '50%',
    width: 34,
  },
  reticleHorizontal: {
    backgroundColor: 'rgba(248, 250, 252, 0.82)',
    height: 1,
    position: 'absolute',
    width: 34,
  },
  reticleVertical: {
    backgroundColor: 'rgba(248, 250, 252, 0.82)',
    height: 34,
    position: 'absolute',
    width: 1,
  },
  stageReadout: {
    backgroundColor: 'rgba(5, 7, 18, 0.72)',
    borderColor: 'rgba(148, 163, 184, 0.2)',
    borderRadius: 8,
    borderWidth: 1,
    left: 10,
    paddingHorizontal: 9,
    paddingVertical: 7,
    position: 'absolute',
    top: 10,
  },
  stageReadoutLabel: {
    color: '#8ca0bb',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '800',
  },
  stageReadoutValue: {
    color: '#f8fafc',
    fontFamily: 'Menlo',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 1,
  },
  stageModePill: {
    alignItems: 'flex-end',
    backgroundColor: 'rgba(5, 7, 18, 0.68)',
    borderColor: 'rgba(45, 212, 191, 0.24)',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 7,
    position: 'absolute',
    right: 10,
    top: 10,
  },
  stageModeLabel: {
    color: '#7dd3fc',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '800',
  },
  stageModeValue: {
    color: '#fef3c7',
    fontFamily: 'Menlo',
    fontSize: 15,
    fontWeight: '800',
    marginTop: 1,
  },
  fusionLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 10,
    position: 'absolute',
    right: 10,
    top: 54,
  },
  fusionLabel: {
    backgroundColor: 'rgba(5, 7, 18, 0.66)',
    borderColor: 'rgba(148, 163, 184, 0.22)',
    borderRadius: 8,
    borderWidth: 1,
    color: '#e2e8f0',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 5,
  },
  maskReadout: {
    backgroundColor: 'rgba(5, 7, 18, 0.7)',
    borderColor: 'rgba(251, 191, 36, 0.26)',
    borderRadius: 8,
    borderWidth: 1,
    bottom: 10,
    left: 10,
    paddingHorizontal: 9,
    paddingVertical: 7,
    position: 'absolute',
    right: 10,
  },
  maskReadoutHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  maskReadoutLabel: {
    color: '#fcd34d',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '800',
  },
  maskReadoutValue: {
    color: '#f8fafc',
    fontFamily: 'Menlo',
    fontSize: 13,
    fontWeight: '800',
  },
  maskBarTrack: {
    backgroundColor: 'rgba(148, 163, 184, 0.24)',
    borderRadius: 999,
    height: 5,
    marginTop: 6,
    overflow: 'hidden',
  },
  maskBarFill: {
    backgroundColor: '#fbbf24',
    borderRadius: 999,
    height: 5,
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
  },
  error: {
    color: '#fca5a5',
    fontFamily: 'Menlo',
    fontSize: 11,
  },
  buttonRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 8,
  },
  depthControl: {
    gap: 7,
    paddingTop: 6,
  },
  depthControlLabel: {
    color: '#9fb0c8',
    fontSize: 12,
    fontWeight: '700',
  },
  pickerHost: {
    alignSelf: 'stretch',
    height: 34,
  },
});
