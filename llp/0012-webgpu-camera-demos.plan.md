# LLP 0012: WebGPU camera demos

**Type:** Plan
**Status:** Active
**Systems:** standard-camera, demo
**Author:** James Ide
**Date:** 2026-05-23
**Related:** 0000, 0002, 0003, 0004, 0005, 0008, 0009

## Summary

This LLP plans a small catalog of visceral, W3C-pure demos that sit on top of the standard-camera module and make the project's spec-compliance thesis concrete. The thesis is that "if our camera surface matches the W3C `MediaStream` / `getUserMedia` shape, browser-shaped code can run on iOS through it." The demos in this plan are chosen so the only library code that does anything camera-specific is the standard-camera module itself — everything else (rendering, shading, compute) goes through other W3C-defined surfaces, primarily WebGPU and WGSL.

Each demo is small, ships on its own, and uses only one custom bridge: a way to expose the camera's `CVPixelBuffer` to WebGPU's `importSharedTextureMemory`. This LLP catalogues what the demos do and the order to build them in; the bridge itself remains an open follow-up captured under "Non-spec bridge" and "Build order" below.

## Goals

- **Showcase W3C compliance viscerally.** The user sees the live camera being processed through standard browser APIs (WebGPU, WGSL) in real time. The "wait, that's the actual camera flowing through unmodified browser code" moment is the demo.
- **Make the project's value clear in under 30 seconds.** A first-time viewer should understand the pitch ("browser code, on iOS, through our camera") without needing the README.
- **Exercise the spec, not just decorate it.** Each demo uses the standard `MediaStream` / `MediaStreamTrack` / `<Video srcObject>` surface defined in [LLP 0003](./0003-getusermedia.spec.md), [LLP 0004](./0004-mediastream.spec.md), and [LLP 0005](./0005-htmlmediaelement-srcobject.spec.md) — discovering and exercising gaps where they exist.

## Non-goals

- **Not a replacement for `expo-camera` or `react-native-vision-camera`.** Those are general-purpose camera UIs. The demos here exist to validate the spec surface, not to ship a product feature.
- **Not a WebGPU teaching surface.** The shaders and pipelines are kept minimal so the camera-as-W3C-source story is what stands out.
- **No native ML, no native CV.** The whole point is browser-shaped code. If a demo needs ML, it runs through WebGPU compute shaders or a WebGPU-backed JS ML library, not through a native Core ML / Vision pipeline.

## The pitch (one line per demo)

