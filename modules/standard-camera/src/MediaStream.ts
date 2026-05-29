// @ref LLP 0004 — MediaStream subset

import { DOMException } from './DOMException';
import { MediaStreamTrack } from './MediaStreamTrack';
import NativeModule from './native';
import type { NativeMediaStream, NativeMediaStreamTrack } from './native';

// Private state uses `#field` syntax so it does not appear in the structural
// type — this lets our class be assignment-compatible with the DOM lib's
// MediaStream.
//
// `__expo_shared_object_id__` is exposed as a getter so the canonical
// `getSharedObjectId(obj)` helper (https://github.com/expo/expo/pull/46054)
// works on a MediaStream wrapper directly when forwarding it as a view prop.

// @ref LLP 0001#mediastream-constructor — Constructor arguments shape.
type MediaStreamArg = MediaStream | MediaStreamTrack[] | NativeMediaStream;

export class MediaStream extends EventTarget {
  /** @internal */
  readonly _native: NativeMediaStream;
  #tracks: MediaStreamTrack[];
  #onaddtrack: ((ev: Event) => void) | null = null;
  #onremovetrack: ((ev: Event) => void) | null = null;

  constructor();
  constructor(stream: MediaStream);
  constructor(tracks: MediaStreamTrack[]);
  /** @internal */
  constructor(native: NativeMediaStream);
  constructor(arg?: MediaStreamArg) {
    super();

    // @ref LLP 0004#stream-construction — Internal path: a getUserMedia or
    // clone native handle. Distinguished from public-IDL args by the
    // SharedObject discriminant.
    if (isNativeStreamHandle(arg)) {
      this._native = arg;
      this.#tracks = arg.getTracks().map((t) => new MediaStreamTrack(t));
      return;
    }

    // @ref LLP 0001#mediastream-constructor — Spec constructor: 0-arg,
    // sequence, or copy of an existing MediaStream.
    let initialTracks: MediaStreamTrack[];
    if (arg == null) {
      initialTracks = [];
    } else if (arg instanceof MediaStream) {
      initialTracks = arg.getTracks();
    } else if (Array.isArray(arg)) {
      const seen = new Set<MediaStreamTrack>();
      initialTracks = [];
      for (const t of arg) {
        if (!(t instanceof MediaStreamTrack)) {
          throw new DOMException(
            'MediaStream constructor sequence must contain only MediaStreamTracks',
            'TypeError'
          );
        }
        // Dedupe per spec step 3 — "if already in stream's track set, skip"
        if (!seen.has(t)) {
          seen.add(t);
          initialTracks.push(t);
        }
      }
    } else {
      throw new DOMException(
        'MediaStream argument must be a MediaStream or a sequence of MediaStreamTracks',
        'TypeError'
      );
    }

    const nativeTracks: NativeMediaStreamTrack[] = initialTracks.map((t) => t._native);
    this._native = NativeModule.createMediaStream(nativeTracks);
    this.#tracks = [...initialTracks];
  }

  // @ref LLP 0006#sharedobject-view-prop — Expose the underlying SharedObject's id
  // so the canonical `getSharedObjectId(obj)` helper works on the wrapper directly.
  // See https://github.com/expo/expo/pull/46054.
  get __expo_shared_object_id__(): number | undefined {
    return (this._native as unknown as { __expo_shared_object_id__?: number }).__expo_shared_object_id__;
  }

  // @ref LLP 0001#dom-mediastream-id — spec attribute
  // @ref LLP 0004#stream-id
  get id(): string { return this._native.id; }

  // @ref LLP 0004#stream-active
  get active(): boolean {
    return this.#tracks.some((t) => t.readyState === 'live');
  }

