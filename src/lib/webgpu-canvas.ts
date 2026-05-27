import { PixelRatio } from 'react-native';
import type { RefObject } from 'react';
import type { CanvasRef, NativeCanvas, RNCanvasContext } from 'react-native-wgpu';

interface WebGpuCanvasElement {
  clientHeight: number;
  clientWidth: number;
  height: number;
  width: number;
}

interface RNWebGPUGlobal {
  MakeWebGPUCanvasContext?: (contextId: number, width: number, height: number) => RNCanvasContext;
}

export interface ConfiguredWebGpuCanvas {
  context: RNCanvasContext;
  height: number;
  pixelRatio: number;
  width: number;
}

export function configureWebGpuCanvas(
  canvasRef: RefObject<CanvasRef | null>,
  device: GPUDevice,
  format: GPUTextureFormat,
  options?: Omit<GPUCanvasConfiguration, 'device' | 'format'>
): ConfiguredWebGpuCanvas {
  const nativeSurface = canvasRef.current?.getNativeSurface?.();
  const context = getWebGpuContext(canvasRef, nativeSurface);
  if (!context) {
    throw new Error('getContext("webgpu") returned null');
  }

  const canvas = context.canvas as Partial<WebGpuCanvasElement>;
  const pixelRatio = PixelRatio.get();
  const clientWidth = positiveNumber(canvas.clientWidth) ??
    positiveNumber(nativeSurface?.clientWidth) ??
    positiveNumber(canvas.width) ??
    positiveNumber(nativeSurface?.width) ??
    1;
  const clientHeight = positiveNumber(canvas.clientHeight) ??
    positiveNumber(nativeSurface?.clientHeight) ??
    positiveNumber(canvas.height) ??
    positiveNumber(nativeSurface?.height) ??
    1;
  const width = Math.max(1, Math.round(clientWidth * pixelRatio));
  const height = Math.max(1, Math.round(clientHeight * pixelRatio));
  canvas.width = width;
  canvas.height = height;

  context.configure({
    alphaMode: 'opaque',
    ...options,
    device,
    format,
  });

  return { context, height, pixelRatio, width };
}

function getWebGpuContext(
  canvasRef: RefObject<CanvasRef | null>,
  nativeSurface: NativeCanvas | undefined
): RNCanvasContext | null {
  try {
    return canvasRef.current?.getContext('webgpu') ?? null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/not a function|boundingClientRect|Cannot get context before mount/i.test(message)) {
      throw e;
    }
  }

  const contextId = canvasRef.current?.getContextId?.();
  const makeContext = (globalThis as typeof globalThis & { RNWebGPU?: RNWebGPUGlobal }).RNWebGPU
    ?.MakeWebGPUCanvasContext;
  if (contextId === undefined || !nativeSurface || !makeContext) {
    return null;
  }
  return makeContext(
    contextId,
    nativeSurface.clientWidth || nativeSurface.width || 1,
    nativeSurface.clientHeight || nativeSurface.height || 1
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
