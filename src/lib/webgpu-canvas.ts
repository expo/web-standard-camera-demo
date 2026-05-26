import { PixelRatio } from 'react-native';
import type { RefObject } from 'react';
import type { CanvasRef, RNCanvasContext } from 'react-native-wgpu';

interface WebGpuCanvasElement {
  clientHeight: number;
  clientWidth: number;
  height: number;
  width: number;
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
  const context = canvasRef.current?.getContext('webgpu');
  if (!context) {
    throw new Error('getContext("webgpu") returned null');
  }

  const canvas = context.canvas as WebGpuCanvasElement;
  const pixelRatio = PixelRatio.get();
  const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
  const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
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
