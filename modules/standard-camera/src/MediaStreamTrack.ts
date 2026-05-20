// @ref LLP 0003 — MediaStreamTrack subset

import type { EventSubscription } from 'expo-modules-core';

import { DOMException } from './DOMException';
import type { NativeMediaStreamTrack } from './native';
import type { MediaTrackCapabilities, MediaTrackSettings, MediaStreamTrackKind, MediaStreamTrackState } from './types';

// Private state uses `#field` syntax — see MediaStream.ts for rationale.

export class MediaStreamTrack extends EventTarget {
  /** @internal */
  readonly _native: NativeMediaStreamTrack;
  #nativeSubscription: EventSubscription | null = null;
  #onended: ((ev: Event) => void) | null = null;
  #onmute: ((ev: Event) => void) | null = null;
  #onunmute: ((ev: Event) => void) | null = null;

  /** @internal */
  constructor(native: NativeMediaStreamTrack) {
    super();
    this._native = native;

    // @ref LLP 0003#track-stop — Native emits "ended" asynchronously; forward it.
    this.#nativeSubscription = native.addListener('ended', () => {
      this.dispatchEvent(new Event('ended'));
    });
  }

  // @ref LLP 0003#track-id
  get id(): string { return this._native.id; }

  // @ref LLP 0003#track-kind
  get kind(): MediaStreamTrackKind { return this._native.kind; }

  // @ref LLP 0003#track-label
  get label(): string { return this._native.label; }

  // @ref LLP 0003#track-enabled
  get enabled(): boolean { return this._native.enabled; }
  set enabled(value: boolean) { this._native.enabled = value; }

  // @ref LLP 0003#track-muted
  get muted(): boolean { return this._native.muted; }

  // @ref LLP 0003#track-readyState
  get readyState(): MediaStreamTrackState { return this._native.readyState; }

  // Spec compatibility — we don't honor these but the DOM type requires them.
  contentHint: string = '';
  isolated: boolean = false;

  // @ref LLP 0003#track-stop
  stop(): void { this._native.stop(); }

  // @ref LLP 0003#track-getSettings
  getSettings(): MediaTrackSettings { return this._native.getSettings(); }

  // @ref LLP 0003#track-getConstraints
  getConstraints(): Record<string, unknown> { return this._native.getConstraints(); }

  // @ref LLP 0003#track-getCapabilities
  getCapabilities(): MediaTrackCapabilities { return this._native.getCapabilities(); }

  // @ref LLP 0001#mediastreamtrack-clone — out of scope
  clone(): MediaStreamTrack {
    throw new DOMException('MediaStreamTrack.clone() is not supported', 'NotSupportedError');
  }

  // @ref LLP 0001#mediastreamtrack-applyConstraints — out of scope
  async applyConstraints(_constraints?: unknown): Promise<void> {
    throw new DOMException('applyConstraints is not supported', 'OverconstrainedError');
  }

  get onended(): ((ev: Event) => void) | null { return this.#onended; }
  set onended(handler: ((ev: Event) => void) | null) {
    if (this.#onended) this.removeEventListener('ended', this.#onended);
    this.#onended = handler;
    if (handler) this.addEventListener('ended', handler);
  }

  get onmute(): ((ev: Event) => void) | null { return this.#onmute; }
  set onmute(handler: ((ev: Event) => void) | null) {
    if (this.#onmute) this.removeEventListener('mute', this.#onmute);
    this.#onmute = handler;
    if (handler) this.addEventListener('mute', handler);
  }

  get onunmute(): ((ev: Event) => void) | null { return this.#onunmute; }
  set onunmute(handler: ((ev: Event) => void) | null) {
    if (this.#onunmute) this.removeEventListener('unmute', this.#onunmute);
    this.#onunmute = handler;
    if (handler) this.addEventListener('unmute', handler);
  }
}
