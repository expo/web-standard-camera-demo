// @ref LLP 0003 — MediaStream subset

import { DOMException } from './DOMException';
import { MediaStreamTrack } from './MediaStreamTrack';
import type { NativeMediaStream } from './native';

// Private state uses `#field` syntax so it does not appear in the structural
// type — this lets our class be assignment-compatible with the DOM lib's
// MediaStream (whose private fields are also not part of the structural type).

export class MediaStream extends EventTarget {
  /** @internal */
  readonly _native: NativeMediaStream;
  #tracks: MediaStreamTrack[];
  #onaddtrack: ((ev: Event) => void) | null = null;
  #onremovetrack: ((ev: Event) => void) | null = null;

  /** @internal */
  constructor(native: NativeMediaStream) {
    super();
    this._native = native;
    // @ref LLP 0003#stream-getTracks — Wrap native tracks once at construction
    this.#tracks = native.getTracks().map((t) => new MediaStreamTrack(t));
  }

  // @ref LLP 0003#stream-id
  get id(): string { return this._native.id; }

  // @ref LLP 0003#stream-active
  get active(): boolean {
    return this.#tracks.some((t) => t.readyState === 'live');
  }

  // @ref LLP 0003#stream-getTracks
  getTracks(): MediaStreamTrack[] { return [...this.#tracks]; }

  // @ref LLP 0003#stream-getVideoTracks
  getVideoTracks(): MediaStreamTrack[] {
    return this.#tracks.filter((t) => t.kind === 'video');
  }

  // @ref LLP 0003#stream-getAudioTracks — always empty in v1
  getAudioTracks(): MediaStreamTrack[] {
    return this.#tracks.filter((t) => t.kind === 'audio');
  }

  // @ref LLP 0003#stream-getTrackById
  getTrackById(id: string): MediaStreamTrack | null {
    return this.#tracks.find((t) => t.id === id) ?? null;
  }

  // @ref LLP 0001#mediastream-addtrack — out of scope
  addTrack(_track: MediaStreamTrack): void {
    throw new DOMException('addTrack is not supported', 'NotSupportedError');
  }

  // @ref LLP 0001#mediastream-removetrack — out of scope
  removeTrack(_track: MediaStreamTrack): void {
    throw new DOMException('removeTrack is not supported', 'NotSupportedError');
  }

  // @ref LLP 0001#mediastream-clone — out of scope
  clone(): MediaStream {
    throw new DOMException('MediaStream.clone() is not supported', 'NotSupportedError');
  }

  get onaddtrack(): ((ev: Event) => void) | null { return this.#onaddtrack; }
  set onaddtrack(handler: ((ev: Event) => void) | null) {
    if (this.#onaddtrack) this.removeEventListener('addtrack', this.#onaddtrack);
    this.#onaddtrack = handler;
    if (handler) this.addEventListener('addtrack', handler);
  }

  get onremovetrack(): ((ev: Event) => void) | null { return this.#onremovetrack; }
  set onremovetrack(handler: ((ev: Event) => void) | null) {
    if (this.#onremovetrack) this.removeEventListener('removetrack', this.#onremovetrack);
    this.#onremovetrack = handler;
    if (handler) this.addEventListener('removetrack', handler);
  }
}
