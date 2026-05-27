# LLP 0020: Panoramic WebXR scene capture

**Type:** Plan
**Status:** Active
**Systems:** demo, webxr-lidar-api, standard-camera-native-extension
**Author:** Codex
**Date:** 2026-05-26
**Related:** 0000, 0001, 0012, 0013, 0014, 0015, 0016, 0017

## Summary

This LLP describes an experimental demo that lets a user scan a room like a
panoramic camera, then press Capture to freeze the scan into a 3D scene model
rendered with WebGPU.

The right first version is a camera-colored surfel/point-cloud model, not a
full textured triangle mesh. ARKit already gives this repo camera pixels,
LiDAR scene depth, and camera pose through the WebXR-shaped profile in
[LLP 0013](./0013-webxr-lidar-depth-api.spec.md). The implemented first
milestone uses WebXR `"depth-sensing"` and `"camera-access"` to accumulate
sparse RGB-D keyframes and renders the frozen surfel model with WebGPU. A
proper textured mesh needs more: mesh anchors or depth fusion, texture keyframe
selection, UV generation, atlas packing, occlusion checks, and seam cleanup.
That should be a later milestone.

The demo must remain explicitly experimental. It does not make WebXR part of
the Media Capture subset, and it does not expose LiDAR through
`navigator.mediaDevices`.

## Implementation status

The current implementation lives in
[`src/app/(tabs)/(demo)/panoramic-scene-capture.tsx`](<../src/app/(tabs)/(demo)/panoramic-scene-capture.tsx>).

Implemented:

- `scan-live`: starts an explicit user-initiated `immersive-ar` session with
  required `"depth-sensing"` and `"camera-access"` features.
- Keyframe accumulation: accepts sparse frames using time, rotation, and
  translation thresholds, capped by keyframe and surfel counts, with a simple
  direction-sector stage-level scan coverage meter.
- Keyframe quality gate: candidate frames are sampled into a scratch buffer and
  retained only when they satisfy the time/pose thresholds and contribute a
  minimum number of valid depth surfels, with deterministic tests for capped,
  sparse, redundant, translated, and rotated keyframes.
- Colored surfel reconstruction: samples `XRView.camera` through the repo-local
  `WebXRCPUCameraBinding` analog of Raw Camera Access, maps normalized view
  coordinates into the camera image with `normCameraImageFromNormView`, and
  falls back to depth palette colors when camera pixels are unavailable.
- Camera-image alignment: native WebXR frames compose ARKit's normalized
  view-to-captured-image transform with the preview crop/scale, so
  `normCameraImageFromNormView` maps into the actual CPU-visible BGRA bytes
  returned through `XRCamera`.
- WebXR depth-geometry unprojection: native frames expose ARKit
  `ARCamera.projectionMatrix(for:viewportSize:zNear:zFar:)` and
  `ARCamera.transform` through the standard `XRViewGeometry` fields on
  `XRView` and `XRDepthInformation`, so the surfel pipeline unprojects
  depth-map samples without adding intrinsics-specific JS API surface.
- Basic voxel fusion: repeated world-space samples are merged into 4.5 cm
  voxel surfels with weighted position/radius averages, lower weights for
  distant samples, and camera-color-preferred color averaging.
- Surfel normals: estimates normals from neighboring WebXR depth samples where
  local depth is continuous, fuses them into each voxel surfel, uses them for
  WebGPU lighting, and exports them as PLY vertex normals.
- Capture telemetry: model view reports fusion, camera-color, normal-estimate,
  and build-time metrics, and final Capture logs a
  `PANORAMIC_CAPTURE_METRICS` JSON line for physical-device validation.
- Scan-loop profiling and live preview: accepted keyframes log
  `PANORAMIC_KEYFRAME_PROFILE`; scan mode maintains an incremental voxel-fusion
  map and publishes throttled `PANORAMIC_LIVE_MODEL_PROFILE` snapshots for
  realtime WebGPU feedback. The full model is not rebuilt on every XR frame, so
  live capture work avoids the earlier quadratic point-history path.
- Lazy WebXR payloads: native XR animation-frame polling returns frame metadata
  first and defers CPU depth copies plus camera preview rendering until
  `XRCPUDepthInformation.data` or `XRCPUCameraBinding.getCameraImage()` is
  actually used by an accepted keyframe or the live LiDAR viewer.
