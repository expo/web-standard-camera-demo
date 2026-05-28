# LLP 0012: LiDAR WebGPU depth demo

**Type:** Plan
**Status:** Active
**Systems:** demo, standard-camera-native-extension
**Author:** James Ide
**Date:** 2026-05-24
**Related:** 0000, 0001, 0010, 0013, 0014, 0015, 0016, 0017, 0018

## Summary

This LLP documents a deliberately non-W3C demo that combines a native iOS-only
mobile capability with browser-shaped rendering code: ARKit provides paired
camera and LiDAR scene-depth frames, and WebGPU/WGSL turns those frames into a
live camera/depth comparison visualization.

The point is different from LLP 0010. The WebGPU camera demos prove that a
small W3C camera surface can make browser-shaped code run on iOS. This demo
shows the complementary story: native mobile sensors can expose data the web
does not standardize today, while the visualization, animation, and GPU
processing can still live in web-shaped WebGPU code.

## Standards positioning

**Decision:** do not extend this repo's `getUserMedia` implementation to expose
LiDAR/depth as a W3C camera feature. The connection is real enough to explain,
but not strong enough to justify adding depth tracks to the v1 Media Capture
subset. A full WebXR depth implementation is also not the right next step for
this repo; it would be a separate XR runtime project rather than evidence that
ordinary web camera code runs in Expo.

The product story should be: implementing the web camera API on native lets
portable browser-shaped RGB camera code run in Expo; when a platform has extra
sensor data the web does not standardize today, the app can pair that portable
camera surface with a narrow native extension rather than pretending the native
sensor is already part of the web platform.

### Media Capture Depth history

There is a meaningful historical connection to `getUserMedia`: the W3C Media
Capture Depth Stream Extensions draft proposed depth-capable media streams,
including a `videoKind` constrainable property with `"color"` and `"depth"`
values. That work was published as a Discontinued Draft in 2022 because the
working group saw too little implementation momentum, so this repo should cite
it only as abandoned work, not as current web-platform behavior.

The final draft's shape was not a new `MediaStreamTrack.kind === "depth"`.
Instead, it treated depth as a video-like source selected through the
constrainable property `videoKind`, with examples like:

```js
await navigator.mediaDevices.getUserMedia({
  video: { videoKind: { exact: "depth" } },
});
```

The draft also showed requesting a color stream and a depth stream from the same
`groupId` so authors could pair the two. This was an evolution from the older
2015 working-draft shape that had `depth: true` constraints and
`stream.getDepthTracks()`.

The scoped source slices for the final discontinued draft live in
[LLP 0018](./0018-mediacapture-depth-spec-slices.spec.md).

Primary sources:

- W3C discontinued-draft announcement:
  https://www.w3.org/news/2022/media-capture-depth-stream-extensions-published-as-a-discontinued-draft/
- Final editor's draft with `videoKind`:
  https://w3c.github.io/mediacapture-depth/
- Older 2015 working draft with `depth: true`:
  https://w3c.github.io/mediacapture-depth/releases/WD2.html

### Why it stalled

The official reason is "lack of implementation momentum." The archived issue
tracker suggests why the API surface never hardened:

- Depth needed more than camera-style constraints. Open issue #174 asked to
  re-add camera/depth intrinsics and related mobile camera metadata. That is a
  sign that a useful depth API needs geometry data, not only a stream.
- Accurate reprojection still had unresolved semantics. Issue #80 discussed
  whether depth values were measured along the optical axis or optical ray, and
  whether that should be a constraint or fixed by spec.
- Recording and still capture were unclear. Issue #173 noted
  `MediaRecorder`/`ImageCapture.takePhoto()` producing empty depth blobs, and a
  maintainer observed that the platform lacked a standard web-compatible image
  format for 16-bit depth.
- WebXR alignment was already visible. Issue #167 asked whether the Media
  Capture depth transform naming should align with WebXR.
- The draft had already struggled in candidate-review preparation in 2016:
  issue #133 recorded a reviewer saying it was not ready for broad review.

Inference: the draft did not fail because the JavaScript spelling was bad. It
failed because depth capture crosses into geometry, calibration, precision,
encoding, privacy, and GPU/CPU access semantics that were not converging across
independent implementations.

