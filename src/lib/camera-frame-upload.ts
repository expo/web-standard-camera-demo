// @ref LLP 0010#universal-demo-routes — Demo routes stay shared while this
// helper adapts the host's ImageBitmap/frame representation to WebGPU upload.

export interface CameraFrameUploadSource {
  readonly height: number;
  readonly width: number;
  readonly close?: () => void;
  readonly _data?: Uint8Array;
  readonly _format?: GPUTextureFormat;
  readonly _frameNumber?: number;
}

export interface CameraFrameUploadResult {
  readonly bytes: number;
  readonly method: 'copyExternalImageToTexture' | 'writeTexture';
}

let scratchCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
let scratchContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

export function createBgraCameraFrameSource(
  width: number,
  height: number,
  data: Uint8Array
): CameraFrameUploadSource {
  return { _data: data, _format: 'bgra8unorm', height, width };
}

export function getCameraFrameByteLength(frame: CameraFrameUploadSource): number {
  return frame._data?.byteLength ?? frame.width * frame.height * 4;
}

export function getCameraFrameNumber(frame: CameraFrameUploadSource): number | null {
  return typeof frame._frameNumber === 'number' ? frame._frameNumber : null;
}

export function getCameraFrameTextureFormat(frame: CameraFrameUploadSource): GPUTextureFormat {
  return frame._format ?? 'rgba8unorm';
}

export function closeCameraFrame(frame: CameraFrameUploadSource): void {
  frame.close?.();
}

export function uploadCameraFrameToTexture(
  device: GPUDevice,
  texture: GPUTexture,
  frame: CameraFrameUploadSource
): CameraFrameUploadResult {
  const bytes = getCameraFrameByteLength(frame);
  if (frame._data) {
    device.queue.writeTexture(
      { texture },
      frame._data,
      { bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
      { width: frame.width, height: frame.height }
    );
    return { bytes, method: 'writeTexture' };
  }

  // Browser ImageBitmap uploads through react-native-wgpu's web bridge have
  // proven to render black through copyExternalImageToTexture. Keep the route
  // code on Web APIs, but normalize the browser frame to RGBA bytes here.
  const context = getScratchContext(frame.width, frame.height);
  context.drawImage(frame as unknown as CanvasImageSource, 0, 0, frame.width, frame.height);
  const rgba = context.getImageData(0, 0, frame.width, frame.height).data;
  device.queue.writeTexture(
    { texture },
    rgba,
    { bytesPerRow: frame.width * 4, rowsPerImage: frame.height },
    { width: frame.width, height: frame.height }
  );
  return { bytes: rgba.byteLength, method: 'writeTexture' };
}

function getScratchContext(
  width: number,
  height: number
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (!scratchCanvas) {
    if (typeof OffscreenCanvas === 'function') {
      scratchCanvas = new OffscreenCanvas(width, height);
    } else if (typeof document !== 'undefined') {
      scratchCanvas = document.createElement('canvas');
    } else {
      throw new Error('No canvas implementation is available for ImageBitmap uploads');
    }
  }

  if (scratchCanvas.width !== width) scratchCanvas.width = width;
  if (scratchCanvas.height !== height) scratchCanvas.height = height;

  if (!scratchContext) {
    scratchContext = scratchCanvas.getContext('2d', { willReadFrequently: true });
    if (!scratchContext) {
      throw new Error('getContext("2d") returned null for ImageBitmap uploads');
    }
  }

  return scratchContext;
}
