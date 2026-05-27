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
- Keyframe accumulation: accepts sparse frames using time, rotation,
  translation, and maximum-motion thresholds, capped by keyframe and surfel
  counts, with a simple forward 180-degree direction-sector stage-level scan
  coverage meter.
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
- WebXR payload tuning: native depth payloads encode ARKit samples below the
  depth-type confidence threshold as invalid `0` depth values, preserving the
  standard `XRCPUDepthInformation.data` shape while avoiding noisy surfels.
  Smoothed scene depth accepts medium-or-better samples for stable panorama
  fusion, while raw scene depth uses only high-confidence current-frame samples
  when smoothed depth is unavailable. If a smoothed-depth frame would be
  completely invalid after the medium threshold, native payload creation may
  retry that frame with low-confidence smoothed samples and report the fallback
  in internal profiling so the scan can still produce startup surfels. The
  CPU-visible camera image is an internal 256x192 BGRA preview for the surfel
  color path, matching common scene-depth dimensions and cutting per-keyframe
  native render and bridge bytes without adding a camera-resolution option to
  `requestSession()`.
- WebXR depth-geometry unprojection: native frames expose ARKit
  depth-map-scaled `ARCamera.intrinsics` and `ARCamera.transform` through the
  standard `XRViewGeometry` fields on `XRView` and `XRDepthInformation` in a
  WebXR `"local"` reference space, so the surfel pipeline unprojects full
  scene-depth samples without adding intrinsics-specific JS API surface.
- WebXR pose quality gate: native frames keep ARKit's coarse camera
  `trackingState` and ARKit's `worldMappingStatus` inside the WebXR runtime.
  `getViewerPose()` returns `null` when ARKit cannot provide a camera pose, but
  startup frames with `.limited` tracking or non-mapped world-mapping buckets may
  still return a pose when ARKit provides a camera transform. This avoids
  starving the panorama route of surfels on devices that already deliver scene
  depth while world mapping remains `notAvailable`. The WebXR runtime may log
  throttled `PANORAMIC_XR_POSE_PROFILE` diagnostics for null-pose and
  degraded-pose paths, keeping native tracking and mapping state out of the
  app-facing WebXR objects while making physical logs actionable when a scan
  records pose misses or startup-quality poses.
- Basic voxel fusion: repeated world-space samples are merged into 4.5 cm
  voxel surfels with weighted position/radius averages, lower weights for
  distant samples, lower weights for samples whose local depth neighborhood
  cannot support an estimated normal, lower weights for grazing-angle
  observations, and camera-color-preferred color averaging. Accepted scan
  keyframes insert surfels directly into this fusion accumulator during the
  WebXR depth pass instead of first allocating a JS point array and then
  walking that array again. Fused model metadata records how many output
  surfels came from more than one raw observation, so physical-device logs can
  distinguish coordinate smear from a scan that simply lacks enough overlapping
  depth samples. Once a depth voxel already has several camera-colored
  observations and a fused normal, later overlapping depth samples that land in
  the same voxel SHOULD be skipped before camera-color sampling and normal
  estimation. This keeps repeated 180-degree overlap from spending scan-loop
  time on already mature voxels or pulling their fused coordinate toward
  late-frame pose/depth noise.
- Surfel normals: estimates normals from neighboring WebXR depth samples where
  local depth is continuous, fuses them into each voxel surfel, uses them for
  WebGPU lighting, and exports them as PLY vertex normals.
- Edge-aware depth sampling: TypeScript reconstruction samples depth at
  subpixel coordinates with bilinear interpolation only when the footprint is
  valid and locally continuous; discontinuities are rejected instead of
  creating floating surfels between foreground and background surfaces.
- Camera-color sampling: TypeScript reconstruction samples CPU-visible
  `XRCamera` bytes through `normCameraImageFromNormView` and bilinearly
  interpolates the nearest preview texels. This keeps the app on the WebXR
  normalized image transform while reducing nearest-pixel color shimmer in the
  live surfel preview and final PLY colors.
- Phased sparse sampling: accepted keyframes use a deterministic per-keyframe
  subcell offset when walking the sparse WebXR depth grid. This keeps the
  per-frame sample budget fixed for responsiveness while covering different
  depth pixels across a 180-degree sweep, reducing repeated-grid aliasing in the
  fused surfel model. The current scan budget is a 40x30 sparse depth grid per
  accepted keyframe; smooth depth and mesh supplementation provide coordinate
  stability and shape coverage while keeping the JavaScript surfel loop smaller
  than the earlier 44x34 grid. The keyframe depth cache SHOULD precompute the normalized
  WebXR view-space grid coordinates for each phased scan so depth lookup,
  unprojection, normal estimation, and camera-color sampling share those
  coordinates instead of recomputing them in each hot-path phase.
- Capture telemetry: model view reports fusion, camera-color, normal-estimate,
  and build-time metrics, and final Capture logs a
  `PANORAMIC_CAPTURE_METRICS` JSON line for physical-device validation.
