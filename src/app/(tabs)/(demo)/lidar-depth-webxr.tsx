import * as Device from 'expo-device';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Animated, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Canvas, useCanvasRef, useDevice } from 'react-native-wgpu';
import type { NativeStackHeaderItem } from 'expo-router/build/react-navigation/native-stack';
import type { SFSymbol } from 'sf-symbols-typescript';

import { Host, Picker, SymbolView, Text as UIText, pickerStyle, tag } from '@/components/demo-platform-controls';
import { DemoPageFrame } from '@/components/demo-page-frame';
import { useCamera } from '@/contexts/CameraContext';
import { configureWebGpuCanvas } from '@/lib/webgpu-canvas';
import { createWebGpuPerfProbe, nowMs as perfNowMs } from '@/lib/webgpu-perf';
import {
  installWebXRDepthProfile,
  runWithWebXRUserActivation,
  WebXRCPUCameraBinding,
  type WebXRCPUDepthInformation,
  type WebXRCPUCameraImage,
  type WebXRFrame,
  type WebXRSession,
} from '../../../../modules/standard-camera';

// @ref LLP 0013#application-shape - This route is the WebXR-shaped variant of
// the LiDAR demo: app code talks to `navigator.xr`, receives XR frames, and
// uploads CPU-visible camera/depth buffers into WebGPU.

const FULLSCREEN_VERTEX_COUNT = 6;
const DEFAULT_OCCLUSION_DEPTH_M = 1.25;
const MIN_OCCLUSION_DEPTH_M = 0.45;
const MAX_OCCLUSION_DEPTH_M = 3.5;
const OCCLUSION_DEPTHS_M = [0.8, 1.25, 2.0];
const COMPARE_DEPTH_SPLIT = 0.5;
const VIEW_MODES = [
  { label: 'Compare', value: 2 },
  { label: 'Boundary', value: 3 },
  { label: 'Depth', value: 1 },
  { label: 'Camera', value: 0 },
] as const;

