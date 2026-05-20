# LLP 0006: `navigator.mediaDevices` polyfill

**Type:** Decision
**Status:** Active
**Systems:** standard-camera, demo-app
**Author:** James Ide
**Date:** 2026-05-19
**Related:** 0000, 0002

## Context

The W3C spec entry point is `navigator.mediaDevices.getUserMedia(...)`. React Native does not expose a `navigator` object with `mediaDevices` on it by default. We need to decide how a caller actually invokes our `getUserMedia` implementation.

## Options considered

### Option A — Module import only

```ts
import { mediaDevices, MediaStream } from "standard-camera";
const stream = await mediaDevices.getUserMedia({ video: true });
```

Conservative. No globals touched. But every code sample copy-pasted from the web has to be rewritten before it runs.

### Option B — Global polyfill installed at app startup

```ts
// In app/_layout.tsx
import { installNavigatorMediaDevices } from "standard-camera";
installNavigatorMediaDevices();

// In any component
const stream = await navigator.mediaDevices.getUserMedia({ video: true });
```

Browser code runs unchanged. The cost is a global side effect.

### Option C — Both

Export the classes and provide an opt-in installer. Lets the demo decide.

## Decision

**Option C.** Both. The module exports:

- `MediaDevices` class and `mediaDevices` singleton
- `MediaStream`, `MediaStreamTrack` classes
- `installNavigatorMediaDevices()` — idempotent installer

The demo app calls `installNavigatorMediaDevices()` once in `src/app/_layout.tsx` before any screen renders, so `navigator.mediaDevices.getUserMedia(...)` works everywhere in the app. This is what makes "DOM code just works" claim true for the demo.

Library consumers who don't want the global can skip the installer and use the named exports.

## What the installer does

1. If `globalThis.navigator` is undefined, create `{}` and assign to `globalThis.navigator`.
2. Define `navigator.mediaDevices` as our `MediaDevices` singleton (configurable: `true`, writable: `false` — so app code can't accidentally clobber it).
3. Define `globalThis.MediaStream`, `globalThis.MediaStreamTrack`, `globalThis.MediaDevices` as the constructors, so `instanceof` checks in ported WPT tests work.
4. Set a guard symbol so a second call is a no-op rather than a crash.

```ts
const INSTALLED = Symbol.for("standard-camera.installed");

export function installNavigatorMediaDevices(): void {
  if ((globalThis as any)[INSTALLED]) return;
  // ... wire up ...
  (globalThis as any)[INSTALLED] = true;
}
```

## Why not `Object.defineProperty(globalThis, "navigator", ...)` always?

If another module (like `@react-native-community/netinfo` or any future RN core polyfill) already sets `globalThis.navigator`, we must not stomp it. We attach to whatever `navigator` exists, creating one only if absent.

## Security / origin

The browser version of `getUserMedia` requires a secure context and Permissions Policy. In React Native, neither concept exists — the app already has whatever device permissions its bundle was granted. We do not gate on origin. This is the only intentional deviation from the spec's prose, and it cannot be helped on a native platform.

## Consequences

- Anyone importing the module who calls the installer changes a global. We must document this in the README and AGENTS.md.
- WPT-ported tests can use `navigator.mediaDevices.getUserMedia` directly without an adapter, which makes the port nearly verbatim.
- TypeScript: we ship ambient declarations so `navigator.mediaDevices` is typed even before the installer is called (i.e., the type system is optimistic about the global being present). Apps that don't install the polyfill will get runtime undefined errors; we view that as their problem to opt into.