- Scan-loop profiling and live preview: accepted keyframes log
  `PANORAMIC_KEYFRAME_PROFILE` with phase timings for depth payload access,
  depth preflight, native camera-image access, sampling, fusion, live publish,
  projection scale/offset, projection-derived focal/principal pixels in the
  depth buffer, sample phase/offset, unprojection mode, new-versus-updated voxel
  contribution, same-voxel plane-projection count, mature-overlap skip count,
  and camera basis vectors. The first
  accepted keyframe, every fifth accepted keyframe, and the
  terminal keyframe SHOULD include detailed sample-loop phase timings for depth
  lookup, unprojection, normal estimation, color sampling, and sample
  consumption/fusion. Those detailed timers SHOULD sample a fixed stride of
  surfels and report both the total profiled surfels and the number of timed
  surfels so physical-device profiling can identify hot phases without adding a
  `performance.now()` call around every surfel operation. Accepted-keyframe
  telemetry also separates initial depth append time, no-mutation mesh preflight
  time, and depth recovery append time when mesh surfels rescue a sparse or
  redundant candidate, so physical logs can distinguish true depth sampling cost
  from mesh-gate recovery double work. If depth contributes no new voxels and
  the mesh preflight alone satisfies the current surfel and new-voxel gates,
  the route SHOULD skip the second depth append entirely, zero out the
  preflight-only depth contribution before updating retained-sample counts, and
  report `depthRecoverySkipped`, because WebXR mesh geometry alone is carrying
  the accepted keyframe. The keyframe density gate SHOULD compare
  `MIN_KEYFRAME_SURFELS` against the larger of actually appended depth surfels
  and preflight-observed depth surfels, because mature-overlap skips can
  intentionally avoid fusing duplicate voxels even when the WebXR depth frame
  contains enough surface to accept.
  Keeping detailed timers periodic instead of per-keyframe preserves normal
  scan responsiveness while still making physical-device logs actionable when a
  keyframe append budget is missed. Scan mode maintains an incremental
  voxel-fusion map and publishes throttled
  `PANORAMIC_LIVE_MODEL_PROFILE` snapshots plus periodic `PANORAMIC_SCAN_STATS`
  summaries for realtime WebGPU feedback. The full model is not rebuilt on
  every XR frame, so live capture work avoids the earlier quadratic
  point-history path. Periodic scan stats MUST also be emitted on the scan loop
  before any keyframe is accepted and again when the user stops scanning, so a
  profile-only physical-device run can diagnose pose misses, depth misses,
  precheck skips, and rejection reasons even when Preview/Capture is never
  reached. The route accepts `?autorun=1` for physical-device profiling runs so
  the validator can deep-link directly into an active WebXR scan while keeping
  the normal Start Scan control for manual use. Live
  snapshot publishing uses adaptive backoff after 10k retained samples and
  reports the selected refresh interval in telemetry; manual Preview and final
  Capture still force full model builds. Manual Preview yields a frame and
  shows the building state before doing the synchronous fused-buffer build, so a
  slow device no longer makes the button look like a dead tap. If the current
  live model already matches the fusion accumulator's keyframe count, raw
  sample count, and voxel count, manual Preview and Capture reuse that model
  instead of rebuilding the same fused buffer again. User-adjusted one-finger
  orbit or two-finger pan/pinch state SHOULD be preserved across live Preview
  and Capture publishes; only the explicit Recenter control should discard that
  inspection view.
- Lazy WebXR payloads: native XR animation-frame polling returns frame metadata
  first and defers CPU depth copies until `XRCPUDepthInformation.data` is
  actually used. During panorama capture, reconstruction runs a depth-only
  preflight count before unprojecting candidate surfels or requesting
  `XRCPUCameraBinding.getCameraImage()`, so frames that fail the minimum
  valid-surfel gate do not pay for native camera preview rendering, bridge
  transfer, or full per-sample world-space reconstruction. Even after those
  gates pass, the depth append path SHOULD request the camera image lazily only
  when the first accepted depth surfel needs color, so mesh-recovered or
  otherwise empty depth passes can skip the preview-image payload. When the native
  bridge returns exact tight buffers, the WebXR `data` getters reuse those
  `ArrayBuffer`s directly instead of adding another JavaScript copy. The WebXR
  runtime retains a small ring of recent native frame snapshots rather than
  only the newest frame, because standard WebXR accessors fetch depth/camera
  payloads lazily after JS pose and keyframe gates. That retention keeps slow
  physical scans from losing a frame's `XRCPUDepthInformation.data` or
  `XRCamera` payload just because a previous JS phase took longer than a few
  ARKit frame intervals, without exposing native frame handles to app code. The
  WebXR
  implementation logs internal `PANORAMIC_NATIVE_PAYLOAD_PROFILE` telemetry for
  depth and camera payload requests, including bridge-request time and native
  copy/render time, depth validity percentage, the selected confidence
  threshold, and the percentage of depth pixels rejected by that threshold. It
  also reports whether an ARKit confidence map was used and the low/medium/high
  confidence distribution. The same internal telemetry SHOULD include the
  captured camera-image size, the `ARCamera.imageResolution` basis used for
  intrinsics scaling, and both depth-to-captured-image and depth-to-projection
  scale factors so physical-device logs can catch depth/camera orientation or
  scaling mistakes without exposing raw native intrinsics to app code.
- Geometry telemetry: final capture logs `PANORAMIC_CAPTURE_GEOMETRY` with
  bounds min/max/center, height-to-horizontal ratio, weighted centroid, average
  accepted scan direction, and normal-projected span/RMS thickness. The
  normal-projected values are diagnostic only, but they let a future flat-wall
  device log distinguish a genuinely planar reconstruction from a smeared
  coordinate cloud without exposing ARKit-only geometry fields to app code.