- Render telemetry: after the captured model reaches a WebGPU draw with a
  nonempty surfel buffer, the viewer logs `PANORAMIC_RENDER_METRICS` with the
  canvas size, presentation format, model revision, keyframe count, surfel
  count, and quality percentages.
- Export telemetry: successful Save logs `PANORAMIC_EXPORT_METRICS` with the
  Files-visible path, file URI, byte count, keyframe count, and surfel count
  only after the Documents file exists and reports a nonzero size.
- Scan controls: the route keeps the native dark header Start/Stop action and
  also exposes the same Start Scan / Stop Scan action in the Expo UI command
  cluster so physical-device validation does not depend on discovering header
  chrome.
- `model-view`: renders live and frozen surfel clouds with smaller instanced
  WebGPU splats, one-finger orbit, two-finger pan/pinch interaction, depth
  testing, and model statistics. The preview canvas owns gestures that start on
  it so those touches do not scroll the route or trigger horizontal navigation.
- `building-model`: Capture moves through an explicit build state before
  publishing the frozen saveable model, which prevents duplicate Capture taps
  and makes the freeze/build boundary visible in the UI. The XR frame loop is
  cancelled before yielding to that state so no additional keyframes are
  accepted after the Capture tap. Late errors from stale XR loop setup are
  ignored once the session has been intentionally ended or replaced.
- Scan preview: scan mode publishes realtime model snapshots automatically.
  The explicit Preview Model action remains as a manual rebuild/recenter from
  the current incremental surfel fusion state without ending the WebXR session
  or enabling export. Preview is available only during scan mode; after
  Capture, the frozen model is the saveable model boundary. Manual Preview and
  Capture recenter the viewer so a newly built model starts in frame.
- Model-view display modes: a segmented View control switches the WebGPU
  surfel renderer between camera color, geometric depth/distance, and fused
  normal inspection.
- Model-view reset: after capture, the Reset slot becomes a Recenter action
  that restores the orbit/pinch viewer state without deleting the captured
  model.
- Restart safety: starting a replacement scan does not clear the displayed or
  saveable captured model until a new WebXR session has actually been acquired;
  if replacement scan startup fails, the previous captured model remains in the
  captured/saveable state while the error is reported.
- Export: after explicit Capture, writes an ASCII `.ply` model into the app
  Documents directory before opening any optional share sheet, reports the
  Files-visible filename/size, and relies on iOS document sharing so the
  Documents directory is visible in Files. Optional share-sheet failure or
  dismissal does not turn an already-written Files export into a save failure.
  The PLY header vertex count is derived from the actually serialized surfel
  rows, so the saved artifact stays self-consistent if a future model buffer is
  preallocated or truncated.
  The PLY comments include keyframe count and model bounds so exported scans
  remain self-describing outside the app.
  The PLY vertices preserve surfel radius, fused weight, and observation count
  in addition to position, normal, and color, so the saved file carries the
  display model's splat metadata rather than just bare points.
- Deterministic model tests: the pure reconstruction/export helpers live in
  `src/lib/panoramic-scene-model.ts` and are covered by Bun tests for depth
  unprojection, column-major transforms, BGRA color sampling, voxel fusion,
  WebXR-shaped RGB-D surfel extraction, PLY export, Files path formatting, and
  capture-control gating.

Not yet implemented:

- ARKit confidence-aware weighting and native confidence map exposure.
- Physical-device proof that a captured flat wall has correct metric scale and
  camera/depth alignment.
- ARKit mesh-anchor snapshot support.
- UV-mapped texture atlases or true textured mesh export.

## Standards positioning

This feature belongs beside the existing WebXR-shaped LiDAR demo, not inside
the W3C Media Capture implementation.

- `getUserMedia` remains a camera/microphone API. It MUST NOT grow depth,
  world-pose, mesh, or reconstruction members for this demo.
- `navigator.xr` remains a repo-local research profile. The implementation MUST
  label it experimental and MUST NOT claim browser-compatible WebXR.
- WebXR Depth Sensing and Raw Camera Access provide useful vocabulary for
  frame-scoped depth, pose-aligned camera images, and privacy boundaries.