### Merit in implementing `videoKind: "depth"`

There is some merit in showing it as standards archaeology: "here is the
abandoned web shape, implemented experimentally on one native platform." That
could be useful in a comparison screen or research note.

There is little merit in presenting it as part of this repo's W3C camera API
implementation:

- It would not demonstrate portable browser code, because current browsers do
  not expose the discontinued draft as a dependable API.
- It would expand the test surface beyond this repo's WPT-backed Media Capture
  subset into an abandoned draft with no maintained conformance story.
- A convincing implementation would need the unsettled pieces above:
  calibration metadata, RGB/depth alignment, units, invalid/confidence pixels,
  and GPU/CPU transfer semantics.

If this app ever implements the `videoKind: "depth"` spelling, it should be a
disabled-by-default experiment over the existing native LiDAR source, labeled as
"Discontinued Media Capture Depth draft", not a default `standard-camera`
feature.

### WebXR depth

WebXR depth sensing is the active standards-family direction for XR sessions,
but adopting WebXR would pull in XR session lifecycle, pose spaces, permissions,
and rendering semantics that are intentionally outside this repo's tiny
`getUserMedia` experiment.

WebXR depth is technically the better standards model for AR depth. It defines a
`depth-sensing` session feature, raw vs. smooth depth, CPU vs. GPU usage,
`float32`/`unsigned-short`/packed formats, transforms from view coordinates to
depth buffer coordinates, `getDepthInMeters()`, and privacy guidance for
limiting or blocking detailed scene geometry.

It is still not the better implementation target for this repo right now:

- The app would need a meaningful subset of `navigator.xr`, `XRSession`,
  `XRFrame`, `XRView`, reference spaces, poses/projection matrices, and an XR
  render loop before the depth module is honest.
- The WebXR depth module is specified around WebGL bindings and
  `XRWebGLDepthInformation`; this demo is intentionally WebGPU/WGSL.
- Implementing WebXR would no longer show "benefits of implementing the W3C
  camera API." It would show "Expo can host an iOS WebXR-style runtime," which
  is a different and much larger project.

Primary source:

- W3C WebXR Depth Sensing Module:
  https://www.w3.org/TR/webxr-depth-sensing-1/

### WebXR surface for this demo only

If we ignore general WebXR ambitions and evaluate only the current LiDAR Depth
Studio demo, the demo needs a much smaller functional surface:

The full proposed WebXR-shaped API surface is specified in
[LLP 0013](./0013-webxr-lidar-depth-api.spec.md). This section is the short
evaluation summary for the current demo.

1. A user-triggered start/stop for an exclusive AR camera session.
2. A support check that distinguishes simulator, non-LiDAR devices, and LiDAR
   devices.
3. A per-frame camera image aligned with the view shown on screen.
4. A per-frame depth buffer aligned with that camera image.
5. Depth values in meters, preferably `float32`, with invalid pixels represented
   as `0`.
6. A mapping from screen/view coordinates to depth-buffer coordinates.
7. Enough CPU access to sample center depth and compute the closer-than-target
   readout.
8. Enough GPU access to upload camera and depth data into WebGPU textures.

The demo does not need the following WebXR features: controller/input sources,
hit testing, anchors, planes, mesh reconstruction, bounded spaces, stereo/multi-
view rendering, DOM overlays, WebXR layers, or world-space UI.

The smallest WebXR-shaped API that resembles the current demo would look like:

```ts
const supported = await navigator.xr.isSessionSupported("immersive-ar");
const session = await navigator.xr.requestSession("immersive-ar", {
  requiredFeatures: ["depth-sensing", "camera-access"],
  depthSensing: {
    usagePreference: ["cpu-optimized"],
    dataFormatPreference: ["float32"],
    depthTypeRequest: ["smooth", "raw"],
    matchDepthView: true,
  },
});
const referenceSpace = await session.requestReferenceSpace("viewer");
session.requestAnimationFrame((time, frame) => {
  const pose = frame.getViewerPose(referenceSpace);
  const view = pose?.views[0];
  if (!view) return;
  const depth = frame.getDepthInformation(view); // XRCPUDepthInformation
  const center = depth?.getDepthInMeters(0.5, 0.5) ?? 0;
});
```