- WebXR mesh-backed surfel supplement: panorama sessions request optional
  `"mesh-detection"` and the WebXR runtime can expose ARKit `ARMeshAnchor`
  geometry through `XRFrame.detectedMeshes`, `XRMesh.meshSpace`, and
  `frame.getPose(mesh.meshSpace, localReferenceSpace)`. Accepted keyframes
  sample a capped set of mesh triangles into the same voxel surfel fusion
  accumulator as WebXR depth samples. Triangles that project into the current
  `XRView` may sample the current WebXR camera image; offscreen triangles still
  contribute fallback-colored geometry because their coordinates are already
  expressed through standard `XRMesh.meshSpace` and `frame.getPose()`. ARKit
  mesh surfel projection SHOULD request the current camera image lazily, only
  after a mesh sample projects into the current `XRView`, so offscreen-only
  mesh updates do not force preview-image rendering or bridge transfer. ARKit
  documents `ARMeshGeometry.normals` as
  outside-facing normals for faces, while WebXR-shaped mesh objects may also
  carry vertex-normal buffers; mesh surfel projection SHOULD choose face-normal
  or vertex-normal indexing from the normal-buffer shape and fall back to the
  triangle cross product if the normal buffer does not match either shape. Mesh
  projection also has a no-mutation preflight:
  if a depth candidate is too sparse or too redundant on its own, the route can
  still accept it when depth plus WebXR mesh surfels satisfy the same minimum
  surface and new-voxel gates. The preflight acceptance rule SHOULD match the
  append rule: projected mesh triangles count as projected surfels, while
  offscreen triangles still count as appendable fallback-colored mesh geometry
  when their world-space distance from the current camera is inside the accepted
  depth range. That preflight SHOULD stop as soon as the
  current depth candidate's missing surfel and new-voxel thresholds are met,
  because a rescue gate only needs an accept/reject answer and rejected frames
  can otherwise spend scan-loop time walking mesh samples that cannot
  change the decision. `PANORAMIC_MESH_PROFILE` reports available mesh size,
  and `PANORAMIC_KEYFRAME_PROFILE` reports how many mesh surfels were
  projected, colored, skipped, fused, whether mesh preflight recovered a depth
  gate, which normal-buffer mode was used (`face`, `vertex`, `mixed`, `other`,
  or `none`), whether the current camera image was requested for mesh color,
  and whether the no-mutation preflight exited after satisfying
  those rescue thresholds. `PANORAMIC_KEYFRAME_PROFILE` also reports `meshFetchMs`,
  the elapsed time to read `XRFrame.detectedMeshes`, so physical logs can
  separate native mesh bridge/buffer marshaling from mesh surfel projection.
  If the current depth keyframe already satisfies the surfel and new-voxel
  gates, the route SHOULD defer `XRFrame.detectedMeshes` summary reads unless
  this is the first/periodic mesh supplement check, the keyframe covers a new
  180-degree scan sector, a supplement refresh is due, or mesh preflight
  already recovered the current depth gate. New scan sectors are the moments
  most likely to expose fresh ARKit reconstruction, while `detectedMeshes`
  summary reads remain cheap and do not copy full geometry buffers. When metadata
  is read, the route SHOULD avoid full mesh-buffer projection unless
  `XRFrame.detectedMeshes` summaries show the mesh set's `lastChangedTime`
  values changed, the mesh supplement has not refreshed for several accepted
  keyframes, or mesh preflight recovered the current depth gate. This keeps
  repeated ARMeshAnchor geometry from being fetched or reprojected on every
  accepted depth keyframe while still letting standard `XRMesh` geometry
  improve scene shape when the mesh appears, changes, or is needed for
  acceptance. `PANORAMIC_KEYFRAME_PROFILE` reports whether the mesh append was
  skipped and why; `meshAppendReason: "mesh-check-deferred"` means the accepted
  depth keyframe intentionally skipped the mesh metadata read. Periodic
  `PANORAMIC_MESH_PROFILE` availability telemetry uses
  `XRFrame.detectedMeshes` and standard `XRMesh` fields rather than app-facing
  native frame metadata; the WebXR runtime may satisfy mesh-space and
  `lastChangedTime` reads from lightweight summaries and lazily fetch full
  geometry only when `vertices`, `normals`, or `indices` are observed. The
  keyframe path should read `XRFrame.detectedMeshes` lazily only after pose,
  depth, and contribution gates need mesh information; depth-only rejected
  frames should not pay to marshal full native mesh buffers. When full WebXR
  mesh payloads are fetched for accepted-keyframe reconstruction, the WebXR
  route samples dense mesh candidates by stride and should jump over unsampled
  triangle/vertex candidates rather than running centroid, projection, color,
  or fusion work for each discarded candidate; keyframe telemetry reports the
  stride-skipped mesh candidates for both append and preflight so device logs
  can distinguish intentional mesh decimation from geometric rejection. The
  WebXR runtime may also compact very dense native `ARMeshGeometry` anchors
  into lower-detail `XRMesh` vertex/index/normal payloads before crossing the
  bridge, because the app consumes standard UA-provided WebXR mesh geometry
  rather than ARKit buffer identity. `PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE`
  reports both returned payload counts and native source mesh counts, plus how
  many anchors were decimated, so physical logs can show whether mesh bridge
  bytes are still a bottleneck. The WebXR runtime logs
  `PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE` with request time plus mesh, vertex,
  index, triangle, normal, byte counts, and how many returned mesh payloads
  reused a native per-anchor cache keyed by `lastChangedTime`. The cache is
  internal to the WebXR runtime: `XRMesh` still exposes the current frame's
  mesh-space pose and cached geometry is reused only while the native
  geometry-change timestamp is unchanged. The ARKit bridge should not bump
  `XRMesh.lastChangedTime` for pose-only `ARMeshAnchor` updates; those updates
  should refresh `frame.getPose(mesh.meshSpace, localReferenceSpace)` while
  preserving the cached vertex, normal, and index buffers. This lets the
  panoramic route skip repeated mesh projection on accepted depth keyframes
  whose standard WebXR mesh objects show unchanged identity and geometry time.
  The app should compare standard `XRMesh` object identity plus
  `lastChangedTime`, not native anchor identifiers, when deciding whether the
  mesh supplement needs another full projection pass. The native
  geometry-change detector should include buffer identity, geometry counts, and
  a small evenly distributed sample hash of the buffer contents, so pose-only
  updates stay cheap without relying on just the first or last vertex to notice
  ARKit mesh refinement. The
  ARKit backing session requests scene reconstruction for the mesh and may
  enable horizontal/vertical plane detection only as internal ARKit analysis so
  scene reconstruction can smooth detected flat surfaces. Plane anchors remain
  native-only: the WebXR profile still exposes only `XRMesh` objects, mesh-space
  poses, and `lastChangedTime`, and the panorama route does not consume
  `ARPlaneAnchor` data.
- Render telemetry: after the captured model reaches a WebGPU draw with a
  nonempty surfel buffer, the viewer logs `PANORAMIC_RENDER_METRICS` with the
  canvas size, presentation format, model revision, keyframe count, surfel
  count, multi-observation percentage, quality percentages, and CPU render
  frame timing buckets. Each new live, preview, or captured model revision also
  logs `PANORAMIC_RENDER_FRAME_PROFILE` with render-frame, command-encode, and
  submit/present timings; active one-finger orbit and two-finger pan/pinch
  interactions log the same profile at a throttled cadence. Physical logs can
  therefore separate slow WebGPU drawing during direct manipulation from model
  build or upload work.
- Preview telemetry: manual Preview logs `PANORAMIC_PREVIEW_METRICS` with
  fused-model build time, keyframe/sample/surfel counts, camera-color coverage,
  multi-observation coverage, and normal coverage, so a physical-device run can
  separate a slow Preview tap from final Capture, scan overlap, WebGPU upload,
  or render bottlenecks.