- WebXR mesh detection / real-world meshing is useful vocabulary for an ARKit
  mesh milestone, but this repo does not need a full WebXR runtime.

This split preserves the core story from [LLP 0000](./0000-standard-camera.explainer.md):
portable browser-shaped camera code works through Media Capture, while native
mobile sensors can be explored through a narrow WebXR-shaped sidecar.

## Platform findings

Current platform support makes a native-backed route necessary on iOS:

- Safari 26 adds WebGPU support across iOS, iPadOS, macOS, and visionOS, but
  this app renders through `react-native-wgpu`, not Safari.
- Apple Developer Forums state that WebXR `"immersive-ar"` sessions are not
  supported on visionOS or iOS. The demo therefore cannot depend on real Safari
  WebXR AR.
- ARKit scene depth is available on LiDAR-capable devices through
  `sceneDepth` / `smoothedSceneDepth` frame semantics. ARKit scene
  reconstruction can also provide polygonal mesh estimates of the environment
  on supported devices.
- The WebXR Raw Camera Access draft treats raw camera access as one of the
  highest-privacy XR capabilities. This demo must keep camera/depth capture
  behind explicit user action and native camera permission.

Primary sources:

- WebKit: WebGPU in Safari 26.0 - https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- Apple Developer Forums: WebXR `"immersive-ar"` unsupported on iOS/visionOS -
  https://developer.apple.com/forums/thread/756850
- Apple ARKit `sceneReconstruction` - https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/scenereconstruction
- Apple ARKit scene-depth point-cloud sample - https://developer.apple.com/documentation/arkit/visualizing_a_point_cloud_using_scene_depth
- Apple ARKit `ARCamera.intrinsics` - https://developer.apple.com/documentation/arkit/arcamera/intrinsics
- Apple ARKit `ARCamera.projectionMatrix` - https://developer.apple.com/documentation/arkit/arcamera/projectionmatrix
- WebXR Raw Camera Access - https://immersive-web.github.io/raw-camera-access/
- WebXR Real World Meshing - https://immersive-web.github.io/real-world-meshing/

## Goals

1. Let a user scan an environment by panning the phone through the scene.
2. Let the user press Capture to freeze the accumulated scan.
3. Render the captured scene as a navigable 3D model with WebGPU.
4. Use textures or camera colors where practical, without blocking the MVP on a
   full texture-atlas pipeline.
5. Keep all raw camera/depth/mesh data local to the app unless a later export
   feature explicitly asks the user to save/share it.
6. Keep the WebXR-shaped API small, traceable, and separate from
   `navigator.mediaDevices`.

## Non-goals

- No full WebXR runtime.
- No browser compatibility claim for the repo-local `navigator.xr`.
- No general SLAM implementation in JavaScript.
- No photorealistic textured mesh in the first milestone.
- No `MediaStreamTrack.kind === "depth"`, `videoKind: "depth"`, or other Media
  Capture depth surface.
- No cloud reconstruction service.
- No automatic export/upload of scene geometry or camera imagery.

## User experience

The demo should have three states.

### `scan-live`

The user starts an `immersive-ar` WebXR-shaped session with
`"depth-sensing"` and `"camera-access"`. The view resembles the current LiDAR
Depth Studio route, but adds scan coverage feedback:

- live camera/depth WebGPU preview
- in-screen Start/Stop control in addition to the native header action
- keyframe count
- approximate captured points/surfels
- coverage ring or mini-map hint
- "Capture" button
- "Reset" button

During this state the app collects sparse keyframes. It should not store every
frame.

### `building-model`

Pressing Capture stops keyframe collection and seals a snapshot. The app
converts the retained RGB-D keyframes into GPU-ready model buffers.

The AR session MAY keep running for a live background preview, but the first
implementation SHOULD end it after capture to release the camera and make the
privacy boundary obvious.

### `model-view`

The app displays the frozen model in a WebGPU viewer:

- one-finger orbit or turntable rotation
- pinch zoom and two-finger pan
- reset view
- model stats: points, keyframes, approximate bounds
- optional mode picker: color, depth, normal/confidence

The captured model is in memory only for the first milestone.

## Capture data model

The capture pipeline needs frame records that are richer than the current live
depth shader requires.