This standalone viewer requests `"smooth"` depth before `"raw"` because its
Depth mode is a visual inspection surface where spatial stability matters more
than current-frame delivery. Panorama capture keeps a separate raw-first session
request because its keyframe pipeline is more sensitive to smoothed-depth lag.

That surface is useful as design vocabulary, but it is not enough to implement
the existing WebGPU demo with only standardized WebXR APIs:

- WebXR Depth Sensing has a CPU path (`XRCPUDepthInformation.data`) that maps
  well to the current `Float32Array` upload into `r32float`.
- The WebXR GPU depth path is explicitly `XRWebGLDepthInformation` through
  `XRWebGLBinding`, while this demo is intentionally `react-native-wgpu` +
  WGSL.
- Raw camera pixels are not part of the WebXR AR module itself. They come from
  the separate WebXR Raw Camera Access Community Group draft via
  `view.camera` and `XRWebGLBinding.getCameraImage(camera)`, again as an opaque
  WebGL texture.
- The AR module says immersive AR compositing must not automatically grant
  camera streams, intrinsics, real-world geometry, or similar information; the
  page must request those features explicitly. That is the right privacy model,
  but it means a minimal facade that simply hands JS `colorData` bytes is not
  actually WebXR-compatible.

So the implementation choices are:

- **Keep the current native sidecar.** Best fit for this demo. It exposes exactly
  the RGB/depth bytes the WebGPU renderer needs and keeps the W3C camera story
  focused on `getUserMedia`.
- **Add WebXR vocabulary to the sidecar payload.** Good incremental improvement:
  include fields such as `depthType: "raw"` or `depthType: "smooth"`, `depthUsage:
  "cpu-optimized"`, `depthDataFormat: "float32"`, `rawValueToMeters: 1`, and a
  `normDepthBufferFromNormView` transform when ARKit calibration is wired
  through. This borrows the useful WebXR model without claiming `navigator.xr`.
- **Implement a disabled WebXR-shaped experiment.** Possible, but it should be
  labeled research. A credible version would implement `navigator.xr`,
  `XRSession`, `XRFrame`, `XRView`, `XRCPUDepthInformation`, and probably raw
  camera access. It would still be non-standard unless it either uses WebGL
  bindings or defines a separate WebGPU binding story.
- **Implement full WebXR depth.** Not justified for this app. It would turn the
  repo into an XR runtime project and would still not naturally feed the current
  WebGPU pipeline without additional WebGPU/WebXR binding work.

Recommendation for this demo: keep the native sidecar as the private ARKit
implementation substrate, but expose the user-facing LiDAR demo only through
the WebXR-shaped research route. The earlier direct native route was useful for
initial device validation, but keeping both routes after the WebXR profile
landed made the app carry two app-facing LiDAR APIs for the same sensor path.
The WebXR route must remain labeled experimental and must not change the
default `getUserMedia` story.

Additional primary source:

- WebXR Raw Camera Access Module:
  https://immersive-web.github.io/raw-camera-access/

The scoped WebXR source slices live in [LLP 0014](./0014-webxr-device-api-spec-slices.spec.md),
[LLP 0015](./0015-webxr-ar-module-spec-slices.spec.md),
[LLP 0016](./0016-webxr-depth-sensing-spec-slices.spec.md), and
[LLP 0017](./0017-webxr-raw-camera-access-spec-slices.spec.md).

Implementation files:

- `modules/standard-camera/src/WebXRDepthProfile.ts` implements the
  WebXR-shaped research profile over the native LiDAR sidecar.
- `src/app/(tabs)/(demo)/lidar-depth-webxr.tsx` is the only user-facing LiDAR
  demo route. It uses `navigator.xr`; app code does not call native LiDAR frame
  getters directly.

For this app, the right connection is therefore: keep the W3C camera API clean
for ordinary RGB capture, implement LiDAR behind a private iOS native sidecar,
and feed its frames into web-shaped WebGPU code beside the `getUserMedia` demos.

## Why not `getUserMedia` depth

Depth is not just another camera resolution or facing mode. A useful depth API
needs to define coordinate spaces, RGB/depth alignment, timestamps, camera
intrinsics, units, confidence/invalid pixels, privacy limits for scene geometry,
and consumer APIs for GPU and CPU access. The current Media Capture subset in
this repo only needs ordinary `audio` and `video` `MediaStreamTrack`s plus the
constrainable properties required by WPT-style camera tests.