- WebGPU upload telemetry: model revisions log `PANORAMIC_MODEL_UPLOAD_PROFILE`
  with upload time, surfel byte count, and whether a larger reusable vertex
  buffer had to be allocated.
- Export telemetry: successful Save logs `PANORAMIC_EXPORT_METRICS` with the
  Files-visible path, file URI, byte count, keyframe count, and surfel count
  only after the Documents file exists and reports a nonzero size.
- Scan controls: the route keeps the native dark header Start/Stop action and
  also exposes the same Start Scan / Stop Scan action in the Expo UI command
  cluster so physical-device validation does not depend on discovering header
  chrome.
- `model-view`: renders live and frozen surfel clouds with smaller instanced
  WebGPU splats, one-finger orbit, two-finger pan/pinch interaction, depth
  testing, and model statistics. Single-observation surfels render with smaller
  splats than repeatedly observed fused surfels, reducing overdraw and making
  noisy singleton depth cells less visually dominant without removing them from
  the captured/exported model. The preview canvas owns gestures once they become
  a drag or pinch, so simple taps do not disable live auto-recentering and real
  model inspection touches do not scroll the route or trigger horizontal
  navigation.
  The viewer does not auto-orbit; the user's finger controls rotation for both
  live preview and frozen captures. Gesture deltas update a viewer ref consumed
  directly by the WebGPU render loop instead of writing React state on every
  touch move, keeping orbit/pinch responsive while scans are being fused. The
  render loop SHOULD write the model-view-projection directly into its reusable
  uniform array, avoiding temporary matrix/vector allocations during every
  gesture frame.
  Recenter is available once either a live preview model or a frozen captured
  model exists, and chooses its default yaw from the average accepted keyframe
  forward direction so a forward 180-degree sweep opens from the side the user
  scanned from, rather than from an arbitrary world-axis orbit angle. Live scan
  snapshots keep auto-recentering around the evolving accepted keyframe average
  until the user manually orbits, pans, or pinches the preview; after that,
  automatic live updates preserve the user's chosen inspection view. Coverage
  sectors are recomputed relative to the average accepted keyframe forward
  direction, so the 180-degree hint follows the user's actual scan arc instead
  of assuming ARKit world yaw starts aligned with the app's desired scan center.
  The model-view orbit target uses the fused surfels' weighted center rather
  than the bounds midpoint, because a 180-degree partial sweep can have an
  asymmetric bounding box or a low-weight outlier that would otherwise make the
  scanned surfaces appear off-position in live Preview and after Capture.
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

- App-readable native confidence map exposure or confidence-weighted native
  surfel generation. Current native code only uses confidence internally to
  invalidate depth samples below the selected ARKit confidence threshold.
- Physical-device proof that a captured flat wall has correct metric scale and
  camera/depth alignment.
- Physical-device proof that mesh-backed surfel supplementation improves flat
  wall/room geometry without blowing the keyframe append budget.
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
- Apple's scene-depth point-cloud sample places each depth pixel with
  `ARCamera.intrinsics`: `x = (pixelX - ox) * depth / fx` and
  `y = (pixelY - oy) * depth / fy`, then colors the point from the same
  normalized camera-image coordinate. The WebXR profile should therefore keep
  native intrinsics behind the implementation boundary but expose equivalent
  `XRViewGeometry.projectionMatrix` values for the depth plane.
- `ARFrame.displayTransform(for:viewportSize:)` is for rotating/cropping the
  raw captured image into a UI viewport. It should not be applied to the
  scene-depth geometry path unless the WebXR view is explicitly defined as that
  display-oriented viewport; otherwise it can bake UI aspect/crop into world
  coordinates and make a scan look spatially warped.