```ts
interface SceneCaptureKeyframe {
  frameNumber: number;
  timestamp: DOMHighResTimeStamp;

  // Camera-to-world transform for the frame. In the current WebXR-shaped
  // profile this is XRDepthInformation.transform / XRView.transform, backed
  // by ARCamera.transform.
  cameraToWorldTransform: Float32Array; // 16 entries, column-major.
  trackingState: "normal" | "limited" | "notAvailable" | "unknown";

  // Standard XRViewGeometry. With matchDepthView=true, the depth and view
  // geometry are the same; reconstruction should use the depth object's copy.
  projectionMatrix: Float32Array;

  depth: {
    width: number;
    height: number;
    projectionMatrix: Float32Array;
    transform: Float32Array;
    data: ArrayBuffer; // Float32 meters, tight row-major.
    confidence?: ArrayBuffer; // optional uint8 confidence map, tight row-major.
    normDepthBufferFromNormView: Float32Array;
  };

  camera: {
    width: number;
    height: number;
    format: "bgra8unorm" | "rgba8unorm";
    // Optional retained bytes. The surfel MVP should sample color during
    // reconstruction and then discard full camera frames to stay inside memory
    // caps.
    data?: ArrayBuffer;
    normCameraImageFromNormView: Float32Array;
  };
}

interface SceneCaptureModel {
  keyframeCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  surfels: ArrayBuffer;
  surfelCount: number;
  vertexFormat: "position_radius_color_normal";
}
```

The WebXR Depth Sensing spec mixes `XRViewGeometry` into
`XRDepthInformation`, so the repo-local profile exposes `projectionMatrix` and
`transform` on both `XRView` and `XRDepthInformation`. For
`matchDepthView === true`, these fields describe the same view. Panoramic
reconstruction should use those standard geometry fields rather than exposing
ARKit camera intrinsics as an app-facing extension.

The current `LiDARDepthSource` returns display-oriented 1280x960 BGRA camera
bytes generated by `makeCameraPreviewFrame()`. That is sufficient for the live
WebGPU depth demo, but it is not automatically geometry-grade texture input.
The frame payload separately exposes `normCameraImageFromNormView` so camera
colors are sampled in the returned `XRCamera` image plane while geometry stays
anchored to the WebXR depth/view projection.

## Keyframe policy

The app SHOULD retain a keyframe only when it contributes new geometry.

Initial thresholds:

- at least 12 degrees of camera rotation since the previous accepted keyframe,
  or at least 12 cm of translation
- at least 250 ms since the previous accepted keyframe
- `trackingState === "normal"` or a repo-local equivalent that proves ARKit
  pose tracking is stable enough for world-space fusion
- depth frame has enough valid samples and, when available, enough medium/high
  confidence samples
- exposure/motion blur is not obviously corrupting the camera keyframe
- cap at 30-60 keyframes for the first milestone

Each accepted keyframe SHOULD be downsampled before storage. A first target is
160x120 to 256x192 depth samples per keyframe, selected by striding the depth
map or by a small native downsample pass. Downsampling SHOULD be edge-aware
where practical; a naive box filter across a depth discontinuity will create
floating geometry between foreground and background surfaces.

## Reconstruction pipeline

### MVP: colored surfels

The first implementation should build a surfel model from RGB-D keyframes.

For each accepted keyframe:

1. Iterate a downsampled grid of view samples or depth pixels. A normalized
   view sample is preferred because WebXR defines both camera and depth
   transforms from normalized view coordinates. If the implementation iterates
   depth pixels directly, it must invert or otherwise account for
   `normDepthBufferFromNormView`; a depth pixel's normalized coordinate is not
   necessarily a normalized view coordinate.
2. Map the view sample into the depth image with
   `normDepthBufferFromNormView`, then reject invalid depth (`0`, non-finite,
   outside the configured range, or low confidence when a confidence map is
   available).
3. Map the same view sample into the camera image with
   `normCameraImageFromNormView`. This is for color sampling only; geometry
   remains in normalized view coordinates and uses `XRDepthInformation`
   projection/transform.
4. Sample BGRA/RGBA camera color without per-frame channel swizzling when the
   GPU/render path can consume `bgra8unorm`.
