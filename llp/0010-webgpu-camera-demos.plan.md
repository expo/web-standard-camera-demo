# LLP 0010: WebGPU camera demos

**Type:** Plan
**Status:** Active
**Systems:** standard-camera, demo
**Author:** James Ide
**Date:** 2026-05-23
**Related:** 0000, 0001, 0002, 0003, 0004, 0011

## Summary

This LLP plans a small catalog of visceral, W3C-pure demos that sit on top of the standard-camera module and make the project's spec-compliance thesis concrete. The thesis is that "if our camera surface matches the W3C `MediaStream` / `getUserMedia` shape, browser-shaped code can run on iOS through it." The demos in this plan are chosen so the only library code that does anything camera-specific is the standard-camera module itself — everything else (rendering, shading, compute) goes through other W3C-defined surfaces, primarily WebGPU and WGSL.

Each demo is small, ships on its own, and uses only one custom bridge: a way to expose the camera's `CVPixelBuffer` to WebGPU's `importSharedTextureMemory`. That bridge is specified in [LLP 0011](./0011-cvpixelbuffer-webgpu-bridge.decision.md) (to follow); this LLP catalogues what the demos do and the order to build them in.

## Goals

- **Showcase W3C compliance viscerally.** The user sees the live camera being processed through standard browser APIs (WebGPU, WGSL) in real time. The "wait, that's the actual camera flowing through unmodified browser code" moment is the demo.
- **Make the project's value clear in under 30 seconds.** A first-time viewer should understand the pitch ("browser code, on iOS, through our camera") without needing the README.
- **Exercise the spec, not just decorate it.** Each demo uses the standard `MediaStream` / `MediaStreamTrack` / `<Video srcObject>` surface defined in [LLP 0002](./0002-getusermedia.spec.md), [LLP 0003](./0003-mediastream.spec.md), and [LLP 0004](./0004-htmlmediaelement-srcobject.spec.md) — discovering and exercising gaps where they exist.

## Non-goals

- **Not a replacement for `expo-camera` or `react-native-vision-camera`.** Those are general-purpose camera UIs. The demos here exist to validate the spec surface, not to ship a product feature.
- **Not a WebGPU teaching surface.** The shaders and pipelines are kept minimal so the camera-as-W3C-source story is what stands out.
- **No native ML, no native CV.** The whole point is browser-shaped code. If a demo needs ML, it runs through WebGPU compute shaders or a WebGPU-backed JS ML library, not through a native Core ML / Vision pipeline.

## The pitch (one line per demo)