- `ARCamera.transform` is a camera-to-world transform whose local axes are
  constant with respect to device orientation. That makes it the right native
  source for a WebXR `"local"` viewer pose when the projection matrix describes
  the raw camera/depth plane rather than a UIKit view.
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
- Apple ARKit `ARCamera.transform` - https://developer.apple.com/documentation/arkit/arcamera/2866108-transform
- Apple ARKit `ARFrame.displayTransform(for:viewportSize:)` - https://developer.apple.com/documentation/arkit/arframe/displaytransform(for:viewportsize:)
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
- 180-degree coverage ring or mini-map hint
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
  // No app-facing trackingState field: non-normal native tracking is surfaced
  // through WebXR's existing null-pose path.

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
  center: [number, number, number];
  surfels: ArrayBuffer;
  surfelCount: number;
  vertexFormat: "position_radius_color_normal";
}
```

The WebXR Depth Sensing spec mixes `XRViewGeometry` into
`XRDepthInformation`, so the repo-local profile exposes `projectionMatrix` and
`transform` on both `XRView` and `XRDepthInformation`. For
`matchDepthView === true`, these fields describe the same view. Panoramic
reconstruction requests a standard WebXR `"local"` reference space and uses
those standard geometry fields rather than exposing ARKit camera intrinsics or
tracking transforms as app-facing extensions. The screen-relative LiDAR demo may
continue to request `"viewer"`, where the viewer pose is identity.

The current `LiDARDepthSource` returns display-oriented 256x192 BGRA camera
bytes generated by `makeCameraPreviewFrame()`. That is sufficient for surfel
color sampling, but it is not automatically geometry-grade texture input.
The frame payload separately exposes `normCameraImageFromNormView` so camera
colors are sampled in the returned `XRCamera` image plane while geometry stays
anchored to the WebXR depth/view projection.
For the common ARKit bi-planar YCbCr captured-image formats, the native WebXR
runtime should produce that 256x192 BGRA preview with a direct aspect-fill
downsample and YCbCr-to-BGRA conversion, falling back to CoreImage only for
unhandled pixel formats. Physical logs report the preview path so a slow
`cameraPreviewMs` bucket can be attributed to the direct converter or fallback
renderer without adding any app-facing native camera API.

## Keyframe policy

The app SHOULD retain a keyframe only when it contributes new geometry.

Initial thresholds:

- at least 12 degrees of camera rotation since the previous accepted keyframe,
  or at least 12 cm of translation
- at least 360 ms since the previous accepted keyframe
- `frame.getViewerPose(referenceSpace) !== null`, which this profile maps to
  ARKit normal camera tracking, so pose tracking is stable enough for
  world-space fusion
- reject very fast motion, using WebXR pose/time only, before requesting CPU
  depth/camera bytes; the 180-degree scan target uses about 80 degrees/second
  or 0.65 meters/second between accepted keyframes so smoothed scene depth is
  less likely to lag behind the retained pose
- reject rotation-only revisits of an already-covered 180-degree scan sector
  before requesting CPU depth/camera bytes, while still allowing same-sector
  keyframes that have enough translation to add parallax and new voxels
- depth frame has enough valid samples and, when available, enough medium/high
  confidence samples
- exposure/motion blur is not obviously corrupting the camera keyframe
- cap at about 18 keyframes for the 180-degree first milestone, matching the
  six yaw by three pitch coverage sectors instead of collecting extra
  full-sweep-style keyframes

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
   outside the configured range, or below the native confidence threshold when
   a confidence map is available). In the current WebXR implementation, raw
   ARKit scene-depth samples below high confidence are filtered natively into
   `0` depth values instead of exposing a non-standard confidence field to app
   code.
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

The current TypeScript surfel MVP applies the distance weight and reduces the
fusion weight for samples whose normal estimator had to fall back because the
neighboring depth footprint was invalid or discontinuous. This keeps edge/noisy
observations useful for coverage without letting them pull fused voxel positions
as strongly as locally continuous surface samples.
Once a voxel has an accumulated reliable normal, later observations that land in
that same voxel and have an agreeing reliable normal SHOULD project their
position onto the voxel's local fused plane before updating the coordinate
average. This keeps repeated wall or tabletop observations from pulling the
fused surfel along the surface normal because of small depth jitter, while the
voxel grid still bounds how much sub-voxel detail can be collapsed.
`PANORAMIC_KEYFRAME_PROFILE` SHOULD report how many depth and mesh samples were
plane-projected so physical-device logs can distinguish the stabilization path
from ordinary same-voxel averaging and relate it to `sampleConsumeMs`.

Dynamic or reflective objects will still create ghosts. The MVP should not
promise metrology-grade scans; it is a panoramic scene capture suitable for
visualization.

### WebXR depth-geometry unprojection

ARKit provides both raw imaging parameters and orientation/viewport-adjusted
rendering geometry. For scene reconstruction, the repo-local WebXR profile
uses ARKit's point-cloud approach natively: scale `ARCamera.intrinsics` to the
scene-depth buffer and convert it into a WebXR/OpenGL-style projection matrix
for `XRView.projectionMatrix` and `XRDepthInformation.projectionMatrix`, while
`ARCamera.transform` feeds `XRView.transform` and
`XRDepthInformation.transform`. Because WebXR normalized depth coordinates use
texel centers such as `(column + 0.5) / width`, the intrinsics-derived
projection matrix SHOULD include the half-pixel principal-point adjustment that
maps those normalized centers back to ARKit's integer depth-pixel centers.
Otherwise depth/color sampling and unprojection describe rays that are offset
from one another by half a depth pixel.

The TypeScript surfel pipeline reads depth samples through
`normDepthBufferFromNormView`, unprojects normalized view coordinates with
`projectionMatrix`, and then applies `transform` as camera-to-world. This keeps
the app-facing AR geometry inside WebXR's `XRViewGeometry` surface. If a future
native reconstruction path needs raw `ARCamera.intrinsics`, it should either
keep that math native or map the result back to standard WebXR geometry rather
than adding an intrinsics field to `XRDepthInformation`.

When the surfel pipeline uses edge-aware bilinear depth sampling instead of
`XRCPUDepthInformation.getDepthInMeters()`, it SHOULD still follow WebXR's
normalized depth-buffer convention: transform normalized view coordinates by
`normDepthBufferFromNormView`, scale by the depth buffer `width` and `height`,
then convert into pixel-center space before interpolation. WebXR CPU depth
tests treat `(column + 0.5) / width` and `(row + 0.5) / height` as a depth
pixel center, so bilinear reconstruction should not shift every sampled
footprint half a pixel away from the ARKit depth/camera alignment. This keeps
reconstruction samples aligned with the same coordinate system that
`getDepthInMeters()` exposes, while preserving the smoother local interpolation
needed for normals and surfel quality.

The JS hot path SHOULD avoid per-surfel temporary `Vec3` allocation. The
current surfel pass reuses scratch vectors for unprojection, transform, normal
estimation, view-alignment weighting, and color fallback, then appends scalar
fields directly into the voxel accumulator. The direct fusion path SHOULD avoid
a per-sample callback layer and second helper call; only the legacy
array-building helper needs a consumer callback. Voxel indexing SHOULD multiply
by a precomputed inverse voxel size in the scan hot loop. Accepted-keyframe
depth fusion SHOULD compute each valid sample's voxel key once, reuse the same
map lookup for mature-overlap rejection and final fusion, and only compute
normal/color work for samples that survive that cheap overlap gate. Accepted
keyframes SHOULD cache the `XRView.transform` camera-to-world axes once, then
reuse that cache for per-surfel point placement and normal rotation instead of
repeatedly indexing the same matrix through generic helpers. This keeps the
implementation transparent and WebXR-only while reducing the
`PANORAMIC_KEYFRAME_PROFILE` `appendMs` bucket enough to decide whether
native-side reconstruction is still needed after physical-device profiling. The
route SHOULD reject pose-only
non-keyframes before calling `XRFrame.getDepthInformation(view)`, so frames that
are too soon, too similar, too fast, outside scan mode, or rotation-only
revisits of an already-covered 180-degree sector do not allocate per-frame CPU
depth objects or request camera-color data. `PANORAMIC_SCAN_STATS` reports
`depthPrecheckSkips`, `depthInfoRequests`, and rejection reasons such as
`covered-sector` to make that gating visible in physical-device logs. After
physical-device profiling showed delayed WebXR delivery collapsing several
native frame timestamps into the first keyframe interval, the route's interval
and speed policy SHOULD use JS callback wall time while still using the WebXR
pose and depth data from the current `XRFrame`. After
that pose precheck succeeds, the app SHOULD only allow preflight gates based on
valid surfel count and new voxel contribution to reject the candidate; it must
not append surfels and then reject the frame for pose/time reasons. After the
first accepted keyframe, the scan path SHOULD classify the candidate direction
against the current accepted scan center and require world-space new-voxel
contribution before requesting the CPU camera image or running the full
color/normal fusion pass. Newly-covered 180-degree coverage sectors can use a
lighter contribution threshold than already-covered sectors, but they should
still prove they add geometry before the expensive camera-color and
normal-fusion path runs. Already-covered sectors should be skipped at the
pose-only precheck when camera translation is below the keyframe translation
threshold; translated same-sector views can still proceed because parallax may
add useful geometry. This keeps expanding the 180-degree scan while avoiding
keyframes that mostly revisit already-fused geometry. When a new-voxel
contribution gate is active, that contribution preflight SHOULD also count
valid surfels and stop only after both the new-voxel threshold and minimum
surfel threshold are satisfied, instead of running a separate valid-depth
preflight over the same sparse WebXR grid first. Once the new-voxel threshold
is already satisfied, any remaining minimum-surfel proof can count valid depth
samples without unprojecting them into world space or computing voxel keys,
because only the surface-density gate is still undecided. The contribution preflight
SHOULD reuse accumulator-owned scratch storage for candidate voxel keys,
because rejected redundant frames are common during slow scans and should not
allocate a fresh key set on each XR frame.
Accepted keyframes also maintain a per-keyframe sparse-depth cache so
the valid-depth preflight, center samples, and neighboring samples used for
normal estimation do not repeatedly resample the same WebXR depth-grid
locations. `PANORAMIC_KEYFRAME_PROFILE` reports the actual cached depth-grid
sample count. It also reports how many retained samples created new voxels
versus updated existing voxels for the current keyframe, while
`PANORAMIC_SCAN_STATS` reports scan-wide new and updated voxel contribution, so
a physical-device log can distinguish useful 180-degree scan coverage from
redundant keyframes. The incremental fusion accumulator SHOULD retain the
sparse-depth cache backing arrays across accepted keyframes and report
`depthCacheReused` so physical-device logs can distinguish sample work from
allocation churn. The sparse cache SHOULD also retain camera-space points
unprojected from `XRView.projectionMatrix` for each sampled depth-grid location
within the accepted keyframe, and report `cameraPointCacheHits` and
`cameraPointSamples` so normal-estimation cost can be separated from repeated
unprojection work. For the common intrinsics-derived WebXR projection matrix,
the cache SHOULD also precompute per-axis camera ray coefficients once per
accepted keyframe so surfel and normal-neighbor unprojection only multiplies
those coefficients by depth in the scan hot loop. The cache SHOULD precompute
normal-neighbor grid indexes and forward/backward signs once per accepted
keyframe so normal estimation does not recompute sparse-grid coordinates and
edge-direction branches for every retained surfel. The scan hot path SHOULD
classify `normDepthBufferFromNormView` once per keyframe and use direct identity
or affine sampling paths when the WebXR depth buffer is already view-aligned,
falling back to the projective normalized transform only when needed. For the
common identity transform, the cache SHOULD also precompute per-axis depth pixel
indices and bilinear weights once per accepted keyframe, preserving the WebXR
normalized-coordinate behavior while removing repeated floor/clamp/weight work
from each sparse-grid sample. `PANORAMIC_KEYFRAME_PROFILE` reports
`depthGridSampleMode` so physical-device validation can distinguish the cheap
precomputed identity path from normalized-transform fallback sampling. When
  converting the fusion map into a renderable `Float32Array`, the accumulator
  SHOULD retain reusable CPU backing storage and return exact-length views for
  each published model. This keeps WebGPU uploads exact while avoiding a fresh
  large backing allocation for every live-preview model build.

When the WebXR projection matrix has the intrinsics-derived perspective shape
used by the native ARKit scene-depth bridge, the JS surfel pass SHOULD
unproject directly from that matrix instead of inverting and multiplying a
general 4x4 matrix for every sample. This is still a WebXR-only app contract:
the app consumes `XRDepthInformation.projectionMatrix`, not a raw
`ARCamera.intrinsics` field. The incremental voxel accumulator SHOULD use a
packed numeric key for the common room-scale coordinate range and fall back to
string keys outside that range, preserving exact voxel identity while reducing
per-sample allocation pressure during accepted keyframes.
Contribution preflight for already-covered scan sectors SHOULD reuse the
accumulator's scratch voxel-key set and transient point vectors, since that path
runs most often on frames rejected before camera-color sampling.
Detailed keyframe telemetry SHOULD include a center-view depth sample,
camera-space point, and world-space point from the same WebXR projection path.
Those values let physical-device logs catch projection, pose, or axis mistakes
without adding raw native intrinsics to the app contract.

Camera color sampling SHOULD also classify `normCameraImageFromNormView` once
per accepted keyframe, then use an identity, affine, or projective sampler for
the per-surfel bilinear read. When that standard WebXR transform is
axis-aligned, the sampler SHOULD precompute sparse-grid camera pixel indices and
bilinear weights once per accepted keyframe, then reuse them for every surfel
color lookup. `PANORAMIC_KEYFRAME_PROFILE` reports `cameraTransformMode` and
`cameraSampleMode` so physical-device logs show whether color sampling is
staying on the cheap precomputed path or paying for per-sample normalized
transform work. This remains a WebXR-shaped app contract because the sampler
consumes the standard normalized camera image transform exposed by
`XRWebGLBinding`/the repo-local CPU binding analog.

For the panoramic surfel accumulator, the app's WebXR session SHOULD request
`depthTypeRequest: ["smooth", "raw"]`. ARKit's scene-depth point-cloud guidance
places each depth-map value in camera space with camera intrinsics, and ARKit
documents smoothed scene depth as reducing frame-to-frame distance deltas. This
demo expects the user to perform a deliberate slow 180-degree sweep, so the
first choice should favor stable world-space surface coordinates and fall back
to high-confidence raw scene depth only when smoothed depth is unavailable. The
keyframe policy still rejects fast camera motion to limit lagged samples.
`PANORAMIC_KEYFRAME_PROFILE` reports the selected `depthType` so
physical-device logs can confirm which standard WebXR depth mode was active.
This preference remains a standard WebXR request option; the app MUST NOT call a
custom native depth-type API directly.

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

The WebXR-shaped API borrows from the Real World Meshing draft without claiming
conformance. The current repo-local shape is:

```ts
interface XRMesh {
  readonly meshSpace: XRMeshSpace;
  readonly vertices: Float32Array;
  readonly normals: Float32Array | null;
  readonly indices: Uint32Array;
  readonly lastChangedTime: DOMHighResTimeStamp;
  readonly semanticLabel: string | null;
}