Re-adding the discontinued `videoKind: "depth"` shape would also create a weak
demo signal: it would showcase a private extension that browser code cannot
count on, instead of proving that existing browser camera code can run unchanged
on native. If the project ever wants to incubate depth seriously, that should be
a separate research/standards track with explicit privacy and geometry semantics,
not a silent expansion of the standard-camera v1 scope.

## Goals

- **Show the benefit of web plus native mobile.** The demo must make the native
  sensor obvious: LiDAR depth should drive the picture, not merely decorate an
  RGB camera feed.
- **Keep the bridge narrow.** Native code owns ARKit session setup and exposes
  only compact depth-frame data plus diagnostics. WebGPU owns rendering.
- **Keep W3C scope clean.** The LiDAR API is not added to
  `navigator.mediaDevices`, `MediaStreamTrack`, or the spec subset in LLP 0001.
  It is an explicit demo extension on the native module.

## Non-goals

- **Not a W3C Media Capture feature.** LiDAR depth frames are out of scope for
  the v1 `getUserMedia` subset.
- **Not ARKit rendering.** ARKit may track and produce depth, but SceneKit,
  RealityKit, and native Metal rendering are intentionally avoided so WebGPU is
  the visible rendering layer.
- **Not a full AR app.** Anchors, planes, meshing, hit testing, persistence, and
  world reconstruction are left for future demos.

## Demo: LiDAR depth field

**Pitch:** Native ARKit LiDAR depth frames become a WebGPU point-cloud style
depth and occlusion visualization in real time.

**UX.**

1. Open the demo on a LiDAR-capable iPhone.
2. The app starts an ARKit world-tracking session with scene-depth semantics.
3. The screen shows the live ARKit camera image as the preview background.
4. WebGPU renders a split Compare viewport: live camera on the left and the
   native LiDAR depth texture on the right. Depth mode expands the depth field,
   and Boundary mode uses the same depth texture to draw the selected target
   distance as a stable contour over the camera image.
5. The View and Target Distance controls sit directly under the preview so the
   user can switch render modes and target planes without scrolling through
   telemetry.
6. A small status strip reports support, camera frame size, depth frame size,
   frame count, center depth, selected target distance, observed depth range,
   and a closer-than-target percentage sampled from the same native depth
   texture that drives WebGPU depth cues.
7. The selected focus/target distance can be pinned to the current center-depth
   sample, so native LiDAR measurement places the WebGPU effect at the surface
   under the reticle instead of relying only on fixed presets.

**Architecture.**

```
ARWorldTrackingConfiguration + sceneDepth
   ↓
ARFrame.capturedImage + ARFrame.sceneDepth.depthMap
   ↓
StandardCamera native extension: BGRA preview bytes + tight Float32 depth bytes
   ↓
JS uploads BGRA preview bytes into a bgra8unorm texture + Float32 depth bytes into r32float
   ↓
WGSL fragment shader samples RGB + depth → comparison, depth, and boundary views
   ↓
GPUCanvasContext.present()
```

The route targets 30 fps uploads and renders every animation frame with the
latest uploaded ARKit frame. In development builds it emits
`WEBGPU_DEMO_PROFILE` records through the same system-log path as the LLP 0010
camera demos, including WebXR frame callbacks, pose/depth/camera misses,
depth/color upload preparation, `writeTexture()`, and render submit/present
timings. The WebXR render callback must catch per-frame depth/camera/upload
exceptions, log a throttled `WEBXR_DEMO_FRAME_ERROR`, and immediately request the
next XR frame; one stale or missing native payload should make the profile
visible without leaving the demo stuck on the development menu or a single
rendered frame. The panorama validator's profile-only log parser also consumes
`WEBGPU_DEMO_PROFILE` and `WEBXR_DEMO_FRAME_ERROR` records so copied physical
device logs can summarize whether the WebXR demo is missing pose, depth, camera,
upload, or render work. The same validator provides a `--webxr-demo` preset that
deep-links to `lidar-depth-webxr?autorun=1&view=depth` and runs in profile-only
mode so the physical-device trace targets this demo's Depth view rather than the
panorama capture route. `WEBGPU_DEMO_PROFILE` records include the active
`viewMode`/`viewModeLabel` so copied logs can prove which renderer was profiled.

