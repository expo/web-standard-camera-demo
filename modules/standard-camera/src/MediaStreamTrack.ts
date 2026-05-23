// @ref LLP 0008#dom-mediastreamtrack — Upstream spec text
// @ref LLP 0003#track-* — MediaStreamTrack subset

import type { EventSubscription } from 'expo-modules-core';

import { DOMException } from './DOMException';
import type { NativeMediaStreamTrack } from './native';
import type { MediaTrackCapabilities, MediaTrackSettings, MediaStreamTrackKind, MediaStreamTrackState } from './types';

// Private state uses `#field` syntax — see MediaStream.ts for rationale.

export class MediaStreamTrack extends EventTarget {
  /** @internal */
  readonly _native: NativeMediaStreamTrack;
  #nativeSubscriptions: EventSubscription[] = [];
  #onended: ((ev: Event) => void) | null = null;
  #onmute: ((ev: Event) => void) | null = null;
  #onunmute: ((ev: Event) => void) | null = null;

  /** @internal */
  constructor(native: NativeMediaStreamTrack) {
    super();
    this._native = native;

    // @ref LLP 0003#track-events — Forward native events to DOM-style events.
    this.#nativeSubscriptions.push(
      native.addListener('ended', () => this.dispatchEvent(new Event('ended'))),
      native.addListener('mute', () => this.dispatchEvent(new Event('mute'))),
      native.addListener('unmute', () => this.dispatchEvent(new Event('unmute'))),
    );
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

  // Spec compatibility — we don't honor these meaningfully, but the DOM type requires them.
  // `isolated` is spec-readonly; we expose it as such.
  contentHint: string = '';
  readonly isolated: boolean = false;

  // @ref LLP 0008#dom-mediastreamtrack-stop — spec algorithm
  // @ref LLP 0003#track-stop
  stop(): void { this._native.stop(); }

  // @ref LLP 0003#track-getSettings
  getSettings(): MediaTrackSettings { return this._native.getSettings(); }

  // @ref LLP 0003#track-getConstraints
  getConstraints(): Record<string, unknown> { return this._native.getConstraints(); }

  // @ref LLP 0003#track-getCapabilities — Empty in v1; spec allows an empty MediaTrackCapabilities.
  getCapabilities(): MediaTrackCapabilities { return this._native.getCapabilities(); }

  // @ref LLP 0008#dom-mediastreamtrack-clone — spec algorithm
  // @ref LLP 0003#track-clone — Shares the underlying CaptureSource so the
  // camera stays live as long as any clone references it.
  clone(): MediaStreamTrack {
    return new MediaStreamTrack(this._native.clone());
  }

  // @ref LLP 0008#dom-mediastreamtrack-applyconstraints — spec algorithm
  // @ref LLP 0003#track-applyConstraints
  //
  // We don't reconfigure the AVCaptureSession at runtime, so applyConstraints
  // is effectively a no-op: accept any "ideal" or basic-form constraints
  // (silently keeping the current settings), but reject impossible "exact" or
  // `{min,max}` ranges that no real device could satisfy.
  async applyConstraints(constraints?: Record<string, unknown>): Promise<void> {
    if (this.readyState === 'ended') {
      return;
    }
    if (constraints == null || isEmptyObject(constraints)) {
      return;
    }
    // Reject legacy `mandatory`/`optional` constraint forms — modern syntax
    // disallows their presence alongside the constrainable-properties syntax.
    if ('mandatory' in constraints || 'optional' in constraints) {
      const offending = 'mandatory' in constraints ? 'mandatory' : 'optional';
      throw new DOMException(
        `Constraint cannot be satisfied: ${offending}`,
        'OverconstrainedError',
        offending
      );
    }
    const offending = findOffendingConstraint(constraints);
    if (offending !== undefined) {
      throw new DOMException(
        `Constraint cannot be satisfied: ${offending}`,
        'OverconstrainedError',
        offending
      );
    }
    // resizeMode: reject `{exact: X}` where X isn't "none" (we don't support
    // crop/scale paths). Basic-form and `{ideal: X}` accept silently.
    const rm = (constraints as { resizeMode?: unknown }).resizeMode;
    if (rm && typeof rm === 'object') {
      const exact = (rm as { exact?: unknown }).exact;
      if (typeof exact === 'string' && exact !== 'none') {
        throw new DOMException(
          'Constraint cannot be satisfied: resizeMode',
          'OverconstrainedError',
          'resizeMode'
        );
      }
    }
    // groupId: reject `{exact: X}` that doesn't match this track's current
    // device, and any too-long ideal/exact string (modeled on Chrome's
    // behavior in DOMString validation, which WPT relies on).
    const gid = (constraints as { groupId?: unknown }).groupId;
    if (gid && typeof gid === 'object') {
      const g = gid as { exact?: unknown; ideal?: unknown };
      const settings = this.getSettings() as { groupId?: string };
      if (typeof g.exact === 'string') {
        if (g.exact.length > 500 || g.exact !== settings.groupId) {
          throw new DOMException(
            'Constraint cannot be satisfied: groupId',
            'OverconstrainedError',
            'groupId'
          );
        }
      }
      if (typeof g.ideal === 'string' && g.ideal.length > 500) {
        throw new DOMException(
          'Constraint cannot be satisfied: groupId',
          'OverconstrainedError',
          'groupId'
        );
      }
    }
    // Otherwise this is an ideal/basic-form constraint; per spec the UA is
    // free to keep current settings if it can't satisfy ideal values.
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

function isEmptyObject(o: Record<string, unknown>): boolean {
  for (const _ in o) {
    return false;
  }
  return true;
}

// Capability ranges matching the JS-side validator in MediaDevices.ts. Used
// to name the *actually offending* constraint in applyConstraints() rather
// than just returning the first key in the object.
const APPLY_CONSTRAINTS_RANGES: Record<string, { min: number; max: number }> = {
  width: { min: 0, max: 4032 },
  height: { min: 0, max: 3024 },
  frameRate: { min: 0, max: 60 },
  aspectRatio: { min: 0, max: 16 / 9 },
};

function findOffendingConstraint(constraints: Record<string, unknown>): string | undefined {
  for (const [name, value] of Object.entries(constraints)) {
    if (!value || typeof value !== 'object') continue;
    const range = APPLY_CONSTRAINTS_RANGES[name];
    if (!range) continue;
    const v = value as { min?: number; max?: number; exact?: number };
    if (typeof v.max === 'number' && (v.max <= 0 || v.max < range.min)) return name;
    if (typeof v.min === 'number' && v.min > range.max) return name;
    if (typeof v.min === 'number' && typeof v.max === 'number' && v.min > v.max) return name;
    if (typeof v.exact === 'number' && (v.exact < range.min || v.exact > range.max)) return name;
  }
  return undefined;
}