  // @ref LLP 0004#stream-getTracks — Snapshot per spec
  getTracks(): MediaStreamTrack[] { return [...this.#tracks]; }

  // @ref LLP 0004#stream-getVideoTracks
  getVideoTracks(): MediaStreamTrack[] {
    return this.#tracks.filter((t) => t.kind === 'video');
  }

  // @ref LLP 0004#stream-getAudioTracks
  getAudioTracks(): MediaStreamTrack[] {
    return this.#tracks.filter((t) => t.kind === 'audio');
  }

  // @ref LLP 0004#stream-getTrackById
  getTrackById(id: string): MediaStreamTrack | null {
    return this.#tracks.find((t) => t.id === id) ?? null;
  }

  // @ref LLP 0001#dom-mediastream-addtrack — script-initiated; no spec event fires.
  // @ref LLP 0004#stream-addtrack
  addTrack(track: MediaStreamTrack): void {
    if (!(track instanceof MediaStreamTrack)) {
      throw new DOMException('addTrack argument must be a MediaStreamTrack', 'TypeError');
    }
    if (this.#tracks.includes(track)) {
      return;
    }
    this.#tracks.push(track);
    this._native.addTrack(track._native);
    this.#dispatchInternalTrackSetChanged();
  }

  // @ref LLP 0001#dom-mediastream-removetrack — script-initiated; no spec event fires.
  // @ref LLP 0004#stream-removetrack
  removeTrack(track: MediaStreamTrack): void {
    if (!(track instanceof MediaStreamTrack)) {
      throw new DOMException('removeTrack argument must be a MediaStreamTrack', 'TypeError');
    }
    const index = this.#tracks.indexOf(track);
    if (index < 0) {
      return;
    }
    this.#tracks.splice(index, 1);
    this._native.removeTrack(track._native);
    this.#dispatchInternalTrackSetChanged();
  }

  // Internal-only notification, distinct from the spec's `addtrack`/`removetrack`
  // events (which fire only for UA-initiated track-set changes). The HTML spec
  // says a media element's `ended` event must fire when its assigned MediaStream
  // becomes inactive — including via `removeTrack`. The TS-side `<Video>` element
  // listens for this to re-evaluate `ended`. The event name uses our internal
  // prefix so it can't collide with anything from a WPT body.
  // @ref LLP 0005#srcobject-ended
  #dispatchInternalTrackSetChanged(): void {
    this.dispatchEvent(new Event('__standardcamera_tracksetchange'));
  }

  // @ref LLP 0001#dom-mediastream-clone
  // @ref LLP 0004#stream-clone
  clone(): MediaStream {
    // Build a JS-only clone whose tracks are clones of ours; the spec is
    // explicit that each contained track is cloned. The new native handle
    // is created via the same path as a script-constructed MediaStream so
    // it has a fresh id and a track list mirroring the JS side.
    const clonedTracks = this.#tracks.map((t) => t.clone());
    return new MediaStream(clonedTracks);
  }

  // @ref LLP 0001#event-mediastream-addtrack — IDL handler attribute. Per spec
  // the `addtrack` event is UA-initiated only; our subset never adds tracks
  // outside of script, so addEventListener wires up but listeners never fire.
  get onaddtrack(): ((ev: Event) => void) | null { return this.#onaddtrack; }
  set onaddtrack(handler: ((ev: Event) => void) | null) {
    if (this.#onaddtrack) this.removeEventListener('addtrack', this.#onaddtrack);
    this.#onaddtrack = handler;
    if (handler) this.addEventListener('addtrack', handler);
  }

  // @ref LLP 0001#event-mediastream-removetrack — IDL handler attribute. Same
  // UA-initiated-only semantics as `addtrack`; our script-initiated
  // `removeTrack` is silent per spec.
  get onremovetrack(): ((ev: Event) => void) | null { return this.#onremovetrack; }
  set onremovetrack(handler: ((ev: Event) => void) | null) {
    if (this.#onremovetrack) this.removeEventListener('removetrack', this.#onremovetrack);
    this.#onremovetrack = handler;
    if (handler) this.addEventListener('removetrack', handler);
  }
}

// A NativeMediaStream SharedObject has `__expo_shared_object_id__` but is not
// a JS MediaStream wrapper — the wrapper class exposes the same property as a
// getter, so we exclude wrappers via instanceof.
function isNativeStreamHandle(x: unknown): x is NativeMediaStream {
  return (
    typeof x === 'object' &&
    x !== null &&
    !(x instanceof MediaStream) &&
    '__expo_shared_object_id__' in x
  );
}