| Demo | One-line pitch |
|---|---|
| Rotating cube of cameras | A spinning cube, every face is the live camera, all in WGSL — a direct port of the [WebGPU samples' `videoUploading`](https://webgpu.github.io/webgpu-samples/?sample=videoUploading) demo. |
| Shader playground | Live camera processed by a swappable fragment shader (kaleidoscope, edge-detect, posterize, sobel) — Snapchat-lens feel without a single line of native CV code. |
| MNIST on the camera (stretch) | Point the phone at a hand-drawn digit, read the classification. ML inference in WGSL compute shaders, model weights downloaded as a `.safetensors`-class blob, all browser-shaped. |

## Validated foundations

These were spiked and verified before this LLP was written.

| Foundation | Status | Evidence |
|---|---|---|
| Hermes V1 on RN 0.85 ships **no** WebAssembly runtime | Confirmed | `typeof WebAssembly === "undefined"`; symbol dump of the prebuilt `hermesvm.framework` shows zero WASM symbols. |
| `expo-gl` on iOS provides WebGL 1 only | Confirmed | `gl.getParameter(gl.VERSION) === "WebGL 1.0"`. |
| three.js ≥ r163 cannot initialize on WebGL 1 | Confirmed | `THREE.WebGLRenderer: WebGL 1 is not supported since r163.` thrown at construction. |
| `react-native-wgpu` (Dawn) works on SDK 56 / RN 0.85 / Hermes V1 / New Arch | Confirmed | WebGPU triangle renders end to end (adapter → device → shader compile → render pass → `context.present()`). |
| `SharedTextureMemory` import path exists | Confirmed (API; runtime spike pending) | `device.importSharedTextureMemory({ handle })` → `createTexture()` → `beginAccess()` is documented and exercised in react-native-wgpu's own example app. |

The first three rows are the reason this plan is WebGPU-shaped and not WASM-shaped or three.js-shaped; they're recorded so future authors don't re-walk the same dead-end branches. See "Paths not taken" below for the full record.

## Spec surface used

Every demo in this plan exercises only standard W3C surfaces on the JS side. The full list:

| Surface | Source spec | Used for |
|---|---|---|
| `navigator.mediaDevices.getUserMedia` | [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/#dom-mediadevices-getusermedia) | Opening the camera. Already implemented; see [LLP 0002](./0002-getusermedia.spec.md). |
| `MediaStream`, `MediaStreamTrack` | [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/#mediastream) | Carrying the camera feed; see [LLP 0003](./0003-mediastream.spec.md). |
| `<Video srcObject>` | [HTML media srcObject](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject) | Showing the live preview; see [LLP 0004](./0004-htmlmediaelement-srcobject.spec.md). |
| `navigator.gpu`, `GPUAdapter`, `GPUDevice` | [WebGPU](https://www.w3.org/TR/webgpu/) | All rendering and compute. |
| WGSL | [WebGPU Shading Language](https://www.w3.org/TR/WGSL/) | All shader code, byte-identical to the browser samples it's adapted from. |
| `GPUCanvasContext` | [WebGPU](https://www.w3.org/TR/webgpu/#canvas-rendering) | Presenting to the screen via `react-native-wgpu`'s `Canvas`. |

Frame import is the one exception — see the next section.

## Non-spec bridge: camera frame → `GPUTexture`

Browser WebGPU imports video frames via `GPUDevice.importExternalTexture()`, which takes an `HTMLVideoElement`. On React Native there is no DOM video element with a hardware-backed surface, and `react-native-wgpu` does not implement `importExternalTexture` — instead it exposes `importSharedTextureMemory`, which takes a native pixel-surface handle (`CVPixelBuffer` on iOS, `AHardwareBuffer` on Android).

The bridge work is therefore:

1. The standard-camera module attaches an `AVCaptureVideoDataOutput` to the existing capture session and retains the latest `CVSampleBuffer` per video track.
2. A JS-callable method on `MediaStreamTrack` (or a sibling API; exact shape TBD in [LLP 0011](./0011-cvpixelbuffer-webgpu-bridge.decision.md)) returns a frame object whose `.handle` is the underlying `CVPixelBuffer` pointer and whose `.release()` returns ownership.
3. The demo JS feeds that handle into `device.importSharedTextureMemory({ handle })`, gets a `GPUTexture`, and samples it from WGSL.

The bridge is zero-copy: the `CVPixelBuffer` is `IOSurface`-backed, so Dawn imports it into a Metal texture without touching CPU memory. The pattern is exactly the one the official react-native-wgpu example uses for its built-in video player.

This is the *only* non-spec surface in any demo. Every line of shader code, every render pipeline, every sampling call is exactly what would run in a browser. The W3C purity story holds with a single asterisk, which [LLP 0011](./0011-cvpixelbuffer-webgpu-bridge.decision.md) explains.

## Demo catalog

### Demo 1: Rotating cube of cameras

**Pitch:** A 3D cube whose six faces all show the live camera, spinning on the Y axis (and pinch-to-rotate on touch).

**Why this demo.** It is a direct port of the canonical [`videoUploading`](https://webgpu.github.io/webgpu-samples/?sample=videoUploading) sample from the WebGPU samples repo, with the only material change being the texture source — `CVPixelBuffer` instead of an `HTMLVideoElement`. The render pipeline, the vertex layout, the WGSL shaders, and the math are unmodified. The pitch lands instantly: "every face is the camera, the cube is just spinning, and the shader code is what runs in any browser."

**UX.**

1. Open the demo from the Home tab.
2. Camera preview fills the screen for a beat, then dissolves into a 3D scene with the cube centered.
3. Cube auto-spins; one-finger drag tilts the camera; two-finger pinch zooms.
4. A small overlay reports adapter name and frame rate.

**Architecture.**

```
getUserMedia({ video: true })
   ↓
MediaStreamTrack (W3C) ──[ LLP 0011 bridge ]──→ frame.handle: CVPixelBuffer
   ↓                                                              ↓
<Video srcObject>      device.importSharedTextureMemory({ handle })
(idle, off-screen)              ↓
                         GPUTexture (zero-copy, IOSurface-backed)
                                ↓
                   bind group → WGSL fragment shader → cube faces
                                ↓
                       render pass → context.present()
```

**Status:** Not started. Foundation validated.

**Complexity:** Low. The WebGPU sample is ~200 lines of WGSL + ~150 lines of TS. Most of the work is plumbing.

### Demo 2: Shader playground

**Pitch:** The live camera, processed by a fragment shader you can switch between effects (kaleidoscope, edge-detect, posterize, sobel, mirror).

**Why this demo.** It is the most directly "Snapchat-lens-feels-like-this" demo — a full-screen image, transformed in real time, with the transformation user-selectable. Each effect is a ~30-line WGSL fragment shader. The cumulative payoff is high (multiple wow moments per session) and each individual shader is small enough that a new effect can be added in an hour.

**UX.**

1. Open the demo. Camera fills the screen, untransformed.
2. A horizontal scroller at the bottom shows effect chips: `none`, `kaleidoscope`, `edges`, `sobel`, `posterize`, `mirror`.
3. Tap a chip → fragment shader hot-swaps. Effect applies in real time.
4. Pinch to adjust the effect's primary parameter (kaleidoscope segment count, edge-detect threshold, etc.).

**Architecture.** Same data path as Demo 1 from `getUserMedia` through `GPUTexture`. The difference is the render target: a full-screen triangle (or quad) rather than a cube, and the fragment shader varies per effect.

**Status:** Not started. Built on top of Demo 1's plumbing.

**Complexity:** Low to medium. The first effect is the bulk of the work (sets up the full-screen pass, sample binding, parameter uniform buffer). Each additional effect is a small WGSL file plus a chip in the UI.

### Demo 3: MNIST on the camera (stretch)

**Pitch:** Point the phone at a hand-drawn digit. The classification appears in real time.

**Why this demo.** It is the most jaw-dropping payoff per byte of code if the foundation supports it: ML inference, on-device, running entirely in WGSL compute shaders, fed by the live camera, with no native ML stack involved. react-native-wgpu's example app already contains an `MNISTInference` demo using exactly this pattern; this LLP plans to adapt it.

**UX.**

1. Open the demo. Camera fills the screen.
2. A small "draw a digit on white paper" hint shows for the first three seconds.
3. As the camera sees a digit, a confidence-ranked top-3 classification overlay updates ~5 times per second.

**Architecture.** Same data path through `GPUTexture`. After upload, a compute shader downsamples to 28×28 grayscale; a second compute pass runs the MNIST inference (matrix-multiplications encoded as compute dispatches); a third pass produces softmax output; the result is read back to JS and rendered.

**Status:** Stretch. Tagged as v2 — we ship Demos 1 and 2 first, then tackle this once the foundation has shaken out.

**Complexity:** Medium-high. The inference pipeline itself is well-trodden territory (the react-native-wgpu sample exists), but it adds model-asset loading, a multi-pass compute pipeline, and a CPU readback. Worth the effort only if the simpler demos land cleanly.

## Build order

1. **Foundation** — `react-native-wgpu` installed, hello-triangle verified. ✅ done (LLP 0010 milestone 0).
2. **`SharedTextureMemory` spike with synthetic frames.** Port the official example, confirm `importSharedTextureMemory` → `createTexture` → `beginAccess` works on this iOS build with a fabricated `CVPixelBuffer`. Half day. Task #16.
3. **CVPixelBuffer bridge in standard-camera.** Add `AVCaptureVideoDataOutput`, expose handle, document the API in [LLP 0011](./0011-cvpixelbuffer-webgpu-bridge.decision.md). One to two days. Task #17.
4. **Demo 1: rotating cube of cameras.** One day. Task #18.
5. **Demo 2: shader playground.** Two days for the first three effects.
6. **Demo 3: MNIST.** Stretch — schedule only after Demos 1 and 2 land.

Total wall-clock to Demo 1 shipping: roughly four days from milestone 0, assuming no surprises.

## What "shipped" looks like, per demo

A demo is shipped when:

1. It runs end to end on iOS 18+ simulator and on a physical device at ≥ 30 fps.
2. It opens via a normal route (no deep-link gymnastics).
3. It has an `@ref LLP 0010#<demo-anchor>` comment in its entry file pointing at this LLP.
4. There is at least one ported WPT-style test (or, where no WPT analogue exists, a project-local test in `modules/standard-camera/src/testing/local/`) that exercises any new spec surface the demo introduces.
5. There is a screenshot in the README so the demo is discoverable without running the app.

## Out of scope (for now)

- **Three.js WebGPU mode** on react-native-wgpu — feasible (`react-native-webgpu-worklets` exposes the path) but adds an indirection that obscures the W3C purity story. Worth revisiting only if there is a specific three.js demo we want unmodified.
- **Multi-track / picture-in-picture** demos (e.g., front + back camera composited in the same WebGPU scene). Cool, but blocked on multi-track `getUserMedia` support which is not in the current spec subset; see [LLP 0001](./0001-spec-subset-scope.spec.md).
- **Audio reactive demos.** Audio capture is deferred to v2 of the camera module; see [LLP 0009](./0009-audio-ios-mapping.decision.md). Once audio lands, a "camera + Web Audio analyser → WGSL visualization" demo would be a natural addition.
- **WebGPU compute boids fed by camera pixels.** Tagged as a possible v3 demo; mentioned for posterity.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `SharedTextureMemory` on Dawn iOS doesn't accept arbitrary `CVPixelBuffer` formats (e.g., YUV `420v`) | Medium | High | Spike with synthetic BGRA buffer first; if it works, force `AVCaptureVideoDataOutput.videoSettings = { kCVPixelFormatType_32BGRA }` so the camera produces what Dawn accepts. |
| `react-native-wgpu`'s bundle size hurts cold start | Low | Low | Acceptable for a demo app; revisit if it ever matters in production. |
| Frame-rate target (≥ 30 fps) not met on simulator | Medium | Low | Simulator GPU is software-rasterized; benchmarks come from a real device. |
| Camera permission interaction with `react-native-wgpu`'s `Canvas` | Low | Low | Both use `AVCaptureSession` / `MTLDevice` independently; coexist by design. |
| `react-native-wgpu`'s next minor version breaks the `SharedTextureMemory` API shape | Low | Medium | Pin the exact minor (`0.5.x`); review on each upgrade. |

## Paths not taken

These were tried or seriously considered and rejected; recorded so future authors don't re-explore.

- **OpenCV.js doc scanner via WebAssembly.** Blocked by Hermes V1 not exposing a WebAssembly runtime. The Feb 2026 blog claims of "Hermes V1 + WASM" appear to be hallucinated — Hermes issue [#429](https://github.com/facebook/hermes/issues/429) is still open and the [official RN 0.84 release post](https://reactnative.dev/blog/2026/02/11/react-native-0.84) does not mention WebAssembly. Confirmed by symbol-dumping the shipped `hermesvm.framework`.
- **Building Hermes from source with WASM enabled.** No upstream commit exists to enable WASM in Hermes — the feature isn't implemented anywhere in the source tree, only requested.
- **JSC fallback for WASM.** RN 0.81+ dropped first-party JSC; `@react-native-community/javascriptcore` requires manual native-project wiring not worth the complexity for a demo.
- **`jsfeat` / `jsQR` pure-JS CV demo.** Viable but loses the "famous library" story, and WebGPU through `react-native-wgpu` ended up being a better fit for the same demo space.
- **three.js on `expo-gl`.** `expo-gl` provides WebGL 1 only on iOS; three.js dropped WebGL 1 support in r163 with a hard error at `WebGLRenderer` construction. Downgrading to three r162 is possible but the version is over a year stale and abandons the upgrade path. Pivoting to `react-native-wgpu` is cleaner.
- **`react-native-webassembly` / `react-native-wasm` JSI polyfills.** A reasonable next step if WASM specifically were required for a future demo. Not blocked, just not needed for the current plan.

Each rejection above is captured here, not in code comments, because the value is in *not exploring them again*. If a future change of conditions makes one viable, this LLP should be updated rather than the alternative quietly re-tried.