interface WebXRFrame {
  readonly detectedMeshes: XRMeshSet;
  getPose(space: XRMeshSpace, baseSpace: XRReferenceSpace): XRPose | null;
}
```

`vertices`, `normals`, and `indices` are anchor-local buffers; the renderer must
ask `frame.getPose(mesh.meshSpace, localReferenceSpace)` and apply that pose to
place them in world space. The native layer must also surface add/update/remove
semantics through changing `detectedMeshes` entries, because ARKit can refine or
replace mesh anchors as tracking improves.

The current route consumes this mesh as a surfel supplement rather than a
separate triangle renderer: accepted keyframes sample triangle centroids,
project them through the current WebXR view/camera image for color when
possible, and fuse them into the existing voxel surfel accumulator. ARKit scene
reconstruction is useful for large planar structure, but it will still contain
holes, delayed updates, and smoothed geometry that may not align exactly with a
single RGB keyframe.

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
  blobs; after roughly 10k rendered surfels, reduce the base splat size as
  density grows to limit fragment overdraw on device GPUs
- shade with camera color, optional normal lighting, and a subtle confidence
  fade; color mode should preserve the sampled camera color with only a low
  luminance floor so black or unavailable camera pixels do not make the surfel
  cloud disappear
- keep splats mostly opaque in the first version so depth testing remains
  predictable; transparent splats require sorting or an order-independent
  transparency pass
- make surfel rendering dirty-driven: model revisions, view-mode changes, and
  viewer gestures mark the canvas dirty, and unchanged animation frames should
  skip command encoding/submission. The model view has no time-based animation,
  so continuous WebGPU submission only competes with scan/fusion work. The
  implementation SHOULD also avoid a perpetual JavaScript render RAF; it should
  schedule a canvas frame only after one of those dirtying events so idle
  scanning leaves more JS time for WebXR frame handling and surfel fusion.

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
- confidence-filtered WebXR depth payloads that preserve standard invalid
  depth semantics by replacing ARKit samples below the selected confidence
  threshold with `0`
- per-frame `XRViewGeometry` projection/transform fields on
  `XRDepthInformation`

Future reconstruction quality work needs either:

- app-readable depth confidence through a future standard-shaped extension, or
- a native unprojection/downsample method that returns world-space surfels for
  selected frames while still mapping the result back to standard WebXR
  geometry.

The second option is likely faster and reduces bridge pressure, but the first
option keeps the geometry pipeline more transparent in TypeScript. The first
implementation should start with TypeScript reconstruction at reduced
resolution, then move unprojection/voxelization native-side only if profiling
shows the bridge or JS loop is the bottleneck.

Do not assume the current 256x192 preview bytes are sufficient for texture
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
- do not retain full-resolution BGRA camera frames for every keyframe in the
  surfel MVP; sample colors into surfels promptly or keep a deliberately
  downsampled color image. The current native WebXR camera image is 256x192
  BGRA for this reason.
- cap memory by keyframe count and point count
- prefer `bgra8unorm` over JS BGRA-to-RGBA conversion
- avoid full-resolution CPU texture atlasing in the scan loop
- keep the per-sample reconstruction hot path allocation-light; depth sampling
  and normal estimation run several times per retained surfel, so they should
  not allocate temporary objects for each bilinear footprint. The current
  scan path passes retained surfel fields as scalars into the fusion
  accumulator and reuses scratch storage for camera/depth fallback colors
  instead of allocating one sample object or color vector per surfel.
- insert accepted keyframes directly into the incremental fusion accumulator
  after the minimum-valid-surfel preflight succeeds. Keeping a separate
  candidate point array is only useful for tests/export helpers; it adds memory
  churn and a second JS walk to the scan loop.
- build live model snapshots by iterating the fusion accumulator directly
  into the `Float32Array` uploaded to WebGPU. Do not copy the voxel map values
  into an intermediate array on every live preview revision.
- reuse an already-published live model for manual Preview or Capture when its
  keyframe count, raw sample count, and fused voxel count exactly match the
  current fusion accumulator, so a tap immediately after an automatic live
  snapshot does not pay for an identical model build.
- during live scan, keep fused model snapshots fresh while measured rebuilds
  are cheap, then back off as retained samples pass 10k/25k/45k or as previous
  build time grows. Physical logs showed 10k-14k sample rebuilds around
  11-16ms, so the 10k-sample refresh target should stay near one third of a
  second and a one-second-plus sample-count backoff should be reserved for much
  denser scans or actually expensive model builds.
- reuse WebGPU surfel vertex buffers with coarse capacity growth instead of
  destroying and reallocating a tightly sized buffer for every live model
  revision
- reuse the small uniform array across WebGPU draws instead of allocating it on
  every animation frame.
- profile on a physical LiDAR device with `WEBGPU_DEMO_PROFILE`-style logs

Suggested first caps:

- 18 keyframes for a forward 180-degree sweep
- 20k surfels per keyframe before voxel merge
- 48k retained surfels total in the TypeScript/WebGPU MVP
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
- the panorama route keeps AR access behind WebXR-shaped
  `immersive-ar`/`depth-sensing`/`camera-access` calls and does not call direct
  native LiDAR helpers (`bun test src/lib/panoramic-scene-capture-route.test.ts`)
- the panorama route keeps the capture, WebGPU render, and Files export
  telemetry wired in the order expected by the physical validator
  (`bun test src/lib/panoramic-scene-capture-route.test.ts`)

Manual/device validation:

- non-LiDAR device reports unsupported
- simulator reports unsupported
- start/stop/capture releases the camera correctly
- a checkerboard or taped rectangle has low RGB/depth alignment error
- panning a flat wall produces a flat reconstructed wall
- a wall measured at a known distance has plausible scale, not just plausible
  appearance
- surfel placement is validated with the ARKit intrinsics-derived WebXR
  projection for the scene-depth plane, while camera colors are sampled through
  `normCameraImageFromNormView` instead of assuming the returned camera preview
  has the same resolution as the depth buffer
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
bun run validate:panorama:ios -- \
  --device <device-name-or-id> \
  --install-app ./.build/ios-device/standardcameraapp.app \
  --metro-url <lan-metro-url>
```