const WEBXR_DEPTH_SHADER = /* wgsl */ `
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

fn clearDepthPalette(depth01: f32) -> vec3f {
  let near = vec3f(0.95, 0.12, 0.08);
  let mid = vec3f(0.02, 0.88, 0.74);
  let far = vec3f(0.03, 0.08, 0.56);
  let shaped = pow(clamp(depth01, 0.0, 1.0), 0.72);
  let a = smoothstep(0.0, 0.54, shaped);
  let b = smoothstep(0.44, 1.0, shaped);
  var color = mix(mix(near, mid, a), far, b);
  return mix(vec3f(0.5), color, 1.28);
}

fn depthJump(depth: f32, depthUv: vec2f) -> f32 {
  let texelStep = 1.0 / vec2f(max(u.depthWidth, 1.0), max(u.depthHeight, 1.0));
  let dL = sampleDepth(clamp(depthUv + vec2f(-texelStep.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let dR = sampleDepth(clamp(depthUv + vec2f( texelStep.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let dU = sampleDepth(clamp(depthUv + vec2f(0.0, -texelStep.y), vec2f(0.0), vec2f(1.0)));
  let dD = sampleDepth(clamp(depthUv + vec2f(0.0,  texelStep.y), vec2f(0.0), vec2f(1.0)));
  let axisJump = max(max(abs(depth - dL), abs(depth - dR)), max(abs(depth - dU), abs(depth - dD)));
  let dNW = sampleDepth(clamp(depthUv + vec2f(-texelStep.x, -texelStep.y), vec2f(0.0), vec2f(1.0)));
  let dNE = sampleDepth(clamp(depthUv + vec2f( texelStep.x, -texelStep.y), vec2f(0.0), vec2f(1.0)));
  let dSW = sampleDepth(clamp(depthUv + vec2f(-texelStep.x,  texelStep.y), vec2f(0.0), vec2f(1.0)));
  let dSE = sampleDepth(clamp(depthUv + vec2f( texelStep.x,  texelStep.y), vec2f(0.0), vec2f(1.0)));
  let diagonalJump = max(max(abs(depth - dNW), abs(depth - dNE)), max(abs(depth - dSW), abs(depth - dSE)));
  return max(axisJump, diagonalJump * 0.88);
}

fn foregroundDepth(depth: f32) -> f32 {
  return 1.0 - smoothstep(u.targetDepth - 0.22, u.targetDepth - 0.035, depth);
}

fn depthDiscontinuity(depth: f32, depthUv: vec2f) -> f32 {
  let edge = smoothstep(0.045, 0.14, depthJump(depth, depthUv));
  return edge * edge;
}

fn distanceMarker(depth: f32, interval: f32, coreWidth: f32, falloffWidth: f32) -> vec2f {
  let distanceToMarker = abs(fract(depth / interval + 0.5) - 0.5) * interval;
  let core = 1.0 - smoothstep(0.0, coreWidth, distanceToMarker);
  let halo = 1.0 - smoothstep(coreWidth, falloffWidth, distanceToMarker);
  return vec2f(core, halo);
}

fn distanceMarkers(depth: f32) -> vec4f {
  let quarterMeter = distanceMarker(depth, 0.25, 0.003, 0.012);
  let meter = distanceMarker(depth, 1.0, 0.005, 0.022);
  let minorCore = max(quarterMeter.x - meter.y, 0.0);
  let minorHalo = max(quarterMeter.y - meter.y * 0.82, 0.0);
  return vec4f(minorCore, minorHalo, meter.x, meter.y);
}

fn foregroundRimFromEdge(depth: f32, edge: f32) -> f32 {
  let fg = foregroundDepth(depth);
  let foregroundEdge = edge * smoothstep(0.42, 0.88, fg);
  let thinFill = fg * 0.006;
  return max(foregroundEdge, thinFill);
}

fn foregroundRim(depth: f32, depthUv: vec2f) -> f32 {
  return foregroundRimFromEdge(depth, depthDiscontinuity(depth, depthUv));
}

fn targetLine(depth: f32) -> vec2f {
  let distanceToTarget = abs(depth - u.targetDepth);
  let core = 1.0 - smoothstep(0.004, 0.02, distanceToTarget);
  let halo = 1.0 - smoothstep(0.026, 0.085, distanceToTarget);
  return vec2f(core, halo);
}

fn boundaryOutline(depth: f32, depthUv: vec2f) -> vec2f {
  let edge = depthDiscontinuity(depth, depthUv);
  let rim = foregroundRimFromEdge(depth, edge);
  return vec2f(edge, rim);
}

fn depthMapView(depth: f32, depthUv: vec2f, markerStrength: f32) -> vec3f {
  let boundaryMask = boundaryOutline(depth, depthUv);
  let targetMask = targetLine(depth);
  let markers = distanceMarkers(depth);
  let nearDepth = max(u.minDepth, 0.05);
  let farDepth = max(max(u.maxDepth, u.targetDepth + 0.75), nearDepth + 0.65);
  let depth01 = clamp((depth - nearDepth) / (farDepth - nearDepth), 0.0, 1.0);
  let texelStep = 1.0 / vec2f(max(u.depthWidth, 1.0), max(u.depthHeight, 1.0));
  let dL = sampleDepth(clamp(depthUv + vec2f(-texelStep.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let dR = sampleDepth(clamp(depthUv + vec2f( texelStep.x, 0.0), vec2f(0.0), vec2f(1.0)));
  let dU = sampleDepth(clamp(depthUv + vec2f(0.0, -texelStep.y), vec2f(0.0), vec2f(1.0)));
  let dD = sampleDepth(clamp(depthUv + vec2f(0.0,  texelStep.y), vec2f(0.0), vec2f(1.0)));
  let normal = normalize(vec3f((dL - dR) * 7.0, (dU - dD) * 7.0, 1.0));
  let light = clamp(dot(normal, normalize(vec3f(-0.42, -0.58, 1.0))), 0.0, 1.0);

  var color = clearDepthPalette(depth01) * (0.44 + light * 0.72);
  let markerShadow = clamp((markers.y * 0.28 + markers.w * 0.54) * markerStrength, 0.0, 1.0);
  let minorLine = clamp((markers.x * 0.62 + markers.y * 0.16) * markerStrength, 0.0, 1.0);
  let majorLine = clamp((markers.z * 0.92 + markers.w * 0.32) * markerStrength, 0.0, 1.0);
  color = mix(color, color * 0.22, markerShadow);
  color = mix(color, vec3f(0.92, 1.0, 0.98), minorLine);
  color = mix(color, vec3f(1.0, 0.82, 0.10), majorLine);
  color = mix(color, color * 0.48, boundaryMask.x * 0.12 * markerStrength);
  color = mix(color, vec3f(1.0, 0.82, 0.10), boundaryMask.y * 0.42 * markerStrength);
  color = mix(color, vec3f(0.02, 0.20, 0.18), targetMask.y * 0.24);
  color = mix(color, vec3f(0.82, 1.0, 0.92), targetMask.x * 0.84);
  return color;
}

fn boundaryView(camera: vec3f, depth: f32, depthUv: vec2f) -> vec3f {
  let boundaryMask = boundaryOutline(depth, depthUv);
  let targetMask = targetLine(depth);
  let closer = foregroundDepth(depth);
  let objectMask = smoothstep(0.18, 0.82, closer);
  let depthColor = depthMapView(depth, depthUv, 0.82);
  let objectColor = mix(camera, depthColor, 0.15);
  var color = mix(depthColor, objectColor, objectMask);

  color = mix(color, color * 0.48, boundaryMask.x * 0.16);
  color = mix(color, vec3f(1.0, 0.82, 0.10), boundaryMask.y * 0.50);
  color = mix(color, vec3f(0.02, 0.18, 0.16), targetMask.y * 0.24);
  color += targetMask.y * vec3f(0.02, 0.28, 0.23);
  color = mix(color, vec3f(0.84, 1.0, 0.92), targetMask.x * 0.82);
  return color;
}

fn depthView(depth: f32, depthUv: vec2f) -> vec3f {
  return depthMapView(depth, depthUv, 1.0);
}

fn compareView(screenUv: vec2f, camera: vec3f, depth: f32, depthUv: vec2f) -> vec3f {
  let cameraSide = camera;
  let depthSide = depthMapView(depth, depthUv, 0.92);

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

  var color = camera;
  if (u.mode > 2.5) {
    color = boundaryView(camera, depth, depthUv);
  } else if (u.mode > 1.5) {
    color = compareView(in.uv, camera, depth, depthUv);
  } else if (u.mode > 0.5) {
    color = depthView(depth, depthUv);
  }

  let vignette = smoothstep(1.28, 0.28, length((in.uv - 0.5) * vec2f(u.canvasAspect, 1.0)));
  color *= 0.72 + vignette * 0.38;
  return vec4f(color, 1.0);
}
`;