| Demo | One-line pitch |
|---|---|
| Rotating cube of cameras | A spinning cube, every face is the live camera, all in WGSL — a direct port of the [WebGPU samples' `videoUploading`](https://webgpu.github.io/webgpu-samples/?sample=videoUploading) demo. |
| Shader playground | Live camera processed by a swappable fragment shader (kaleidoscope, edge-detect, posterize, sobel) — Snapchat-lens feel without a single line of native CV code. |
| Tiny WebGPU classifier | A camera-fed classifier implemented directly in WGSL compute shaders — proves local AI inference without ONNX, Transformers.js, or WebAssembly. |
| TensorFlow.js object lens | A TFJS WebGPU runtime probe loads a bundled COCO-SSD graph, detects objects in camera/probe tensors, and draws boxes without WASM or native ML. |
| MNIST on the camera (stretch) | Point the phone at a hand-drawn digit, read the classification. ML inference in WGSL compute shaders, model weights downloaded as a `.safetensors`-class blob, all browser-shaped. |
| LFM2-VL video captioning (research) | A live camera feed captioned by a Transformers.js vision-language model on WebGPU — compelling, but blocked in Expo until the WebGPU model runtime can run without WebAssembly. |

## Demo catalog route

The Demo tab should open to a catalog, not directly to one showcase. The point is to keep the existing cube demo available while making room for candidate demos as they are explored. A demo card may point to a shipped demo, a low-level foundation probe, or a candidate route that records what has been verified and what remains blocked.

The catalog route is intentionally part of the demo app rather than README-only documentation: the person holding the phone should be able to choose the story they want to tell in the moment without rebuilding the app.

## Universal demo routes

The main demo routes are shared across platforms. There should not be
`.web.tsx` variants for `cube`, `shader-lens`, `signals`, `neural`, or
`lidar-depth-webxr`; a developer reading a demo route should see the
browser-shaped application code that the repo is trying to prove out.

Small platform-specific helpers are acceptable where the host runtime genuinely
differs. For example, Expo Web should use the browser's own
`navigator.mediaDevices`, `ImageCapture`, `navigator.gpu`, and `navigator.xr`
surfaces, while iOS should provide those same API shapes through the local
module and through `react-native-wgpu`. UI affordances may also sit behind
platform helpers when a route wants SwiftUI controls on iOS and React Native
Web controls in the browser.

The important boundary is that platform-specific code implements or adapts a
web API surface; it must not become a separate demo. Web routes should not
import `NativeStandardCamera`, and universal demo routes should not reach into
iOS-only backdoor APIs. Native-only capabilities such as LiDAR scene depth can
render as unsupported on browsers that do not expose the matching WebXR
features.

## Global camera controls

Demo route Start/Stop controls are owned by the demo stack layout, not by each
screen body. The `CameraContext` exposes a global hardware phase (`stopped`,
`starting`, `started`, `stopping`) derived from the shared `getUserMedia`
stream and from the native LiDAR/ARKit extension. That lets the navigation bar
render the correct control immediately during a route push, before the demo
screen has mounted and before any per-screen WebGPU state has initialized.

The LiDAR route is part of this same control plane even though it is not a W3C
camera demo: ARKit and the AVFoundation session behind `getUserMedia` compete
for the same iOS camera hardware. Starting LiDAR first tears down and locks out
the standard camera; stopping LiDAR releases that lock so a focused
standard-camera route can resume only when the user had not explicitly stopped
it. Native tabs and stacks may keep screens mounted after navigation, so camera
demo auto-start effects must be focus-scoped and must not reacquire AVFoundation
while a WebXR/LiDAR route is the visible route.

Visible `<Video srcObject>` previews are focus-scoped for the same reason:
inactive tabs may remain mounted, but they should detach their native preview
layer so the focused route is the only live preview consumer of the shared
`MediaStream`. When the Home tab regains focus it reattaches `null → stream`
instead of relying on a stale offscreen native view. Home also keys its native
preview by a focus serial so a tab return creates a fresh native `<Video>` view
even when the shared `MediaStream` object itself has not changed. Home waits a
short focus-settle window before preview reattachment or auto-start so the iOS
native tab animation is not sharing its first frames with AVFoundation preview
startup work.

## Frame-bound demo mirroring

Front-camera previews are mirrored for self-view, but the WebGPU demos must
bind that mirror flag to the frame texture being displayed rather than to the
currently requested camera constraint. During a front/back switch the UI
selection and stored constraints can update before the next stream has
delivered pixels. If the shader mirror flag follows the request immediately,
the old texture visibly flips for a few frames before the new camera appears.

The demo render loops therefore store mirror state beside the currently bound
camera texture, and update both only when a camera frame is successfully
accepted from `ImageCapture.grabFrame()` for upload. The facing mode comes from
that frame's track settings. On web, a missing `settings.facingMode` still
follows LLP 0009's self-view convention; on native iOS, AVFoundation-backed
tracks report the concrete front/back mode.

On native iOS, the first frame from a newly selected camera can be a transient
exposure/settling frame. The demo routes avoid native frame diagnostics here:
when an `ImageCapture` is rebound to a replacement track, the render loop keeps
the previously bound texture for a short timer window before accepting
`grabFrame()` output from the new capture object. That uses only the
browser-shaped APIs already in the demo (`MediaStreamTrack.getSettings()`,
`ImageCapture.grabFrame()`, `ImageBitmap.close()`, timers, and WebGPU) while
avoiding the dark startup frame during front/back switches.

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
| `navigator.mediaDevices.getUserMedia` | [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/#dom-mediadevices-getusermedia) | Opening the camera. Already implemented; see [LLP 0003](./0003-getusermedia.spec.md). |
| `MediaStream`, `MediaStreamTrack` | [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/#mediastream) | Carrying the camera feed; see [LLP 0004](./0004-mediastream.spec.md). |
| `<Video srcObject>` | [HTML media srcObject](https://html.spec.whatwg.org/multipage/media.html#dom-media-srcobject) | Showing the live preview; see [LLP 0005](./0005-htmlmediaelement-srcobject.spec.md). |
| `navigator.gpu`, `GPUAdapter`, `GPUDevice` | [WebGPU](https://www.w3.org/TR/webgpu/) | All rendering and compute. |
| WGSL | [WebGPU Shading Language](https://www.w3.org/TR/WGSL/) | All shader code, byte-identical to the browser samples it's adapted from. |
| `GPUCanvasContext` | [WebGPU](https://www.w3.org/TR/webgpu/#canvas-rendering) | Presenting to the screen via `react-native-wgpu`'s `Canvas`. |

Frame import is the one exception — see the next section.

## Non-spec bridge: camera frame → `GPUTexture`

Browser WebGPU imports video frames via `GPUDevice.importExternalTexture()`, which takes an `HTMLVideoElement`. On React Native there is no DOM video element with a hardware-backed surface, and `react-native-wgpu` does not implement `importExternalTexture` — instead it exposes `importSharedTextureMemory`, which takes a native pixel-surface handle (`CVPixelBuffer` on iOS, `AHardwareBuffer` on Android).

The bridge work is therefore:

1. The standard-camera module attaches an `AVCaptureVideoDataOutput` to the existing capture session and retains the latest `CVSampleBuffer` per video track.
2. A JS-callable method on `MediaStreamTrack` (or a sibling API; exact shape still open) returns a frame object whose `.handle` is the underlying `CVPixelBuffer` pointer and whose `.release()` returns ownership.
3. The demo JS feeds that handle into `device.importSharedTextureMemory({ handle })`, gets a `GPUTexture`, and samples it from WGSL.

The bridge is zero-copy: the `CVPixelBuffer` is `IOSurface`-backed, so Dawn imports it into a Metal texture without touching CPU memory. The pattern is exactly the one the official react-native-wgpu example uses for its built-in video player.

This is the *only* non-spec surface in any demo. Every line of shader code, every render pipeline, every sampling call is exactly what would run in a browser. The W3C purity story holds with a single asterisk, which the "Non-spec bridge" section above explains.

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

**Status:** First version implemented. The route uses a demo-sized 640×480 @ 30 fps capture profile, uploads camera frames through the same `ImageCapture.grabFrame()` byte path as the cube demo at a 30 fps target cadence, then samples the texture from WGSL with selectable effects: original, posterize, edges, heat, and kaleidoscope. It has a synthetic fallback when no camera frame is available.

**Complexity:** Low to medium. The first effect is the bulk of the work (sets up the full-screen pass, sample binding, parameter uniform buffer). Each additional effect is a small WGSL file plus a chip in the UI.

### Demo 3: Tiny WebGPU classifier

**Pitch:** A small camera-fed classifier runs entirely in WGSL compute. It samples the live camera texture and reports the top label beside the preview without loading any WebAssembly-backed ML runtime.

**Why this demo.** It answers the no-WASM AI question directly. ONNX Runtime WebGPU and Transformers.js are blocked by their WebAssembly layer in Hermes, but WebGPU compute itself works. This demo keeps the AI scope intentionally tiny so the runtime story is true: JavaScript orchestrates WebGPU, WGSL does inference, and JS reads back only final scores.

**UX.**

1. Open the demo. The camera preview appears unfiltered; the current class is reported outside the image.
2. A prediction panel shows the top scene label and per-label evidence bars.
3. Back/front controls reuse the same camera constraint path as the other demos.
4. On simulators with no camera, an animated synthetic texture keeps the inference path visible.

**Architecture.** Same camera upload path as Demo 2. After upload, a compute pass samples a 24×18 grid from the `GPUTexture`, computes simple image features, and writes calibrated heuristic evidence scores into a storage buffer. A `MAP_READ` buffer copies back only a small fixed float vector: per-label scores plus feature readouts and secondary scene probes.

**Status:** First version implemented as `signals`. It prefers a 1280×720 @ 30 fps preview profile, then retries once with a relaxed camera request if real frames do not arrive. Camera texture uploads target 30 fps; the compute classifier runs at a lower cadence so GPU readback does not block visual rendering. The classifier distinguishes covered-lens/no-visible-scene, indoor, outdoor, mixed/window, exposure, color temperature, and texture/detail states. The indoor/outdoor path is still deliberately not a PlacesCNN-class semantic model: it is a layout-aware WGSL scorer over a 24×18 camera grid, combining top-of-frame sky evidence, lower-frame vegetation, horizon/openness, rectilinear structure, warm indoor lighting, and low-texture ceiling/window cues. It is more robust than average-color thresholds, but scenes without those visible cues still need a real trained scene classifier. It is deliberately not a VLM and does not claim semantic understanding, people detection, or emotion recognition; it is a tiny no-WASM inference proof point.

**Next ML direction:** Do not add another "human cue" heuristic. A people/face signal needs a real detector before it is user-facing. There are now two viable no-WASM branches to validate: a hand-ported WebGPU/WGSL detector for full control over camera texture flow, and a TensorFlow.js WebGPU branch for model-runtime leverage when the model accepts tensors directly. Browser ML runtimes that depend on a WebAssembly layer remain out of scope under Hermes V1.

**Complexity:** Low. No model download, no tokenizer, no runtime dependency. The main risk is GPU buffer readback support in `react-native-wgpu`, which is validated by the route smoke test.

### Demo 4: MNIST on the camera (stretch)

**Pitch:** Point the phone at a hand-drawn digit. The classification appears in real time.

**Why this demo.** It is the most jaw-dropping payoff per byte of code if the foundation supports it: ML inference, on-device, running entirely in WGSL compute shaders, fed by the live camera, with no native ML stack involved. react-native-wgpu's example app already contains an `MNISTInference` demo using exactly this pattern; this LLP plans to adapt it.

**UX.**

1. Open the demo. Camera fills the screen.
2. A small "draw a digit on white paper" hint shows for the first three seconds.
3. As the camera sees a digit, a confidence-ranked top-3 classification overlay updates ~5 times per second.

**Architecture.** Same data path through `GPUTexture`. After upload, a compute shader downsamples to 28×28 grayscale; a second compute pass runs the MNIST inference (matrix-multiplications encoded as compute dispatches); a third pass produces softmax output; the result is read back to JS and rendered.

**Status:** Stretch. Tagged as v2 — we ship Demos 1 and 2 first, then tackle this once the foundation has shaken out.

**Complexity:** Medium-high. The inference pipeline itself is well-trodden territory (the react-native-wgpu sample exists), but it adds model-asset loading, a multi-pass compute pipeline, and a CPU readback. Worth the effort only if the simpler demos land cleanly.

### Demo 5: LFM2-VL video captioning (candidate)

**Pitch:** The live camera is fed into a local vision-language model that answers prompts about the current frame. This is the most legible "web APIs on Expo" story because the original browser demo is already an app-shaped experience, not a graphics sample.

**Source demo.** The [LiquidAI/LFM2-VL-WebGPU](https://huggingface.co/spaces/LiquidAI/LFM2-VL-WebGPU) Space uses `navigator.mediaDevices.getUserMedia({ video: { facingMode, width, height } })`, assigns the resulting `MediaStream` to `video.srcObject`, captures frames through a canvas with `getImageData`, wraps the frame in `RawImage`, and runs `AutoModelForImageTextToText.from_pretrained("onnx-community/LFM2-VL-450M-ONNX", { device: "webgpu", ... })` through Transformers.js.

**Why this demo.** The code shape is the product argument:

```
getUserMedia()
   ↓
video.srcObject = stream
   ↓
canvas.getImageData()
   ↓
RawImage(frame)
   ↓
Transformers.js model.generate({ device: "webgpu" })
```

On Expo, the camera and WebGPU pieces already exist. The known adaptation is the frame extraction step: use the standard-camera `ImageCapture(track).grabFrame()` path while React Native lacks a DOM canvas/video pair. The target shape is:

```
navigator.mediaDevices.getUserMedia()
   ↓
<Video srcObject>
   ↓
ImageCapture(track).grabFrame()
   ↓
RawImage(frame)
   ↓
same Transformers.js WebGPU model path
```

**Status:** Research only. The source demo remains useful as a north star, but it should not be exposed as a local selectable route until the runtime issue is solved: Transformers.js' WebGPU backend currently ships through `onnxruntime-web`, whose JSEP/WebGPU build still includes a WebAssembly layer. Hermes V1 in this app does not expose WebAssembly.

**Risks to verify before calling it shipped.**

- Transformers.js v4 next and its WebGPU backend must run under Hermes V1 without falling back to WebAssembly.
- Model file download, caching, and streaming generation must work in the Expo runtime without DOM storage assumptions.
- The standard-camera BGRA frame bytes may need conversion before `RawImage` ingestion, depending on the Transformers.js image processor expectations.
- Model startup time and memory footprint need physical-device validation; simulator results are not enough.

### Demo 6: TensorFlow.js object lens

**Pitch:** TensorFlow.js loads a bundled COCO-SSD model, runs the graph on WebGPU, and overlays object boxes plus a simple object-derived scene summary on camera frames.

**Why this demo.** The WGSL classifier proves the lowest-level no-WASM path, but it is not a trained semantic model. TensorFlow.js is the most practical browser-shaped model runtime to spike because its WebGPU backend can run without the ONNX Runtime / Transformers.js WebAssembly layer that Hermes V1 does not provide. A whole-image ImageNet classifier was too brittle for the demo: the nature probe could become "daisy" because MobileNet had no "sunflower" scene label. COCO-SSD is still not Places365 scene recognition, but object detections with boxes are much easier for users to verify on live camera frames.

**UX.**

1. Open the demo from the catalog.
2. The standard camera starts by default and the route shows the same Start/Stop affordance and stopped-camera placeholder as the other standard-camera demos.
3. The route loads TFJS, initializes the WebGPU backend, loads the bundled COCO-SSD graph once, captures a low-cadence `ImageCapture.grabFrame()` tensor, and overlays object boxes and confidence bars.
4. Switching to a static probe immediately shows the probe image, then animates in detections when the detector finishes. Switching probes reuses the loaded model and cached decoded probe tensors.
5. For simulator smoke tests without a camera, `neural?source=workspace` opens directly on a deterministic probe while the normal route still defaults to camera.

**Architecture.**

```
camera frame or bundled/static JPEG probe
   ↓
direct downsample to <=320px edge Int32 tensor
   ↓
@tensorflow/tfjs-converter loadGraphModel(tf.io.fromMemory)
   ↓
@tensorflow/tfjs-backend-webgpu
   ↓
bundled ssdlite_mobilenet_v2 COCO-SSD graph + local weight shards
   ↓
COCO object boxes + scores
   ↓
animated boxes/confidence bars + object-derived scene summary
```

**Status:** Prototype implemented as `neural`, and the UI labels it "Neural lens" because this route runs an actual TensorFlow.js model. The route defaults to camera, supports front/back constraints, retains static probes for deterministic testing, and exposes `globalThis.__TFJS_SCENE_SMOKE__` / `TFJS_SCENE_SMOKE ...` for existing smoke checks. The model JSON and five weight shards are vendored under `assets/models/coco-ssd-lite-mobilenet-v2`; Metro treats `.bin` files as assets for JS/export, and iOS has a small build phase that copies the same directory into app resources under `TfjsModels/coco-ssd-lite-mobilenet-v2`. The detector module keeps route import cheap by deferring the large model JSON, shard asset IDs, and COCO class metadata `require()` calls until model loading or detection post-processing. The loader checks `Paths.bundle` first on native, falls back to Metro/`expo-asset`, and feeds the concatenated shards into `tf.io.fromMemory`. The model/runtime promises are module-level caches, the route defers camera-source preload until the selected camera has been playing quietly for a short window, surfaces runtime/weights/graph/warmup phases through the HUD and loading overlay, and yields between large startup chunks so React can repaint while TFJS starts. Weight concatenation now copies in 1MB chunks with UI yields, and live camera tensors are sampled in small row batches with abort checks so JS byte loops do not monopolize the UI thread. Probe tensors are cached per probe, route query `source=<probe>` is an initial no-camera simulator smoke-test value rather than a controlled source, and inference runs about once per second so the live `<Video srcObject>` preview remains responsive. Front/back camera switches abort pending pre-inference work, clear stale boxes, wait only for replacement `ImageCapture` readiness, and prevent the camera detection loop from starting TFJS loading until the cached model is ready or retrying from an error; this keeps camera reconfiguration from racing the heavy TensorFlow.js startup path without a fixed switch delay. Development traces are opt-in: set `globalThis.__NEURAL_LENS_TRACE_ENABLED__ = true`, `EXPO_PUBLIC_NEURAL_LENS_TRACE=1`, or `NEURAL_LENS_TRACE=1` for JS traces, and `STANDARD_CAMERA_TRACE=1` for native app launch traces. When enabled, `NEURAL_LENS_TRACE` JSON lines are mirrored into `globalThis.__NEURAL_LENS_TRACE__` across picker taps, shared camera restarts, native `AVCaptureSession.startRunning()` / `stopRunning()`, native preview attach/detach, model load phases, weight reads, tensor creation, and graph/NMS execution so front/back switch stalls can be attributed from device logs. Neural front/back switches also attach a route-local `switchId` plus `switchElapsedMs` to camera state, ImageCapture, first-frame, and first-detection milestones so one switch can be reconstructed even when model traces interleave.

**Complexity:** Medium. The app now depends on TFJS, TFJS Converter, `expo-asset`, `jpeg-js`, and COCO-SSD's class metadata. COCO-SSD still performs post-processing / NMS on CPU, so this is not an all-GPU detector. The demo mitigates that by downsampling before tensor creation, using async tensor reads, spacing camera inference to roughly 1 Hz, and keeping camera preview on the native video view rather than redrawing it through JS.

On focus, the camera detector waits briefly before its first TFJS pass even
when the model cache is already ready. That keeps native tab activation and
`<Video srcObject>` reattachment responsive; it does not reset the
module-level runtime/model/weight caches.

Blur/focus traces record the current Neural detector stage, preview
reattachment timing, and screen cleanup timing. The native tab host's
`tabPress` event also asks the route to stop Neural TF work before the route
blur effect runs. Deferred model preload timers observe the same focused flag
so leaving the tab cannot start a queued preload. Active preloads also share
the route abort controller with camera and probe inference; the loader checks
that signal while reading bundled weight shards, before concatenating weights,
before converter/graph work, and before warmup. The detector checks the same
abort signal after graph execution, output tensor readback, and NMS so a tab
switch can skip the remaining post-processing for an in-flight detection. The
underlying TFJS graph call is still not preemptible once it has entered the
runtime, so traces distinguish `tfjs-graph` from later abortable stages.

Front/back switches are readiness-based: once the replacement stream reaches
`playing`, the loop waits for `ImageCapture`'s short frame-settle window and
then probes `grabFrame()`, retrying transient "No frames available" results
instead of sleeping behind a fixed classifier pause. The camera detector uses a
256 px max edge for live frames to reduce the JS sampling loop and graph input
size; static probes keep the same preprocessing path.

## Build order

1. **Foundation** — `react-native-wgpu` installed, hello-triangle verified. ✅ done (LLP 0012 milestone 0).
2. **Demo catalog route.** Keep the existing cube demo and expose candidate demos from a chooser. ✅ done.
3. **Demo 2: shader playground.** ✅ First version implemented: selectable WGSL effects on the live camera stream without WASM.
4. **Demo 3: tiny WebGPU classifier.** ✅ First version implemented: no-WASM WGSL compute scores on the live camera texture.
5. **Demo 6: TensorFlow.js object lens.** Prototype implemented with bundled COCO-SSD on TFJS WebGPU; simulator and web smoke validation must stay attached to this route while the runtime is still a spike.
6. **LFM2-VL research.** Keep as research until a WebGPU VLM runtime runs under Hermes without WebAssembly.
7. **`SharedTextureMemory` spike with synthetic frames.** Port the official example, confirm `importSharedTextureMemory` → `createTexture` → `beginAccess` works on this iOS build with a fabricated `CVPixelBuffer`. Half day. Task #16.
8. **CVPixelBuffer bridge in standard-camera.** Add `AVCaptureVideoDataOutput`, expose handle, and decide the API shape in a follow-up LLP at that time. One to two days. Task #17.
9. **Demo 1: rotating cube of cameras.** One day. Task #18.
10. **Demo 4: MNIST.** Stretch — schedule only after simpler demos land.

Total wall-clock to Demo 1 shipping: roughly four days from milestone 0, assuming no surprises.

## Performance instrumentation

The first shipped routes still use the interim CPU-byte bridge:
`ImageCapture.grabFrame()` copies the latest `CVPixelBuffer` into tight-packed
BGRA bytes, and JS uploads those bytes with `device.queue.writeTexture()`. This
keeps the W3C-shaped demo surface working before LLP 0011's zero-copy
`SharedTextureMemory` bridge exists, but it is not the intended final fast path.

The demo routes emit structured `WEBGPU_DEMO_PROFILE` records in development
builds. Records include render frame rate, camera/synthetic upload counts,
uploaded bytes, native `grabFrame()` time, `writeTexture()` enqueue time, and
render submit/present timing. They are sent both to `console.log` and to the
native system-log hook so simulator runs can be inspected with `simctl log` even
when the Metro terminal UI is not attached.

Render loops are route-focus scoped with Expo Router's `useFocusEffect`. Stack
screens remain mounted when another demo is pushed, and leaving a hidden WebGPU
canvas running in the background makes the foreground demo look artificially
slow. Losing focus cancels the animation frame and destroys the route's GPU
resources; returning to the route creates a fresh pipeline.

Current upload targets:

- `shader-lens`: upload at 30 fps, render every animation frame.
- `signals`: upload at 30 fps, render every animation frame, run inference
  readback at a lower cadence.
- `cube`: upload at 30 fps, render every animation frame with the latest
  uploaded texture.

If physical-device profiling shows `grabFrame()` or per-frame byte upload
dominating, the fix is not more WGSL tuning; it is the LLP 0011 zero-copy bridge
so WebGPU samples the IOSurface-backed camera texture directly.

## What "shipped" looks like, per demo

A demo is shipped when:

1. It runs end to end on iOS 18+ simulator and on a physical device at ≥ 30 fps.
2. It opens via a normal route (no deep-link gymnastics).
3. It has an `@ref LLP 0012#<demo-anchor>` comment in its entry file pointing at this LLP.
4. There is at least one ported WPT-style test (or, where no WPT analogue exists, a project-local test in `modules/standard-camera/src/testing/local/`) that exercises any new spec surface the demo introduces.
5. There is a screenshot in the README so the demo is discoverable without running the app.

## Out of scope (for now)

- **Three.js WebGPU mode** on react-native-wgpu — feasible (`react-native-webgpu-worklets` exposes the path) but adds an indirection that obscures the W3C purity story. Worth revisiting only if there is a specific three.js demo we want unmodified.
- **Multi-track / picture-in-picture** demos (e.g., front + back camera composited in the same WebGPU scene). Cool, but blocked on multi-track `getUserMedia` support which is not in the current spec subset; see [LLP 0002](./0002-spec-subset-scope.spec.md).
- **Audio reactive demos.** Audio capture now lands in v1 ([LLP 0008](./0008-audio-ios-mapping.decision.md)), so a "camera + Web Audio analyser → WGSL visualization" demo would be a natural addition.
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