5. Unproject into camera space using the associated `XRViewGeometry`
   `projectionMatrix`:

   ```text
   depthMeters = rawDepth * rawValueToMeters
   clip = vec4(viewX * 2 - 1, 1 - viewY * 2, -1, 1)
   nearCamera = inverse(projectionMatrix) * clip
   cameraPoint = nearCamera.xyz * (-depthMeters / nearCamera.z)
   ```

   WebXR depth values are camera-plane distances, not ray lengths, so
   `depthMeters` is used directly as the optical-axis depth. Do not normalize
   the ray and multiply by depth.
6. Apply the associated `XRViewGeometry.transform` / `ARCamera.transform` to
   place the camera-space point in world space. The implementation MUST
   validate the sign and axis convention with a known planar target before
   treating the model as correct.
7. Estimate a normal from neighboring valid depth samples when available. Do
   not average across large depth discontinuities.
8. Insert the surfel into a voxel grid to deduplicate overlapping samples.

The first implementation should use a voxel hash with weighted running
averages rather than simple append-only points. Suggested weights:

- ARKit confidence, if exposed
- lower weight for grazing incidence angles
- lower weight for high local depth variance
- lower weight for distant samples, where depth noise covers more world space

Dynamic or reflective objects will still create ghosts. The MVP should not
promise metrology-grade scans; it is a panoramic scene capture suitable for
visualization.

### WebXR depth-geometry unprojection

ARKit provides both raw imaging parameters and orientation/viewport-adjusted
rendering geometry. The repo-local WebXR profile should expose the latter to
application code: `ARCamera.projectionMatrix(for:viewportSize:zNear:zFar:)`
feeds `XRView.projectionMatrix` and `XRDepthInformation.projectionMatrix`,
while `ARCamera.transform` feeds `XRView.transform` and
`XRDepthInformation.transform`.

The TypeScript surfel pipeline reads depth samples through
`normDepthBufferFromNormView`, unprojects normalized view coordinates with
`projectionMatrix`, and then applies `transform` as camera-to-world. This keeps
the app-facing AR geometry inside WebXR's `XRViewGeometry` surface. If a future
native reconstruction path needs raw `ARCamera.intrinsics`, it should either
keep that math native or map the result back to standard WebXR geometry rather
than adding an intrinsics field to `XRDepthInformation`.

The model format should store:

- `position`: `float32x3`
- `radius`: `float32`
- `color`: packed `rgba8unorm` or `float32x4`
- `normal`: packed `snorm16x4` or `float32x3`
- `weight/confidence`: optional

This model is not a watertight mesh, but it should look like a panoramic 3D
capture when rendered as camera-facing splats.

### V2: ARKit mesh snapshot

If `ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)` returns
true, native code can enable scene reconstruction and expose changed
`ARMeshAnchor`s. This gives the app a polygonal environment estimate.

Mesh reconstruction must be enabled when the ARKit configuration starts; it is
not just another per-frame buffer like scene depth.

The WebXR-shaped API should borrow from the Real World Meshing draft without
claiming conformance. A minimal repo-local shape could be:

```ts
interface WebXRWorldMesh {
  anchorId: string;
  transform: Float32Array;
  vertices: ArrayBuffer;
  normals: ArrayBuffer;
  indices: ArrayBuffer;
  classification?: Uint8Array;
}

interface WebXRFrame {
  getWorldMeshes?(): readonly WebXRWorldMesh[];
}
```

`vertices`, `normals`, and `indices` are anchor-local buffers; the renderer must
apply `transform` to place them in world space. The native layer must also
surface add/update/remove semantics, because ARKit can refine or replace mesh
anchors as tracking improves.

The route can render this mesh with per-face classification colors first, then
add projected camera colors later. ARKit scene reconstruction is useful for
large planar structure, but it will still contain holes, delayed updates, and
smoothed geometry that may not align exactly with a single RGB keyframe.

### V3: textured mesh

A textured mesh requires a separate atlas pipeline:

1. Pick several high-quality camera keyframes.
2. For each mesh triangle, choose the best keyframe using view angle, distance,
   projected area, sharpness, and depth-occlusion checks.
3. Generate UV charts for selected triangles.
4. Pack charts into one or more texture atlases.
5. Render/copy camera pixels into the atlas.
6. Normalize exposure/white balance between keyframes where possible.
7. Blend or feather seams between keyframes.