The `--install-app` flag is optional, but it should be used after a successful
physical-device build so launch/install retries reuse the cached `.app` instead
of rebuilding native code. The validator launches the dev-client build through
the `expo-development-client` URL with `disableOnboarding=1`, opens the
panorama demo route only after handing the build its Metro URL, and then waits
for the phone interaction. Use the phone to Start Scan, pan slowly until surfels
appear, Capture, and Save. The validator
passes only after it sees nonzero keyframe, capture, WebGPU-render, and
Files-export telemetry from the physical app logs, and the required
capture/render/export metrics agree on the captured model's keyframe, sample,
and surfel counts. Export telemetry must also name the Files-visible `.ply`
path. The validator enforces explicit speed and quality budgets by default:
keyframe append under 160 ms, capture/render model build under 2 seconds,
camera color coverage at least 25%, normal coverage at least 20%, stable
multi-observation coverage at least 20% on both capture and render, 180-degree
scan coverage at least 25% when scan stats are present, nonzero scene bounds,
no more than the configured sparse depth-grid sample budget per keyframe, and
the expected `intrinsics-projection` unprojection mode when that field is
present. When keyframe telemetry reports `depthType`, validation also
expects `"smooth"` so a physical run cannot silently fall back to noisier raw
geometry for the deliberate 180-degree panorama fusion path. These budgets can be
overridden with the validator's `--max-*`/`--min-*` flags when profiling a
different device class. The validator
prints optional profiling telemetry (`PANORAMIC_LIVE_MODEL_PROFILE`,
`PANORAMIC_MODEL_UPLOAD_PROFILE`, `PANORAMIC_NATIVE_PAYLOAD_PROFILE`,
`PANORAMIC_KEYFRAME_REJECTION_PROFILE`, `PANORAMIC_NATIVE_MESH_PAYLOAD_PROFILE`,
`PANORAMIC_PREVIEW_METRICS`, `PANORAMIC_RENDER_FRAME_PROFILE`, `PANORAMIC_SCAN_STATS`,
`PANORAMIC_XR_FRAME_PUMP_PROFILE`, `PANORAMIC_XR_POSE_PROFILE`, and
`PANORAMIC_CAPTURE_GEOMETRY`) when those lines appear before the required
end-to-end metrics complete, and validates the optional preview/live
build/upload budgets when present. `PANORAMIC_XR_FRAME_PUMP_PROFILE` reports
whether the WebXR animation-frame loop is waiting on no native frame or a stale
depth frame, plus periodic successful delivery counts and native AR
frame/depth-miss counters, so physical logs can separate ARKit depth starvation
from JavaScript keyframe gating.
`PANORAMIC_KEYFRAME_REJECTION_PROFILE` reports the latest throttled keyframe
skip reason with pose motion, retained surfel count, depth/miss counters, and
depth/mesh preflight density when available, so a run that captures no new
surfels can be distinguished as pose gating, depth starvation, or sparse
surface contribution. If the WebXR scan frame callback throws, the route SHOULD
record a `scan-loop-error` rejection profile and keep scheduling frames while
the same session is still scanning; a single transient callback error must not
leave the visible preview stuck on the first accepted surfel batch. Repeated keyframe,
preview, live-model, render-frame, upload, and native-payload telemetry is
merged conservatively: the latest model counts are kept for
capture/render/export consistency, while the worst observed timing, worst
depth-grid sample count, lowest quality percentage, and any non-fast-path
unprojection, depth-grid sampling, or camera-color sampling mode, plus any
non-smooth depth type, are kept for budget checks and profiling output.
The validator SHOULD print a
compact bottleneck summary that ranks observed timing buckets and includes
fast-path, depth-type, projection-pixel, capture-quality, native depth-validity,
native depth range, native depth/camera scale, native mesh payload size, and
scan-loop context so a future device log can immediately distinguish slow
native payload work, invalid or out-of-range depth, JS sample-loop work, model
build, WebGPU upload, preview, render, export phases, and scan-quality misses
from pose loss, missing depth, pose precheck skips, or keyframe rejection
reasons. The scan-loop summary SHOULD include coverage percentage, scan-frame
rate, accepted-keyframe rate, and retained sample count so a 180-degree scan
that simply did not cover enough sectors is separable from one with slow model
work or bad projection math. When geometry telemetry is present, the
summary SHOULD also include the normal-projected span/RMS thickness and normal
coherence so a flat-wall scan can be checked for world-coordinate smear from
logs alone. When only the first keyframe is accepted, the summary SHOULD also
classify the likely first-frame failure mode as native frame starvation,
scan-loop callback failure, or post-first keyframe-gate rejection. A
`--out-json <path>` mode SHOULD write the same merged metrics,
missing required metric list, validation/profile-only status, timestamp, and
bottleneck summary to a durable JSON report so physical-device collections can
be attached or reanalyzed without terminal scrollback. A `--log-file` mode MAY
parse copied device logs through the same merger, budget checks, and bottleneck
summary without connecting to the phone; this keeps pasted physical-device logs
actionable while the device is unavailable. A `--profile-only` mode MAY skip
the required end-to-end validation gate and collect whatever panorama telemetry
appears within the timeout; this is for debugging broken or incomplete physical
runs and must not replace the full validation command above when declaring the
panorama flow done. Its parsing, consistency, budget checks, and bottleneck
summary are covered by
`bun test scripts/validate-panorama-ios.test.ts`. If CoreDevice refuses launch
because the phone is locked, unlock the iPhone and rerun the same validator
command.

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