export default function WebXRLiDARDepthScreen(): React.JSX.Element {
  const ref = useCanvasRef();
  const { adapter, device } = useDevice();
  const { lidarStatus, lidarError } = useCamera();
  const { autorun } = useLocalSearchParams<{ autorun?: string }>();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const sessionRef = React.useRef<WebXRSession | null>(null);
  const didAutorunRef = React.useRef(false);
  const [session, setSession] = React.useState<WebXRSession | null>(null);
  const [status, setStatus] = React.useState('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [support, setSupport] = React.useState('checking WebXR depth support');
  const [frameInfo, setFrameInfo] = React.useState('waiting for XR frame');
  const [cameraInfo, setCameraInfo] = React.useState('waiting for camera');
  const [centerDepth, setCenterDepth] = React.useState('pending');
  const [depthRange, setDepthRange] = React.useState('range pending');
  const [fps, setFps] = React.useState('0.0');
  const [foregroundPercent, setForegroundPercent] = React.useState(0);
  const [maskInfo, setMaskInfo] = React.useState('mask pending');
  const [targetDepth, setTargetDepth] = React.useState(DEFAULT_OCCLUSION_DEPTH_M);
  const [lastCenterDepthMeters, setLastCenterDepthMeters] = React.useState<number | null>(null);
  const [viewMode, setViewMode] = React.useState(2);
  const lastCenterDepthRef = React.useRef<number | null>(null);
  const reticlePressProgress = React.useMemo(() => new Animated.Value(0), []);
  const targetDepthRef = React.useRef(targetDepth);
  const viewModeRef = React.useRef(viewMode);

  const isDesktop = windowWidth >= 1040;
  const isWebDesktop = Platform.OS === 'web' && isDesktop;
  const stageWidth = isDesktop
    ? Math.max(
        360,
        Math.min(
          isWebDesktop ? windowWidth - 456 : windowWidth - 64,
          960,
          Math.max(360, windowHeight - (isWebDesktop ? 180 : 260)) * 4 / 3
        )
      )
    : Math.min(Math.max(288, windowWidth - 32), 420);
  const stageHeight = Math.round(isDesktop ? stageWidth * 3 / 4 : stageWidth * 4 / 3);

  const resetXRReadouts = React.useCallback((nextStatus: string): void => {
    setStatus(nextStatus);
    setFrameInfo('waiting for XR frame');
    setDepthRange('range pending');
    setCenterDepth('pending');
    setFps('0.0');
    setForegroundPercent(0);
    setMaskInfo('mask pending');
    setCameraInfo('waiting for camera');
    setLastCenterDepthMeters(null);
    lastCenterDepthRef.current = null;
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- Preserve the current unsupported-state initialization timing. */
  React.useEffect(() => {
    installWebXRDepthProfile();
    const xr = navigator.xr;
    if (!xr) {
      setSupport('WebXR LiDAR depth unsupported here');
      resetXRReadouts('unsupported');
      return;
    }
    void xr.isSessionSupported('immersive-ar').then((supported) => {
      setSupport(supported ? 'immersive-ar + depth-sensing available' : 'WebXR LiDAR depth unsupported here');
    });
  }, [resetXRReadouts]);
  /* eslint-enable react-hooks/set-state-in-effect */

  React.useEffect(() => {
    targetDepthRef.current = targetDepth;
  }, [targetDepth]);

  React.useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  React.useEffect(() => {
    return () => {
      void sessionRef.current?.end();
      sessionRef.current = null;
    };
  }, []);

  const startSession = React.useCallback(async (): Promise<void> => {
    if (sessionRef.current) return;
    installWebXRDepthProfile();
    setError(null);
    setStatus('requesting XR session');
    try {
      const xr = navigator.xr;
      if (!xr) {
        setSupport('WebXR LiDAR depth unsupported here');
        resetXRReadouts('unsupported');
        return;
      }
      const supported = await xr.isSessionSupported('immersive-ar');
      if (!supported) {
        setSupport('WebXR LiDAR depth unsupported here');
        resetXRReadouts('unsupported');
        return;
      }
      const nextSession = await runWithWebXRUserActivation(() =>
        xr.requestSession('immersive-ar', {
          requiredFeatures: ['depth-sensing', 'camera-access'],
          depthSensing: {
            usagePreference: ['cpu-optimized'],
            dataFormatPreference: ['float32'],
            depthTypeRequest: ['raw', 'smooth'],
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
      setStatus(`XRSession running (${nextSession.depthType ?? 'no depth'})`);
      nextSession.addEventListener('end', () => {
        if (sessionRef.current === nextSession) {
          sessionRef.current = null;
          setSession(null);
          setError(null);
          resetXRReadouts('ended');
        }
      });
    } catch (e) {
      sessionRef.current = null;
      setSession(null);
      setStatus('error');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }, [resetXRReadouts]);

  const stopSession = React.useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (!current) return;
    setStatus('ending');
    try {
      await current.end();
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }, []);

  React.useEffect(() => {
    if (autorun !== '1' || didAutorunRef.current) return;
    didAutorunRef.current = true;
    void startSession();
  }, [autorun, startSession]);

  useFocusEffect(
    React.useCallback(() => {
      return () => {
        void sessionRef.current?.end();
      };
    }, [])
  );

  React.useEffect(() => {
    if (!device || !session) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    let xrRafId: number | null = null;

    const setup = async (): Promise<void> => {
      try {
        const referenceSpace = await session.requestReferenceSpace('viewer');
        if (cancelled) return;
        const cameraBinding = new WebXRCPUCameraBinding(session);
        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        const { context } = configureWebGpuCanvas(ref, device, presentationFormat);
        const profile = createWebGpuPerfProbe('lidar-depth-webxr', {
          cameraFormat: session.cameraFormat,
          depthType: session.depthType ?? 'none',
        });

        const shaderModule = device.createShaderModule({ code: WEBXR_DEPTH_SHADER });
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
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          ],
        });
        const pipeline = device.createRenderPipeline({
          layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
          vertex: { module: shaderModule, entryPoint: 'vs_main' },
          fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: presentationFormat }] },
          primitive: { topology: 'triangle-list' },
        });
        const uniformBuffer = device.createBuffer({
          size: 48,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const cameraSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

        let depthTexture: GPUTexture | null = null;
        let cameraTexture: GPUTexture | null = null;
        let bindGroup: GPUBindGroup | null = null;
        let depthWidth = 0;
        let depthHeight = 0;
        let cameraWidth = 0;
        let cameraHeight = 0;
        let cameraFormat: GPUTextureFormat = 'bgra8unorm';
        let minDepth = MIN_OCCLUSION_DEPTH_M;
        let maxDepth = MAX_OCCLUSION_DEPTH_M;
        let frameNumber = 0;
        let frames = 0;
        let lastFrameOutcome = 'waiting';
        let lastFpsReport = Date.now();
        let lastFrameErrorReport = 0;
        let lastStatsReport = Date.now();
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

        const ensureCameraTexture = (width: number, height: number, format: GPUTextureFormat): void => {
          if (cameraTexture && width === cameraWidth && height === cameraHeight && format === cameraFormat) return;
          cameraTexture?.destroy();
          cameraTexture = device.createTexture({
            size: { width, height },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          });
          cameraWidth = width;
          cameraHeight = height;
          cameraFormat = format;
          rebuildBindGroup();
        };

        ensureDepthTexture(1, 1);
        device.queue.writeTexture(
          { texture: depthTexture! },
          new Uint8Array(new Float32Array([DEFAULT_OCCLUSION_DEPTH_M]).buffer),
          { bytesPerRow: 256, rowsPerImage: 1 },
          { width: 1, height: 1 }
        );
        ensureCameraTexture(1, 1, 'bgra8unorm');
        device.queue.writeTexture(
          { texture: cameraTexture! },
          new Uint8Array([18, 10, 8, 255]),
          { bytesPerRow: 256, rowsPerImage: 1 },
          { width: 1, height: 1 }
        );

        const uploadDepth = (depth: WebXRCPUDepthInformation): DepthUploadStats => {
          ensureDepthTexture(depth.width, depth.height);
          const bytes = profile.time('readDepthData', () => new Uint8Array(depth.data));
          const upload = profile.time('makeDepthUpload', () =>
            makePaddedUpload(depth.width * 4, depth.height, bytes)
          );
          profile.count('depthUploadedBytes', upload.data.byteLength);
          profile.time('writeDepthTexture', () =>
            device.queue.writeTexture(
              { texture: depthTexture! },
              upload.data,
              { bytesPerRow: upload.bytesPerRow, rowsPerImage: depth.height },
              { width: depth.width, height: depth.height }
            )
          );
          const stats = sampleDepthStats(depth.width, depth.height, bytes, targetDepthRef.current);
          return {
            center: depth.getDepthInMeters(0.5, 0.5),
            ...stats,
          };
        };

        const uploadCamera = (camera: WebXRCPUCameraImage): void => {
          ensureCameraTexture(camera.width, camera.height, camera.format);
          const bytes = profile.time('readCameraData', () => new Uint8Array(camera.data));
          const upload = profile.time('makeCameraUpload', () =>
            makePaddedUpload(camera.width * 4, camera.height, bytes)
          );
          profile.count('cameraUploadedBytes', upload.data.byteLength);
          profile.time('writeCameraTexture', () =>
            device.queue.writeTexture(
              { texture: cameraTexture! },
              upload.data,
              { bytesPerRow: upload.bytesPerRow, rowsPerImage: camera.height },
              { width: camera.width, height: camera.height }
            )
          );
        };

        const reportFrameError = (e: unknown): void => {
          const errorName = e instanceof Error ? e.name : 'Error';
          const errorMessage = e instanceof Error ? e.message : String(e);
          profile.count('frameErrors');
          setError(`WebXR frame error: ${errorName}: ${errorMessage}`);
          const now = Date.now();
          if (now - lastFrameErrorReport < 1000) return;
          lastFrameErrorReport = now;
          console.log('WEBXR_DEMO_FRAME_ERROR', JSON.stringify({
            cameraHeight,
            cameraWidth,
            demo: 'lidar-depth-webxr',
            depthHeight,
            depthWidth,
            errorMessage,
            errorName,
            frameNumber,
          }));
          profile.report({
            cameraFormat,
            cameraHeight,
            cameraWidth,
            depthHeight,
            depthWidth,
            frameErrorName: errorName,
            frameNumber,
            lastFrameOutcome,
          }, true);
        };

        const reportFrameProfile = (extra: Record<string, boolean | number | string | null | undefined> = {}): void => {
          profile.report({
            cameraFormat,
            cameraHeight,
            cameraWidth,
            depthHeight,
            depthWidth,
            frameNumber,
            lastFrameOutcome,
            sessionEnded: session.ended,
            ...extra,
          });
        };

        const reportFrameMiss = (outcome: 'camera-miss' | 'depth-miss' | 'pose-miss'): void => {
          lastFrameOutcome = outcome;
          profile.count(outcome === 'camera-miss' ? 'cameraMisses' : outcome === 'depth-miss' ? 'depthMisses' : 'poseMisses');
          const now = Date.now();
          if (now - lastStatsReport >= 500) {
            if (outcome === 'pose-miss') {
              setFrameInfo(`pose missing after ${frameNumber} XR frames`);
            } else if (outcome === 'depth-miss') {
              setFrameInfo(`depth missing after ${frameNumber} XR frames`);
            } else {
              setCameraInfo(`camera missing after ${frameNumber} XR frames`);
            }
            setStatus(`waiting - ${outcome}`);
            lastStatsReport = now;
          }
          reportFrameProfile();
        };

        const renderFrame = (_time: DOMHighResTimeStamp, frame: WebXRFrame): void => {
          if (cancelled) return;
          try {
            profile.count('xrCallbacks');
            const pose = frame.getViewerPose(referenceSpace);
            const view = pose?.views[0];
            if (!view) {
              reportFrameMiss('pose-miss');
              return;
            }

            // @ref LLP 0013#xr-depth-information
            // @ref LLP 0016#depth-interpretation
            const depth = frame.getDepthInformation(view);
            // @ref LLP 0013#xr-camera-image
            // @ref LLP 0017#xr-webgl-get-camera-image — Use the repo-local CPU
            // binding analog because this demo uploads camera bytes to WebGPU.
            const xrCamera = view.camera;
            const camera = xrCamera ? cameraBinding.getCameraImage(xrCamera) : null;

            if (!depth) {
              reportFrameMiss('depth-miss');
            } else if (!camera) {
              reportFrameMiss('camera-miss');
            } else {
              const depthStats = uploadDepth(depth);
              uploadCamera(camera);
              profile.count('xrFrames');
              frameNumber += 1;
              lastFrameOutcome = 'uploaded';
              minDepth = depthStats.min;
              maxDepth = depthStats.max;
              const statsNow = Date.now();
              if (statsNow - lastStatsReport >= 500) {
                setFrameInfo(`${depth.width}x${depth.height} XR #${frameNumber}`);
                setCameraInfo(`${camera.width}x${camera.height} ${camera.format}`);
                if (depthStats.center > 0) {
                  lastCenterDepthRef.current = depthStats.center;
                  setLastCenterDepthMeters(depthStats.center);
                  setCenterDepth(`${depthStats.center.toFixed(2)}m`);
                } else {
                  lastCenterDepthRef.current = null;
                  setLastCenterDepthMeters(null);
                  setCenterDepth('no return');
                }
                setDepthRange(
                  `${minDepth.toFixed(2)}m-${maxDepth.toFixed(2)}m mean ${depthStats.mean.toFixed(2)}m`
                );
                setForegroundPercent(Math.round(depthStats.foregroundRatio * 100));
                setMaskInfo(
                  `${formatPercent(depthStats.foregroundRatio)} closer / ${formatPercent(depthStats.targetRatio)} at target`
                );
                setStatus(`live - ${adapter?.info?.vendor ?? 'unknown adapter'}`);
                lastStatsReport = statsNow;
              }
            }

            const elapsed = (Date.now() - startedAt) / 1000;
            device.queue.writeBuffer(
              uniformBuffer,
              0,
              new Float32Array([
                depthWidth,
                depthHeight,
                cameraWidth,
                cameraHeight,
                minDepth,
                maxDepth,
                elapsed,
                stageWidth / stageHeight,
                frameNumber,
                targetDepthRef.current,
                !isDesktop && (cameraWidth > 1 ? cameraWidth > cameraHeight : depthWidth > depthHeight) ? 1 : 0,
                viewModeRef.current,
              ])
            );

            const renderStart = perfNowMs();
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
            profile.duration('renderSubmitPresent', perfNowMs() - renderStart);

            frames += 1;
            profile.count('renderFrames');
            const fpsNow = Date.now();
            if (fpsNow - lastFpsReport >= 1000) {
              const fpsValue = frames / ((fpsNow - lastFpsReport) / 1000);
              setFps(fpsValue.toFixed(1));
              reportFrameProfile({ fps: Number(fpsValue.toFixed(1)) });
              frames = 0;
              lastFpsReport = fpsNow;
            }
          } catch (e) {
            reportFrameError(e);
          } finally {
            if (!cancelled && !session.ended) {
              xrRafId = session.requestAnimationFrame(renderFrame);
            }
          }
        };

        xrRafId = session.requestAnimationFrame(renderFrame);
        cleanup = (): void => {
          if (xrRafId !== null) {
            session.cancelAnimationFrame(xrRafId);
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

    void setup();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the existing XR render-loop lifetime.
  }, [adapter, device, ref, session, stageHeight, stageWidth]);

  const running = session !== null;
  const xrLive = running && status.startsWith('live');
  const transitioning = status === 'requesting XR session' || status === 'ending';
  const unsupported = status === 'unsupported' || support === 'WebXR LiDAR depth unsupported here';

  // @ref LLP 0013#xr-request-session - WebXR session start must come from an
  // explicit user tap. Use the patched native-stack header item here too so
  // this route starts from the same place as the custom LiDAR demo.
  const xrHeaderRightItems = React.useCallback(
    (): NativeStackHeaderItem[] => {
      const iconName: SFSymbol = running ? 'stop.fill' : 'play.fill';
      const label = running ? 'Stop WebXR' : 'Start WebXR';
      return [
        {
          type: 'button' as const,
          label,
          accessibilityLabel: label,
          disabled: transitioning || (!running && unsupported),
          icon: {
            type: 'sfSymbol' as const,
            name: iconName,
          },
          identifier: 'webxr-lidar-start-stop',
          onPress: running ? () => void stopSession() : () => void startSession(),
          tintColor: running ? '#ff453a' : '#f8fafc',
          variant: 'plain' as const,
        },
      ];
    },
    [running, startSession, stopSession, transitioning, unsupported]
  );

  const displayStatus = (() => {
    if (status === 'error') return 'error';
    if (status === 'requesting XR session') return 'starting WebXR';
    if (status === 'ending') return 'stopping WebXR';
    if (xrLive) return status;
    if (running) return status;
    return status;
  })();
  const displayError = error ?? lidarError;
  const badgeState = (() => {
    if (status === 'error' || lidarStatus === 'error') {
      return { label: 'XR error', style: styles.badgeWarn };
    }
    if (unsupported) {
      return { label: 'XR unsupported', style: styles.badgeWarn };
    }
    if (xrLive) {
      return { label: 'XR live', style: styles.badgeLive };
    }
    if (status === 'requesting XR session') {
      return { label: 'XR starting', style: styles.badgeWarn };
    }
    if (status === 'ending') {
      return { label: 'XR stopping', style: styles.badgeWarn };
    }
    if (support === 'immersive-ar + depth-sensing available') {
      return { label: 'XR ready', style: styles.badgeWarn };
    }
    return { label: 'XR', style: styles.badgeWarn };
  })();
  const canSetCenterTarget = lastCenterDepthMeters !== null && xrLive;
  const setCenterTarget = (): void => {
    const center = lastCenterDepthRef.current;
    if (!center || !Number.isFinite(center)) return;
    setTargetDepth(clampDepth(center));
  };
  const animateReticlePress = React.useCallback(
    (toValue: number): void => {
      Animated.spring(reticlePressProgress, {
        damping: 18,
        mass: 0.6,
        stiffness: 220,
        toValue,
        useNativeDriver: true,
      }).start();
    },
    [reticlePressProgress]
  );
  const reticleAnimatedStyle = {
    opacity: reticlePressProgress.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 0.78],
    }),
    transform: [
      {
        scale: reticlePressProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 0.9],
        }),
      },
    ],
  };
  const planeSelection = OCCLUSION_DEPTHS_M.find((depth) => Math.abs(targetDepth - depth) < 0.01);
  const showStoppedPlaceholder = Device.isDevice && !xrLive;

  return (
    <>
      <Stack.Screen options={{ unstable_headerRightItems: xrHeaderRightItems }} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic">
        <DemoPageFrame
          action={{
            disabled: transitioning || (!running && unsupported),
            label: running ? 'Stop WebXR' : 'Start WebXR',
            onPress: running ? () => void stopSession() : () => void startSession(),
            running,
            testID: 'webxr-lidar-start-stop',
          }}
          preview={
            <View style={[styles.stage, { height: stageHeight, width: stageWidth }]}>
              <Canvas ref={ref} style={styles.canvas} />
              <Pressable
                accessibilityLabel="Set target to center depth"
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSetCenterTarget }}
                disabled={!canSetCenterTarget}
                hitSlop={18}
                onPressIn={() => animateReticlePress(1)}
                onPressOut={() => animateReticlePress(0)}
                onPress={setCenterTarget}
                style={styles.reticleHitTarget}>
                <Animated.View pointerEvents="none" style={[styles.reticle, reticleAnimatedStyle]}>
                  <View style={styles.reticleHorizontal} />
                  <View style={styles.reticleVertical} />
                </Animated.View>
              </Pressable>
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
                  <View
                    style={[styles.maskBarFill, { width: `${Math.min(100, foregroundPercent)}%` }]}
                  />
                </View>
              </View>
            </View>
          }
          controls={
            <>
              <View style={[styles.quickControls, { width: isWebDesktop ? '100%' : stageWidth }]}>
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
              </View>

              <View style={styles.controls}>
                <View style={styles.titleBlock}>
                  <Text style={styles.title}>WebXR LiDAR Depth Studio</Text>
                  <Text style={styles.subtitle}>
                    navigator.xr camera and scene depth rendered through WebGPU
                  </Text>
                </View>

                <View style={styles.statusRow}>
                  <Text style={[styles.badge, badgeState.style]}>{badgeState.label}</Text>
                  <Text style={styles.statusText}>{displayStatus}</Text>
                </View>

                <Text style={styles.metric}>{support}</Text>
                <Text style={styles.metric}>camera: {cameraInfo}</Text>
                <Text style={styles.metric}>depth: {frameInfo}</Text>
                <Text style={styles.metric}>center: {centerDepth}</Text>
                <Text style={styles.metric}>target: {maskInfo}</Text>
                <Text style={styles.metric}>range: {depthRange}</Text>
                <Text style={styles.metric}>webgpu: {fps} fps</Text>
                {displayError ? <Text style={styles.error}>{displayError}</Text> : null}
              </View>
            </>
          }
        />
      </ScrollView>
    </>
  );
}