This is the first milestone where "textures" should mean actual UV-mapped
textures. Before that, the demo should say "colored model" or "camera-colored
point model" rather than "textured mesh."

## WebGPU rendering

The WebGPU viewer should be separate from the live depth shader.

For surfels:

- upload surfel data to a `GPUBuffer`
- render instanced camera-facing quads expanded in the vertex shader; do not
  rely on point-sprite sizing, because WebGPU does not provide portable
  programmable point size
- enable depth testing
- size each splat from surfel radius and camera distance, clamped to a small
  screen-space range so dense captures read as surfaces instead of oversized
  blobs
- shade with camera color, optional normal lighting, and a subtle confidence
  fade; color mode should still apply a low luminance floor so black or
  unavailable camera pixels do not make the surfel cloud disappear
- keep splats mostly opaque in the first version so depth testing remains
  predictable; transparent splats require sorting or an order-independent
  transparency pass

For ARKit meshes:

- upload vertices, normals, indices, and optional color/UV buffers
- use a standard indexed triangle pipeline
- render with depth testing and backface culling disabled initially, since
  reconstructed meshes can have holes and inconsistent orientation

The renderer SHOULD keep BGRA camera data in BGRA when possible. This follows
the existing LiDAR/WebGPU performance finding: avoid per-frame JavaScript pixel
swizzles or full-frame color conversions.

## Native changes

The existing `LiDARDepthSource` already provides:

- ARKit session lifetime
- scene depth / smoothed scene depth
- display-oriented BGRA camera pixels
- view transform
- projection matrix
- normalized view-to-depth/camera transforms
- per-frame `XRViewGeometry` projection/transform fields on
  `XRDepthInformation`

Future reconstruction quality work needs either:

- optional depth confidence, or
- a native unprojection/downsample method that returns world-space surfels for
  selected frames.

The second option is likely faster and reduces bridge pressure, but the first
option keeps the geometry pipeline more transparent in TypeScript. The first
implementation should start with TypeScript reconstruction at reduced
resolution, then move unprojection/voxelization native-side only if profiling
shows the bridge or JS loop is the bottleneck.

Do not assume the current 1280x960 preview bytes are sufficient for texture
atlasing. If they stay in a future texture path, native code must expose a
standard WebXR-shaped mapping from model/view coordinates into the returned
camera image, or keep the high-fidelity camera projection math native-side.
For the surfel milestone, preview bytes are only sampled into per-surfel color.

The mesh milestone needs native support for:

- `ARWorldTrackingConfiguration.sceneReconstruction`
- `ARSessionDelegate.session(_:didAdd:)` / `didUpdate` / `didRemove` mesh
  anchors
- extraction of `ARMeshGeometry` vertices, normals, faces, and optional
  classifications into tight typed buffers
- transforming anchor-local mesh buffers into world space or returning the
  anchor transform beside the buffers

## Privacy and permissions

This demo captures raw camera images, depth, pose, and potentially room-scale
geometry. Treat that data as sensitive.

Requirements:

- Start scan only from explicit user action.
- Capture/freeze only from explicit user action.
- Show an in-app live/capture state while the camera is active.
- End the AR session after Capture in the first implementation.
- Keep captures in memory only unless an export feature adds an explicit
  save/share action.
- Do not upload captures.
- Do not add hidden background capture.
- Do not install this WebXR profile from the default Media Capture polyfill.

## Performance constraints

The first version should optimize for predictable device behavior:

- collect keyframes, not every frame
- downsample depth before retaining it
- do not retain full 1280x960 BGRA camera frames for every keyframe in the
  surfel MVP; sample colors into surfels promptly or keep a deliberately
  downsampled color image
- cap memory by keyframe count and point count
- prefer `bgra8unorm` over JS BGRA-to-RGBA conversion
- avoid full-resolution CPU texture atlasing in the scan loop
- profile on a physical LiDAR device with `WEBGPU_DEMO_PROFILE`-style logs

Suggested first caps:

- 30 keyframes
- 20k surfels per keyframe before voxel merge
- 250k retained surfels total
- 64 MB model-buffer budget
- 128 MB temporary keyframe/scratch budget before model build
- capture/build time target under 2 seconds on iPhone 15 Pro-class hardware

## Testing and validation