Physical iPhone 15 Pro profiling showed ARKit producing 256x192 scene-depth
frames at 60Hz, while the original WebGPU route rendered only about 6fps because
JS spent roughly 140ms per upload swizzling BGRA preview bytes into RGBA. The
route therefore uploads the native BGRA preview directly into a WebGPU
`bgra8unorm` texture. The current WebXR profile returns a 1920x1080 BGRA camera
preview for clearer LiDAR/surface color while keeping the resolution choice
inside the native profile rather than exposing a request option.

Boundary mode favors measurement clarity over cinematic depth-of-field. It uses
the opaque depth palette for background geometry, blends a light depth-color
overlay over foreground objects detected by the boundary/target-depth logic, and
draws that target-distance isoline with a bright core plus a thin high-contrast
halo. Depth mode uses a higher-contrast palette with bright neutral
quarter-meter contour markers and yellow one-meter contour
markers for measurement. Depth and Compare keep boundary/discontinuity pixels in
the depth palette and use luminance contrast rather than replacing them with a
flat rim color, so object edges remain depth-colored while still reading as
boundaries. Compare's depth side uses the same depth-map renderer at reduced
strength so measurement and outline tuning stays consistent between views.
Boundary mode keeps high-contrast edge strokes from local depth discontinuities
rather than a broad low-opacity foreground fill, because the ARKit scene-depth
map is low resolution and soft outlines read as blur instead of geometry. Camera
sampling outside the fitted ARKit preview frame must return the canvas
background rather than clamped camera edge texels; otherwise portrait stage
layouts stretch the left/right camera border into visible bands.

The WGSL shader avoids local identifiers named `target`. The WebGPU compiler on
device treated `target` as reserved, which failed shader parsing and presented as
the demo's magenta error color. Use names such as `targetMask` or
`targetLineMask` for target-distance masks.

Like the LLP 0010 routes, the WebGPU render loop is route-focus scoped with
Expo Router's `useFocusEffect` so a previous hidden demo screen cannot continue
submitting GPU work behind the active route. The LiDAR session itself is also
stopped on route blur because Expo Router may keep the screen component mounted
after navigation.

## Native extension shape

The native module exposes demo-only calls for the WebXR-shaped profile:

- `getLiDARDepthCapabilities()` reports support, simulator/device status, and
  whether the ARKit scene-depth semantic is available.
- `startLiDARDepthAsync()` starts the ARKit session and resolves with the same
  capability payload.
- `startLiDARDepthWithTypeAsync(depthType)` starts ARKit with the observable
  WebXR depth type selected by `requestSession()`.
- `stopLiDARDepth()` pauses the ARKit session.
- `getLatestWebXRLiDARDepthFrame()` returns the latest tight-packed Float32
  depth frame plus the WebXR route's BGRA ARKit camera preview, or `null` while
  no frame is available.

### Camera ownership handoff