interface DepthUploadStats {
  center: number;
  foregroundRatio: number;
  min: number;
  max: number;
  mean: number;
  targetRatio: number;
}

function makePaddedUpload(
  srcRowBytes: number,
  height: number,
  data: Uint8Array
): { bytesPerRow: number; data: Uint8Array } {
  const bytesPerRow = Math.ceil(srcRowBytes / 256) * 256;
  if (bytesPerRow === srcRowBytes) {
    return { bytesPerRow, data };
  }
  const padded = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    padded.set(data.subarray(y * srcRowBytes, (y + 1) * srcRowBytes), y * bytesPerRow);
  }
  return { bytesPerRow, data: padded };
}

function sampleDepthStats(
  width: number,
  height: number,
  data: Uint8Array,
  targetDepth: number
): Omit<DepthUploadStats, 'center'> {
  const values = new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4));
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let sum = 0;
  let foreground = 0;
  let targetPlane = 0;
  let valid = 0;
  const step = Math.max(1, Math.floor((width * height) / 4096));
  for (let i = 0; i < values.length; i += step) {
    const depth = values[i] ?? 0;
    if (!Number.isFinite(depth) || depth <= 0) continue;
    valid += 1;
    sum += depth;
    min = Math.min(min, depth);
    max = Math.max(max, depth);
    if (depth < targetDepth - 0.035) foreground += 1;
    if (Math.abs(depth - targetDepth) <= 0.12) targetPlane += 1;
  }
  if (!Number.isFinite(min)) {
    return {
      foregroundRatio: 0,
      max: MAX_OCCLUSION_DEPTH_M,
      mean: DEFAULT_OCCLUSION_DEPTH_M,
      min: MIN_OCCLUSION_DEPTH_M,
      targetRatio: 0,
    };
  }
  return {
    foregroundRatio: valid > 0 ? foreground / valid : 0,
    max: Math.max(max, min + 0.25),
    mean: valid > 0 ? sum / valid : DEFAULT_OCCLUSION_DEPTH_M,
    min,
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
  quickControls: {
    gap: 8,
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
  reticleHitTarget: {
    alignItems: 'center',
    height: 52,
    justifyContent: 'center',
    left: '50%',
    marginLeft: -26,
    marginTop: -26,
    position: 'absolute',
    top: '50%',
    width: 52,
  },
  reticle: {
    alignItems: 'center',
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  reticleHorizontal: {
    backgroundColor: 'rgba(248, 250, 252, 0.82)',
    borderRadius: 1,
    height: 2,
    position: 'absolute',
    width: 36,
  },
  reticleVertical: {
    backgroundColor: 'rgba(248, 250, 252, 0.82)',
    borderRadius: 1,
    height: 36,
    position: 'absolute',
    width: 2,
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
