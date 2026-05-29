// @ref LLP 0007 — Install navigator.mediaDevices polyfill onto globalThis

// Hermes V1 (RN 0.85) doesn't ship globalThis.EventTarget / Event. Pull them
// in before any of our classes (which extend EventTarget) are evaluated.
import 'event-target-polyfill';

import { DOMException } from './DOMException';
import { MediaDevices, mediaDevices } from './MediaDevices';
import { MediaStream } from './MediaStream';
import { MediaStreamTrack } from './MediaStreamTrack';

const INSTALLED_SYMBOL = Symbol.for('standard-camera.installed');

// We don't redeclare the globals (`navigator`, `MediaStream`, etc.) because
// the DOM lib already declares them and merging conflicts. Instead, the
// installer assigns at runtime; consumers can do `(globalThis as any).MediaStream`
// or rely on the built-in DOM types being compatible enough.

export function installNavigatorMediaDevices(): void {
  const g = globalThis as unknown as Record<string | symbol, unknown>;
  if (g[INSTALLED_SYMBOL]) return;

  // Ensure a navigator object exists.
  if (g.navigator == null) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  // Attach the mediaDevices singleton.
  const nav = (globalThis as unknown as { navigator: Record<string, unknown> }).navigator;
  if (!nav.mediaDevices) {
    Object.defineProperty(nav, 'mediaDevices', {
      value: mediaDevices,
      writable: false,
      configurable: true,
      enumerable: true,
    });
  }

  // Expose constructors for instanceof checks in ported WPT tests.
  // @ref LLP 0007 — global classes for `instanceof`
  if (!g.MediaStream) g.MediaStream = MediaStream;
  if (!g.MediaStreamTrack) g.MediaStreamTrack = MediaStreamTrack;
  if (!g.MediaDevices) g.MediaDevices = MediaDevices;
  if (!g.DOMException) g.DOMException = DOMException;

  g[INSTALLED_SYMBOL] = true;
}

/**
 * Test helper — remove the polyfill (use only in tests, never in app code).
 * @internal
 */
export function __uninstallForTests(): void {
  const g = globalThis as unknown as Record<string | symbol, unknown>;
  delete g[INSTALLED_SYMBOL];
}
