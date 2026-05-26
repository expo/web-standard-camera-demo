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
  stage-level scan coverage meter.
- Colored surfel reconstruction: samples `XRView.camera` through the repo-local
  `WebXRCPUCameraBinding` analog of Raw Camera Access, maps normalized view
  coordinates into the camera image with `normCameraImageFromNormView`, and
  falls back to depth palette colors when camera pixels are unavailable.
- Basic voxel fusion: repeated world-space samples are merged into 4.5 cm
  voxel surfels with weighted position/radius averages, lower weights for
  distant samples, and camera-color-preferred color averaging.
- Surfel normals: estimates normals from neighboring WebXR depth samples where
  local depth is continuous, fuses them into each voxel surfel, uses them for
  WebGPU lighting, and exports them as PLY vertex normals.
- Capture telemetry: model view reports fusion, camera-color, normal-estimate,
  and build-time metrics, and final Capture logs a
  `PANORAMIC_CAPTURE_METRICS` JSON line for physical-device validation.
- `model-view`: renders the frozen surfel cloud with instanced WebGPU splats,
  orbit/pinch interaction, depth testing, and model statistics.
- Export: writes an ASCII `.ply` model into the app Documents directory before
  opening any optional share sheet, reports the Files-visible filename/size, and
  relies on iOS document sharing so the Documents directory is visible in Files.

Not yet implemented:

- ARKit confidence-aware weighting and native confidence map exposure.
- Geometry-grade ARKit intrinsics exposure or a native unprojection helper.
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
- pinch zoom / two-finger pan if the app has gesture support
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
  // profile this is XRView.transform, backed by ARCamera.transform.
  cameraToWorldTransform: Float32Array; // 16 entries, column-major.
  trackingState: "normal" | "limited" | "notAvailable" | "unknown";

  // Projection data is kept for rendering/debugging. Metric reconstruction
  // should use intrinsics, because WebXR depth values are camera-plane
  // distances, not optical-ray lengths.
  projectionMatrix: Float32Array;
  cameraIntrinsics: Float32Array; // 3x3, pixel units.
  cameraIntrinsicsImageResolution: { width: number; height: number };
  cameraIntrinsicsReference: "captured-image" | "camera-bytes" | "depth-buffer";

  depth: {
    width: number;
    height: number;
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

`cameraIntrinsics`, `cameraIntrinsicsImageResolution`, and
`cameraIntrinsicsReference` are proposed additions to the repo-local WebXR frame
payload. They should be sourced from `ARCamera.intrinsics` and
`ARCamera.imageResolution`, with an explicit reference image plane. If the BGRA
camera bytes are cropped, scaled, or rotated for preview, the intrinsics MUST
either be transformed into that post-processed image plane or the crop / scale
transform back to the captured-image plane MUST be exposed. Otherwise depth
points will be colored and unprojected with a systematic offset.

The current `LiDARDepthSource` returns display-oriented 1280x960 BGRA camera
bytes generated by `makeCameraPreviewFrame()`. That is sufficient for the live
WebGPU depth demo, but it is not automatically geometry-grade texture input.
For panoramic capture, the implementation should choose one of two
geometry-grade paths: expose the original captured-image plane plus matching
transforms, or move depth downsampling, unprojection, and color lookup into
native code where the ARKit camera buffers and intrinsics are still in one
coordinate system.

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
   `normCameraImageFromNormView`. The result must land in the same image plane
   as the intrinsics used for unprojection, or be converted to that plane by an
   explicit crop/scale transform.
4. Sample BGRA/RGBA camera color without per-frame channel swizzling when the
   GPU/render path can consume `bgra8unorm`.
5. Unproject into camera space using intrinsics in the matching image plane:

   ```text
   zPlane = rawDepth * rawValueToMeters
   xImage = (u - cx) * zPlane / fx
   yImage = (v - cy) * zPlane / fy
   ```

   WebXR depth values are camera-plane distances, not ray lengths, so
   `zPlane` is used directly as the optical-axis depth. Do not normalize the
   ray and multiply by depth.
6. Convert image coordinates into the native camera coordinate convention
   before applying `cameraToWorldTransform`. For ARKit, this convention is easy
   to get wrong because image `v` increases downward while world/camera `y`
   does not, and forward depth is represented with the camera-space axis used
   by `ARCamera.transform`. The implementation MUST validate the sign and axis
   convention with a known planar target before treating the model as correct.
   A native unprojection helper is acceptable and may hide these details from
   TypeScript.
7. Transform the point by the frame's camera-to-world transform.
8. Estimate a normal from neighboring valid depth samples when available. Do
   not average across large depth discontinuities.
9. Insert the surfel into a voxel grid to deduplicate overlapping samples.

The first implementation should use a voxel hash with weighted running
averages rather than simple append-only points. Suggested weights:

- ARKit confidence, if exposed
- lower weight for grazing incidence angles
- lower weight for high local depth variance
- lower weight for distant samples, where depth noise covers more world space

Dynamic or reflective objects will still create ghosts. The MVP should not
promise metrology-grade scans; it is a panoramic scene capture suitable for
visualization.

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
- size each splat from surfel radius and camera distance
- shade with camera color, optional normal lighting, and a subtle confidence
  fade
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

The surfel MVP needs either:

- additional per-frame intrinsics/resolution/reference-plane fields plus
  optional depth confidence, or
- a native unprojection/downsample method that returns world-space surfels for
  selected frames.

The second option is likely faster and reduces bridge pressure, but the first
option keeps the geometry pipeline more transparent in TypeScript. The first
implementation should start with TypeScript reconstruction at reduced
resolution, then move unprojection/voxelization native-side only if profiling
shows the bridge or JS loop is the bottleneck.

Do not assume the current 1280x960 preview bytes are sufficient for metric
reconstruction. If they stay in the capture path, native code must expose the
post-crop intrinsics or a transform from preview pixels back to the original
captured image. Otherwise use the original `ARFrame.capturedImage` coordinate
system for color lookup and keep the preview path purely visual.

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

- synthetic intrinsics/depth unprojection produces expected camera-space points
- camera-to-world transform application is correct
- image-plane crop/scale/intrinsics transforms round-trip known pixels
- voxel deduplication keeps one representative per cell
- voxel averaging preserves a flat plane without biasing it toward the camera
- keyframe policy accepts/rejects frames as expected
- model stats stay within configured caps

Manual/device validation:

- non-LiDAR device reports unsupported
- simulator reports unsupported
- start/stop/capture releases the camera correctly
- a checkerboard or taped rectangle has low RGB/depth alignment error
- panning a flat wall produces a flat reconstructed wall
- a wall measured at a known distance has plausible scale, not just plausible
  appearance
- moving around a chair or desk produces visible parallax in model-view
- revisiting the starting view does not create an obvious duplicate wall from
  pose drift
- model-view is nonblank and interactive
- WebGPU frame rate remains usable with the max retained surfel count
- final Capture emits `PANORAMIC_CAPTURE_METRICS` with nonzero keyframes,
  surfels, camera color percentage, normal percentage, and bounds

Before requesting review for implementation, run:

```sh
bun run test:ios
```

Also run the `ref-check` skill so any `@ref LLP 0020#...` annotations added in
code point to real anchors.

## Implementation plan

1. Add this LLP and keep the existing LiDAR Depth Studio unchanged.
2. Extend the WebXR-shaped frame payload with camera intrinsics and image
   resolution/reference-plane metadata plus optional depth confidence, or add a
   native downsample/unproject helper.
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
2. Should the WebXR frame payload expose geometry-grade camera buffers and
   transformed intrinsics, or should native code expose only already-unprojected
   surfels to avoid coordinate-system mistakes?
3. Should Capture end the AR session immediately, or keep it running so the
   user can compare the frozen model with the live scene?
4. Do we expose mesh anchors through a `getWorldMeshes()` method, or keep mesh
   capture as a separate native helper outside the WebXR-shaped frame object?
5. What is the acceptable model memory cap on current target devices?
6. Should export target USDZ, glTF/GLB, or an internal JSON/binary debug format
   first?
7. How much UI copy is needed to communicate that the first milestone is a
   colored 3D capture, not a photorealistic textured mesh?
