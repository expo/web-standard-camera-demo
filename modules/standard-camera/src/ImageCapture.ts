// W3C Image Capture — https://www.w3.org/TR/image-capture/
//
// Minimal subset: `new ImageCapture(videoTrack)` and `grabFrame()`. The
// spec-defined `takePhoto`, `getPhotoCapabilities`, `getPhotoSettings`, and
// the photo-settings family are out of scope until a consumer asks for them.
//
// `grabFrame()` returns a `Promise<ImageBitmap>`. In a real browser the
// returned bitmap is opaque and is consumed by WebGPU through
// `device.queue.copyExternalImageToTexture({ source: bitmap }, ...)`.
// `react-native-wgpu@0.5.11` does not yet implement that path for our
// bitmaps, so the bitmap we return additionally exposes its tight-packed
// BGRA bytes through `_data` and `_format`. The demo uploads via
// `device.queue.writeTexture(...)` in the meantime; once react-native-wgpu
// accepts our bitmaps in `copyExternalImageToTexture`, callers can drop the
// underscore-prefixed reach-through and use the standard API verbatim.

import { DOMException } from './DOMException';
import { MediaStreamTrack as StandardMediaStreamTrack } from './MediaStreamTrack';

export interface CameraImageBitmap extends ImageBitmap {
  /** @internal Tight-packed pixel bytes, length `width * height * 4`. */
  readonly _data: Uint8Array;
  /** @internal Always `"bgra8unorm"` for now. */
  readonly _format: 'bgra8unorm';
  /** @internal AVCapture sample-buffer delivery counter; rising = live, flat = stalled. */
  readonly _frameNumber: number;
}

export class ImageCapture {
  readonly track: MediaStreamTrack;

  // Accepts the DOM-typed `MediaStreamTrack` so consumers can write
  // `new ImageCapture(stream.getVideoTracks()[0])` without casting. At
  // runtime we validate against the project's polyfill class via duck typing
  // (`_native` is the polyfill marker) — `getUserMedia` returns those even
  // though TypeScript widens to the DOM type.
  constructor(videoTrack: MediaStreamTrack) {
    if (videoTrack == null || typeof videoTrack !== 'object') {
      throw new TypeError('ImageCapture argument must be a MediaStreamTrack');
    }
    if (videoTrack.kind !== 'video') {
      throw new DOMException(
        'ImageCapture requires a video track',
        'NotSupportedError'
      );
    }
    if (!('_native' in videoTrack)) {
      throw new DOMException(
        'ImageCapture is not supported for tracks from outside the standard-camera module',
        'NotSupportedError'
      );
    }
    this.track = videoTrack;
  }

  // @ref https://www.w3.org/TR/image-capture/#dom-imagecapture-grabframe
  async grabFrame(): Promise<CameraImageBitmap> {
    if (this.track.readyState === 'ended') {
      throw new DOMException(
        'The MediaStreamTrack is in the "ended" state',
        'InvalidStateError'
      );
    }
    const frame = (this.track as unknown as StandardMediaStreamTrack)._native.__getLatestFrame();
    if (!frame) {
      // No frame has been delivered yet (cold start or simulator with no
      // AVCaptureDevice). Per spec, grabFrame should reject in this case.
      throw new DOMException(
        'No frames available from the video track yet',
        'UnknownError'
      );
    }
    return new ShimImageBitmap(frame.width, frame.height, frame.data, frame.frameNumber);
  }
}

// Minimal stand-in for the W3C `ImageBitmap`. The spec'd interface is opaque
// — width / height / close() and that's it — so this stays narrow. The extra
// `_data` / `_format` / `_frameNumber` fields are how WebGPU consumers
// currently fetch the pixels and tell whether the camera is producing new
// frames; they go away once we have full `copyExternalImageToTexture`
// integration.
class ShimImageBitmap implements CameraImageBitmap {
  readonly width: number;
  readonly height: number;
  readonly _data: Uint8Array;
  readonly _format: 'bgra8unorm' = 'bgra8unorm';
  readonly _frameNumber: number;
  #closed = false;

  constructor(width: number, height: number, data: Uint8Array, frameNumber: number) {
    this.width = width;
    this.height = height;
    this._data = data;
    this._frameNumber = frameNumber;
  }

  close(): void {
    this.#closed = true;
  }
}