ARKit and AVFoundation must hand camera ownership over deterministically. The
demo must not rely on fixed sleeps between stopping a `getUserMedia` stream and
starting ARKit, or between pausing ARKit and letting AVFoundation resume. The
WebXR `requestSession()` path first stops the active standard stream, then
awaits the native capture source's serialized release point before calling
`startLiDARDepthWithTypeAsync()`. The native LiDAR start promise resolves only
after ARKit has produced a first scene-depth frame, so a WebXR session only
resolves after both camera ownership and depth delivery are proven. The stop
path awaits ARKit pause before clearing the external camera lock. Standard
`getUserMedia` auto-starts are owned by focused camera-consuming routes, not by
the global provider or offscreen native-tab scenes, so WebXR/LiDAR demos do not
pay for an unrelated AVFoundation startup before ARKit can take the camera. The
shared standard-camera provider still SHOULD coalesce duplicate default
`getUserMedia` starts from focused route-level start effects; only explicit
constraint changes should supersede an in-flight start. The external camera
lock MUST be represented by synchronous provider state as well as React state:
focused routes may hold stale `start()` closures across native-tab transitions,
so `start()` MUST check a ref-backed external lock before opening
AVFoundation. Otherwise a route-level auto-start can reopen the standard camera
after WebXR has acquired ARKit, starving the WebXR frame pump after the first
scene-depth frames. The WebXR profile MUST also avoid the inverse cold-start
race: autorun route effects can call `requestSession()` before the provider's
passive effect installs the camera-lock handler, so the profile should wait
briefly for that handler and reject if it cannot acquire one instead of starting
ARKit with no AVFoundation handoff. Overlapping WebXR session requests MUST be
rejected before taking the external lock so a losing startup path cannot unlock
AVFoundation while the winning ARKit start is still waiting for its first
scene-depth frame. Terminal native LiDAR state events are also part of this
handoff: a `stopped` or `failed` event from an older ARKit session MUST NOT
clear a newly acquired external lock before the new `starting`/`running` event
has established its session id. The WebXR explicit `end()` path MUST mark the
session ended and cancel callbacks immediately, but it MUST keep the external
camera lock acquired for that session until the native ARKit stop promise resolves. Runtime logs SHOULD
keep camera ownership clues visible: standard-camera start attempts, successful
`getUserMedia` opens, explicit external-lock engagement/release, starts blocked
by the external lock, duplicate starts coalesced while one is in flight, and
ignored stale LiDAR terminal events. Because provider logs do not carry a
panorama `scanId`, the panorama validator should preserve the derived
camera-ownership profile across scan-id boundaries in a pasted log. That lets a
one-frame WebXR scan be distinguished from an AVFoundation/ARKit ownership race
even when the relevant `CAMERA_CTX` lines precede the first current-scan
`PANORAMIC_*` metric.

Runtime ARKit failures and interruptions are native session-state transitions,
not merely missing frames. The native sidecar reports `starting`, `running`,
`interrupted`, `failed`, and `stopped` state through its capability payload and
module events so the shared camera context can keep AVFoundation locked while
ARKit is interrupted, and can release the lock on failure or stop.

The frame object contains:

- `width`, `height`
- `depthData`: `Uint8Array` containing `width * height` little-endian
  Float32 depth meters
- `depthFormat`: `"r32float"`
- `colorWidth`, `colorHeight`
- `colorData`: optional `Uint8Array` containing `colorWidth * colorHeight * 4`
  BGRA camera preview bytes
- `colorFormat`: optional `"bgra8unorm"`
- `frameNumber`
- `minDepth`, `maxDepth`, `meanDepth`

## Implementation status

The direct native LiDAR demo route has been removed. The remaining
implementation is the WebXR-shaped route in
`src/app/(tabs)/(demo)/lidar-depth-webxr.tsx`, backed by
`modules/standard-camera/src/WebXRDepthProfile.ts`,
`modules/standard-camera/ios/LiDARDepthSource.swift`, and the demo-only native
module calls in `StandardCameraModule.swift`.

The WebXR profile's `requestSession()` path uses `CameraContext` only for the
shared external camera lock. ARKit and AVFoundation compete for the same iOS
camera device, so the profile stops and locks the standard stream before
starting ARKit, then releases that lock when the XR session ends or fails.

## Validation

A useful first version is complete when:

1. It builds on iOS after adding ARKit to the local module podspec.
2. It reports unsupported instead of crashing on simulator/non-LiDAR devices.
3. It runs on a LiDAR-capable physical device and reports rising frame numbers.
4. The WebGPU canvas shows the live camera preview, visibly changes when the
   phone points at near vs far geometry, the Compare viewport shows the native
   depth texture beside the camera view, and Boundary mode draws a crisp target
   distance contour from the same native depth texture.
5. The closer-than-target readout rises when a real object enters the selected
   target distance, proving the native LiDAR depth frame is active even when
   the camera image alone would look unchanged.
6. Pinning to the center depth changes the selected focus/target distance to
   the latest valid LiDAR center sample.
7. The demo catalog labels it as native LiDAR plus WebGPU, not as W3C
   `getUserMedia`.

## Future directions

- Occlusion demo: web-rendered objects disappear behind real geometry.
- Depth bokeh: optional experiment only; the default demo favors target-distance
  contours because blur hides the LiDAR signal.
- Measurement overlay: sample depth under crosshair and show approximate range.
- Mesh mode: estimate normals from the depth map and relight the scene in WGSL.