This demo is not WPT-backed. Validation should combine small deterministic
tests with physical-device profiling.

Implementation tests:

- synthetic projection/depth unprojection produces expected camera-space points
  (`bun test src/lib/panoramic-scene-model.test.ts`)
- camera-to-world transform application is correct
  (`bun test src/lib/panoramic-scene-model.test.ts`)
- normalized view-to-depth/camera transforms round-trip known pixels
- BGRA camera byte sampling preserves channel interpretation without a full-frame
  JS swizzle (`bun test src/lib/panoramic-scene-model.test.ts`)
- voxel deduplication keeps one representative per cell
  (`bun test src/lib/panoramic-scene-model.test.ts`)
- voxel averaging preserves a flat plane without biasing it toward the camera
- keyframe policy accepts/rejects frames as expected
- model stats stay within configured caps
- PLY export includes vertex positions, normals, and uchar colors
  (`bun test src/lib/panoramic-scene-model.test.ts`)

Manual/device validation:

- non-LiDAR device reports unsupported
- simulator reports unsupported
- start/stop/capture releases the camera correctly
- a checkerboard or taped rectangle has low RGB/depth alignment error
- panning a flat wall produces a flat reconstructed wall
- a wall measured at a known distance has plausible scale, not just plausible
  appearance
- surfel placement is validated with ARKit projection/display transforms for the
  portrait WebXR viewport, while camera colors are sampled through
  `normCameraImageFromNormView` instead of assuming the camera image is
  view-aligned
- moving around a chair or desk produces visible parallax in model-view
- revisiting the starting view does not create an obvious duplicate wall from
  pose drift
- model-view is nonblank and interactive
- WebGPU frame rate remains usable with the max retained surfel count
- final Capture emits `PANORAMIC_CAPTURE_METRICS` with nonzero keyframes,
  surfels, camera color percentage, normal percentage, and bounds
- model-view emits `PANORAMIC_RENDER_METRICS` after Capture with a nonzero
  surfel count and the expected canvas size / presentation format
- final Save emits `PANORAMIC_EXPORT_METRICS` with a nonzero byte count and
  Files-visible `.ply` path

Before requesting review for implementation, run:

```sh
bun run test:ios
```

For physical-device proof of the panorama flow, run:

```sh
bun run validate:panorama:ios -- --device <device-name-or-id> --metro-url <lan-metro-url>
```

The validator launches the dev-client build, opens the panorama demo route, and
then waits for the phone interaction. Use the phone to Start Scan, pan slowly
until surfels appear, Capture, and Save. The validator passes only after it sees
nonzero keyframe, capture, WebGPU-render, and Files-export telemetry from the
physical app logs.

Also run the `ref-check` skill so any `@ref LLP 0020#...` annotations added in
code point to real anchors.

## Implementation plan

1. Add this LLP and keep the existing LiDAR Depth Studio unchanged.
2. Extend the WebXR-shaped frame payload with `XRDepthInformation`
   `projectionMatrix` and `transform` geometry.
3. Build a new demo route, tentatively `panoramic-scene-capture`, that reuses
   `installWebXRDepthProfile()`.
4. Implement scan-live keyframe collection with strict caps.
5. Implement surfel reconstruction and WebGPU model-view rendering.
6. Add physical-device profiling and reduce caps until capture/build/render are
   stable.
7. Add optional ARKit mesh snapshot support behind capability checks.
8. Explore projected vertex colors, then a true texture-atlas pipeline.

## Open questions

1. Should surfel reconstruction run in TypeScript first for clarity, or native
   Swift first for performance?
2. Should a future texture-atlas path expose geometry-grade camera buffers
   through Raw Camera Access-style image planes, or should native code project
   textures and expose only a finished mesh/model artifact?
3. Should Capture end the AR session immediately, or keep it running so the
   user can compare the frozen model with the live scene?
4. Do we expose mesh anchors through a `getWorldMeshes()` method, or keep mesh
   capture as a separate native helper outside the WebXR-shaped frame object?
5. What is the acceptable model memory cap on current target devices?
6. Should export target USDZ, glTF/GLB, or an internal JSON/binary debug format
   first?
7. How much UI copy is needed to communicate that the first milestone is a
   colored 3D capture, not a photorealistic textured mesh?
