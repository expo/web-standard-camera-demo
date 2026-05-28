# LLP 0013: WebXR-shaped LiDAR depth API

**Type:** Spec
**Status:** Active / Research implementation
**Systems:** demo, webxr-lidar-api, standard-camera-native-extension
**Author:** James Ide
**Date:** 2026-05-25
**Related:** 0000, 0001, 0010, 0012, 0014, 0015, 0016, 0017

## Summary

This LLP specifies the WebXR-shaped API used by the LiDAR Depth Studio demo.
The demo still depends on a private native ARKit sidecar, but application code
talks to `navigator.xr` instead of calling native LiDAR frame getters directly.

This is not a commitment to implement full WebXR. It is a concrete research
spec and implementation track so we can evaluate the API shape honestly. The
API borrows from:

- WebXR Device API: `navigator.xr`, `XRSession`, `XRFrame`, `XRView`,
  `XRReferenceSpace`, and `XRSession.requestAnimationFrame()`
- WebXR Augmented Reality Module: `immersive-ar`
- WebXR Depth Sensing Module: `depth-sensing`, `XRCPUDepthInformation`,
  `rawValueToMeters`, `normDepthBufferFromNormView`
- WebXR Raw Camera Access Module: `camera-access`, `XRCamera`

The current LiDAR demo is WebGPU/WGSL, while standardized WebXR camera and GPU
depth paths are WebGL-oriented. This spec therefore defines a minimal
WebXR-shaped profile with CPU-visible camera and depth bytes so the current
WebGPU renderer can upload them to `GPUTexture`s itself.

## Normative Sources

- WebXR Device API: https://www.w3.org/TR/webxr/
- WebXR Augmented Reality Module: https://www.w3.org/TR/webxr-ar-module-1/
- WebXR Depth Sensing Module: https://www.w3.org/TR/webxr-depth-sensing-1/
- WebXR Raw Camera Access Module: https://immersive-web.github.io/raw-camera-access/

In-repo scoped source slices:

- [LLP 0014: WebXR Device API](./0014-webxr-device-api-spec-slices.spec.md)
- [LLP 0015: WebXR Augmented Reality Module](./0015-webxr-ar-module-spec-slices.spec.md)
- [LLP 0016: WebXR Depth Sensing Module](./0016-webxr-depth-sensing-spec-slices.spec.md)
- [LLP 0017: WebXR Raw Camera Access](./0017-webxr-raw-camera-access-spec-slices.spec.md)

## Conformance Model

The keywords MUST, SHOULD, MAY, and MUST NOT are used in the RFC 2119 sense for
this proposed repo-local API.

An implementation conforming to this LLP is not a conforming WebXR user agent.
It is a WebXR-shaped Expo/native research profile intended only to evaluate the
LiDAR demo surface. Any code that installs `navigator.xr` under this LLP MUST
label the surface experimental and MUST NOT imply general browser compatibility.

Section anchors below are stable; code annotations may cite them as
`@ref LLP 0013#<anchor>`.

## Goals

1. Express the current LiDAR demo in WebXR-shaped application code.
2. Keep the WebXR surface small enough to implement on top of ARKit scene depth.
3. Preserve the demo's WebGPU renderer by exposing CPU-visible camera/depth
   bytes that JS can upload into `GPUTexture`s.
4. Keep `getUserMedia` separate. The WebXR-shaped API MUST NOT add LiDAR or
   depth to `navigator.mediaDevices`.
5. Make privacy and permission boundaries explicit: raw camera frames and
   real-world geometry are gated by explicit feature descriptors and native
   camera permission.

## Non-goals

- No general WebXR runtime.
- No WebXR input sources, controllers, hand tracking, hit testing, anchors,
  planes, bounded-floor spaces, DOM overlays, layers, stereo rendering, or
  world-space UI. Mesh access is limited to the repo-local
  `"mesh-detection"` research slice below.
- No WebGL rendering path for this demo.
- No attempt to claim compatibility with browsers that implement WebXR.
- No Media Capture depth track or `videoKind: "depth"` implementation.

## Supported Profile

This repo-local profile supports exactly:

- `XRSessionMode`: `"immersive-ar"`
- `XRReferenceSpaceType`: `"viewer"` and `"local"`
- Feature descriptors:
  - `"depth-sensing"`
  - `"camera-access"`
  - `"mesh-detection"` as an optional Real World Meshing draft slice
- Depth usage:
  - `"cpu-optimized"`
- Depth data format:
  - `"float32"`
- Depth type:
  - selected from `depthTypeRequest`
  - `"raw"` maps to ARKit current-frame scene depth
  - `"smooth"` maps to ARKit smoothed scene depth
- View count:
  - exactly one `XRView` per frame
  - `XRView.eye === "none"`

Unsupported modes, reference spaces, features, usages, formats, or view counts
MUST reject or return `null` as specified below.

## Application Shape

A LiDAR demo written against this API would look like:

```ts
async function startLiDARDepthStudio(device: GPUDevice): Promise<XRSession> {
  const supported = await navigator.xr.isSessionSupported("immersive-ar");
  if (!supported) {
    throw new DOMException("LiDAR AR is unavailable", "NotSupportedError");
  }

  const session = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["depth-sensing", "camera-access"],
    depthSensing: {
      usagePreference: ["cpu-optimized"],
      dataFormatPreference: ["float32"],
      depthTypeRequest: ["smooth", "raw"],
      matchDepthView: true,
    },
    cameraAccess: {
      usagePreference: ["cpu-optimized"],
      formatPreference: ["bgra8unorm", "rgba8unorm"],
      matchCameraView: true,
    },
  });

  const referenceSpace = await session.requestReferenceSpace("viewer");
  const cpuCameraBinding = new XRCPUCameraBinding(session);

  session.requestAnimationFrame(function onXRFrame(time, frame) {
    session.requestAnimationFrame(onXRFrame);

    const pose = frame.getViewerPose(referenceSpace);
    const view = pose?.views[0];
    if (!view) return;

    const camera = view.camera;
    const cameraImage = camera ? cpuCameraBinding.getCameraImage(camera) : null;
    const depth = frame.getDepthInformation(view);
    if (!cameraImage || !depth) return;

    uploadCameraToWebGPU(device, cameraImage);
    uploadDepthToWebGPU(device, depth);

    const centerDepthMeters = depth.getDepthInMeters(0.5, 0.5);
    renderLiDARDepthStudio({ camera: cameraImage, depth, centerDepthMeters });
  });

  return session;
}
```

The `cameraAccess` dictionary and `XRCPUCameraBinding` are repo-local extensions.
Standard Raw Camera Access uses `view.camera` plus
`XRWebGLBinding.getCameraImage(camera)` to return an opaque `WebGLTexture`; that
does not fit this demo's WebGPU upload path. The demo therefore uses a
binding-shaped CPU analog instead of adding new app-facing data to `XRFrame`.

## IDL Surface

The following TypeScript-like IDL describes the intended JS surface. It is not
literal Web IDL.

```ts
type XRSessionMode = "immersive-ar";
type XRReferenceSpaceType = "viewer" | "local";
type XRFeatureDescriptor = "depth-sensing" | "camera-access" | "mesh-detection";

type XRDepthType = "raw" | "smooth";
type XRDepthUsage = "cpu-optimized";
type XRDepthDataFormat = "float32";

type XRCameraUsage = "cpu-optimized";
type XRCameraFormat = "rgba8unorm" | "bgra8unorm";

interface XRSessionInit {
  requiredFeatures?: XRFeatureDescriptor[];
  optionalFeatures?: XRFeatureDescriptor[];
  depthSensing?: XRDepthStateInit;
  cameraAccess?: XRCameraAccessStateInit;
}

interface XRDepthStateInit {
  usagePreference: XRDepthUsage[];
  dataFormatPreference: XRDepthDataFormat[];
  depthTypeRequest?: XRDepthType[];
  matchDepthView?: boolean;
}

interface XRCameraAccessStateInit {
  usagePreference: XRCameraUsage[];
  formatPreference: XRCameraFormat[];
  matchCameraView?: boolean;
}

interface XRSystem extends EventTarget {
  isSessionSupported(mode: XRSessionMode): Promise<boolean>;
  requestSession(mode: XRSessionMode, options?: XRSessionInit): Promise<XRSession>;
}

interface XRSession extends EventTarget {
  readonly depthUsage: XRDepthUsage;
  readonly depthDataFormat: XRDepthDataFormat;
  readonly depthType: XRDepthType | null;
  readonly depthActive: boolean;

  readonly cameraUsage: XRCameraUsage;
  readonly cameraFormat: XRCameraFormat;
  readonly cameraAccessActive: boolean;

  requestReferenceSpace(type: XRReferenceSpaceType): Promise<XRReferenceSpace>;
  requestAnimationFrame(callback: XRFrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  end(): Promise<void>;

  pauseDepthSensing(): void;
  resumeDepthSensing(): void;
}

type XRFrameRequestCallback = (time: DOMHighResTimeStamp, frame: XRFrame) => void;

interface XRFrame {
  readonly session: XRSession;
  readonly predictedDisplayTime: DOMHighResTimeStamp;
  readonly detectedMeshes: XRMeshSet;

  getViewerPose(referenceSpace: XRReferenceSpace): XRViewerPose | null;
  getDepthInformation(view: XRView): XRCPUDepthInformation | null;
  getPose(space: XRMeshSpace, baseSpace: XRReferenceSpace): XRPose | null;
}

interface XRReferenceSpace extends EventTarget {
  readonly type: XRReferenceSpaceType;
}

interface XRViewerPose {
  readonly transform: XRRigidTransform;
  readonly views: readonly XRView[];
}

interface XRPose {
  readonly transform: XRRigidTransform;
}

interface XRMeshSet {
  readonly size: number;
  entries(): IterableIterator<[XRMesh, XRMesh]>;
  values(): IterableIterator<XRMesh>;
}

interface XRMesh {
  readonly meshSpace: XRMeshSpace;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly normals: Float32Array | null;
  readonly lastChangedTime: DOMHighResTimeStamp;
  readonly semanticLabel: string | null;
}

interface XRMeshSpace extends EventTarget {}

interface XRView {
  readonly eye: "none";
  readonly index: 0;
  readonly transform: XRRigidTransform;
  readonly projectionMatrix: Float32Array; // 16 entries, column-major.
  readonly recommendedViewportScale: null;
  readonly camera: XRCamera | null;
}

interface XRRigidTransform {
  readonly matrix: Float32Array; // 16 entries, column-major.
  readonly inverse: XRRigidTransform;
}

interface XRDepthInformation {
  readonly width: number;
  readonly height: number;
  readonly projectionMatrix: Float32Array; // 16 entries, column-major.
  readonly transform: XRRigidTransform;
  readonly normDepthBufferFromNormView: XRRigidTransform;
  readonly rawValueToMeters: number;
}

interface XRCPUDepthInformation extends XRDepthInformation {
  readonly data: ArrayBuffer;
  getDepthInMeters(x: number, y: number): number;
}

interface XRCamera {
  readonly width: number;
  readonly height: number;
  readonly format: XRCameraFormat;
  readonly normCameraImageFromNormView: XRRigidTransform;
}

interface XRCPUCameraImage {
  readonly camera: XRCamera;
  readonly width: number;
  readonly height: number;
  readonly format: XRCameraFormat;
  readonly data: ArrayBuffer;
  readonly normCameraImageFromNormView: XRRigidTransform;
}

interface XRCPUCameraBinding {
  getCameraImage(camera: XRCamera): XRCPUCameraImage | null;
}
```

## `xr-install`

Installing this profile means setting `globalThis.navigator.xr` to an
`XRSystem` object.

Installation MUST be opt-in for the demo or research build. It MUST NOT happen
as part of the default `standard-camera` install path that polyfills
`navigator.mediaDevices`.

If another library has already installed `navigator.xr`, this repo MUST NOT
replace it silently. The installer MUST either no-op or throw a clear conflict
error in development.

## `xr-is-session-supported`

`navigator.xr.isSessionSupported("immersive-ar")` MUST resolve to:

- `true` on a physical iOS device where ARKit world tracking and at least raw
  scene depth are available.
- `false` on the iOS simulator.
- `false` on a physical iOS device without scene depth support.

No other `XRSessionMode` is accepted by this profile. If JS passes a mode other
than `"immersive-ar"`, the promise MUST resolve to `false`.

This method MUST NOT request camera permission or start ARKit. It is only a
capability check.

## `xr-request-session`

`navigator.xr.requestSession(mode, options)` MUST run these steps:

1. If `mode !== "immersive-ar"`, reject with `NotSupportedError`.
2. If the call is not made during user activation, reject with `SecurityError`.
3. Resolve required and optional features.
4. If none of `"depth-sensing"`, `"camera-access"`, or `"mesh-detection"` is
   requested, reject with `NotSupportedError`. This profile exists only for the
   LiDAR camera/depth/mesh demo.
5. If `"depth-sensing"` is required and `options.depthSensing` is missing,
   reject with `NotSupportedError`.
6. If `"camera-access"` is required and `options.cameraAccess` is missing,
   reject with `NotSupportedError`.
7. Select a depth configuration:
   - `usagePreference` MUST include `"cpu-optimized"`.
   - `dataFormatPreference` MUST include `"float32"`.
   - `depthTypeRequest` order is app-controlled; panorama-style scans SHOULD
     prefer `"raw"` before `"smooth"` when current-frame delivery is more
     important than smoothed distance stability.
   - The selected `depthType` is observable, so the native ARKit session MUST run
     the matching frame semantic. It MUST NOT report `"raw"` while delivering
     `smoothedSceneDepth`, or report `"smooth"` while delivering `sceneDepth`.
   - `matchDepthView` MUST be treated as `true`; `false` is unsupported.
8. Select a camera configuration:
   - `usagePreference` MUST include `"cpu-optimized"`.
   - `formatPreference` MAY include `"rgba8unorm"` or `"bgra8unorm"`.
   - The implementation SHOULD select the first supported format from
     `formatPreference`; this demo requests `"bgra8unorm"` first because ARKit
     preview bytes are already BGRA and WebGPU can sample a `bgra8unorm`
     texture directly.
   - `matchCameraView` MUST be treated as `true`; `false` is unsupported.
   - This profile does not expose a camera resolution constraint. Camera image
     dimensions are implementation-selected and reported on
     `XRCPUCameraImage.width` and `XRCPUCameraImage.height`.
9. If `"mesh-detection"` is requested, enable it only when
   `ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)` is true.
   If it is a required feature and native mesh reconstruction is unavailable,
   reject with `NotSupportedError`; if it is optional, continue without mesh
   detection.
10. Request native camera permission. If permission is denied or restricted,
   reject with `NotAllowedError`.
11. If another `getUserMedia` or LiDAR session is active, stop or suspend it
    through the same external-lock mechanism used by LLP 0012. Cold-start
    autorun MUST NOT start ARKit before the shared camera-lock handler is
    installed; the profile may wait briefly for that handler, but if it cannot
    acquire one it must reject instead of starting an unlocked ARKit session.
12. Start `ARSession` with `ARWorldTrackingConfiguration` and either
    `.smoothedSceneDepth` or `.sceneDepth`.
13. Resolve with a new `XRSession`.

At most one immersive session may be active or starting at a time. If a session
is active, or if a previous `requestSession("immersive-ar")` call is still
waiting for the external camera lock or native ARKit startup, a second
`requestSession("immersive-ar")` call MUST reject with `InvalidStateError`
before acquiring or releasing the external camera lock.

## `xr-camera-resolution`

This section documents a native implementation detail, not a WebXR-facing
configuration surface.

The WebXR research profile uses CPU-visible camera bytes because the current
renderer uploads into WebGPU textures directly. Native WebXR frame delivery uses
a WebXR-specific frame accessor so preview-size tuning remains an implementation
detail of this research profile.

The current native tuning requests 1920x1080 BGRA camera frames for the WebXR
route so LiDAR and surface-reconstruction demos can preserve real camera color
while scanning. That value MUST NOT be exposed as a request-session option or
other caller-selectable camera resolution; callers only observe the actual
returned image dimensions through `XRCPUCameraImage.width` and
`XRCPUCameraImage.height`. Any further increase MUST be validated with
physical-device `WEBGPU_DEMO_PROFILE` logs.

## `xr-session`

An `XRSession` owns the ARKit session until `end()` is called or the native
runtime ends the session due to app backgrounding, interruption, or runtime
error.

`session.depthUsage`, `session.depthDataFormat`, and `session.depthType` MUST
reflect the selected depth configuration. Accessing these attributes on a
session without the `"depth-sensing"` feature MUST throw `InvalidStateError`.

`session.cameraUsage` and `session.cameraFormat` MUST reflect the selected
camera configuration. Accessing these attributes on a session without the
`"camera-access"` feature MUST throw `InvalidStateError`.

`pauseDepthSensing()` MUST set `depthActive` to `false`. After that,
`frame.getDepthInformation(view)` MUST return `null` while camera frames may
continue.

`resumeDepthSensing()` MUST set `depthActive` to `true` if the session has not
ended and the `"depth-sensing"` feature is enabled.

`end()` MUST pause the native `ARSession`, release the same external camera lock
handler acquired during `requestSession()`, fire an `end` event, and resolve
once no new animation frames will be delivered.

## `xr-reference-space`

`session.requestReferenceSpace(type)` MUST support:

- `"viewer"` for screen/view-relative effects where the viewer pose is relative
  to itself.
- `"local"` for world-space LiDAR fusion, backed by ARKit's world-tracking
  origin for the current session.

Requests for `"local-floor"`, `"bounded-floor"`, or `"unbounded"` MUST reject
with `NotSupportedError`.

The LiDAR viewer demo may keep using `"viewer"` because it renders
screen-relative depth. The panoramic scene capture demo MUST use `"local"` so
accepted keyframes are fused in a stable WebXR reference space rather than in
viewer-relative coordinates.

## `xr-frame-loop`

`session.requestAnimationFrame(callback)` MUST schedule callbacks on the native
AR frame cadence when possible.

Each callback receives:

- `time`: a `DOMHighResTimeStamp` derived from the native AR frame timestamp.
- `frame`: a fresh `XRFrame` object whose active flag is true only for the
  duration of the callback.

Native AR frame snapshots MUST remain internal to the WebXR runtime. The app
MUST use WebXR-facing accessors such as `getViewerPose()`,
`getDepthInformation()`, `view.camera`, `XRCPUCameraBinding.getCameraImage()`,
and `detectedMeshes`; it MUST NOT read a native backing frame object from
`XRFrame`.

After the callback returns, attempts to access frame-scoped data such as
`depth.data`, `depth.getDepthInMeters()`, `camera.data`, or `view.camera` MUST
throw `InvalidStateError`.

If no new AR frame is available, the implementation MAY skip a callback rather
than reusing stale depth data. Repeated `requestAnimationFrame()` calls on the
same `XRSession` MUST NOT re-deliver the same native frame snapshot; the
implementation must remember the most recently delivered native frame for the
session, not only for an individual scheduled callback.

`session.cancelAnimationFrame(handle)` MUST prevent the matching callback if it
has not already started.

## `xr-viewer-pose`

`frame.getViewerPose(referenceSpace)` MUST:

1. Throw `InvalidStateError` if `frame` is inactive.
2. Throw `InvalidStateError` if `referenceSpace` does not belong to
   `frame.session`.
3. Return `null` if the native AR frame is unavailable or ARKit camera tracking
   is unavailable/unknown.
4. Return an `XRViewerPose` with exactly one `XRView`.

The returned `XRViewerPose.transform` MUST expose the viewer pose in the
requested reference space. In the monocular phone profile:

- For `"viewer"`, the transform MUST be identity because the viewer is being
  described relative to the viewer reference space.
- For `"local"`, the transform MUST be the ARKit camera-to-world transform for
  the frame. When the projection matrix is derived from the raw
  scene-depth/captured-image plane, this MUST use the orientation-stable
  `ARCamera.transform` rather than a UI-display transform.

The implementation MAY return a viewer pose for ARKit `.limited` tracking and
for any world-mapping bucket when ARKit still provides a camera transform. This
keeps startup scene-depth frames usable on devices that remain in
`worldMappingStatus === "notAvailable"` while scene depth is already flowing.
The WebXR runtime MAY emit throttled internal diagnostic telemetry for both
null-pose and degraded-pose paths, including the native tracking-state bucket,
world-mapping bucket, frame number, and whether a pose was returned, but it
MUST NOT expose tracking or mapping state through `XRFrame`, `XRViewerPose`,
`XRView`, or `XRDepthInformation`.

The single `XRView` MUST have:

- `eye === "none"`
- `index === 0`
- `recommendedViewportScale === null`
- `projectionMatrix` from ARKit camera intrinsics/projection when available,
  otherwise an identity-compatible placeholder for this demo profile. When
  derived from ARKit intrinsics for a scene-depth buffer, the projection MUST
  align WebXR normalized depth texel centers with ARKit's integer depth-pixel
  centers; `(column + 0.5) / width` should unproject through the ray for ARKit
  depth pixel `column`.
- `transform` matching the viewer pose in the requested reference space.

The current LiDAR demo does not consume world poses, but panoramic scene
capture does. Supporting standard `"local"` reference spaces keeps that
world-space reconstruction on WebXR terms and avoids inventing a non-XR frame
object.

## `xr-depth-information`

`frame.getDepthInformation(view)` MUST:

1. Throw `NotSupportedError` if `"depth-sensing"` was not granted.
2. Throw `InvalidStateError` if `frame` is inactive or not an animation frame.
3. Throw `InvalidStateError` if `view` does not belong to `frame`.
4. Return `null` if `session.depthActive === false`.
5. Return `null` if ARKit did not produce a depth map for this frame.
6. Return an `XRCPUDepthInformation` object otherwise.

`XRCPUDepthInformation` fields:

- `width` and `height` MUST match the tight depth buffer dimensions.
- `projectionMatrix` and `transform` MUST expose the `XRViewGeometry` for the
  depth information. With `matchDepthView === true`, they MUST match the
  associated `XRView`, including the requested reference-space transform.
- `data` MUST be a tightly packed `ArrayBuffer` containing
  `width * height` little-endian `Float32` values.
- `rawValueToMeters` MUST be `1` for `float32` ARKit meters.
- Invalid or unavailable depth pixels MUST be encoded as `0`.
- When ARKit supplies a confidence map, the native WebXR implementation MAY
  treat samples below an internal confidence threshold as unavailable and
  encode them as `0` instead of exposing a non-standard confidence map to
  application code. The current ARKit bridge uses a stricter high-confidence
  threshold for raw scene depth and a medium-or-better threshold for smoothed
  scene depth, but MAY fall back to accepting low-confidence depth for a frame
  when the stricter threshold would make the payload empty or too sparse for
  downstream WebXR consumers to form geometry. Payload telemetry SHOULD report
  whether this fallback was used and whether it was caused by an empty or sparse
  high/medium-confidence frame.
- `normDepthBufferFromNormView` MUST map normalized view coordinates into
  normalized depth-buffer coordinates. It MAY be identity only if the native
  implementation has already produced view-aligned depth.

The implementation MAY return frame metadata from the native animation-frame
poll before copying CPU depth bytes, as long as `XRCPUDepthInformation.data`
and `getDepthInMeters()` still expose data for the same active `XRFrame`.
When the native bridge has already produced an exact tight `ArrayBuffer`, the
JS WebXR profile MAY return that buffer directly instead of making another
JavaScript copy.
If the lazy native depth-payload bridge is missing, throws, or reports no
payload for an active `XRFrame`, the WebXR runtime MUST emit internal
diagnostic telemetry with the frame number, request type, fallback reason, and
error detail when available. `XRCPUDepthInformation.data` and
`getDepthInMeters()` MUST continue to report unavailable depth through
`InvalidStateError`; the bridge failure MUST NOT add app-facing native fields to
`XRFrame` or `XRDepthInformation`.

`getDepthInMeters(x, y)` MUST:

1. Throw `InvalidStateError` if the frame is inactive.
2. Throw `RangeError` if either input coordinate is outside `[0, 1]`.
3. Transform `(x, y)` by `normDepthBufferFromNormView`.
4. Scale the transformed normalized depth coordinate by `width` and `height`.
5. Truncate each scaled coordinate to an integer column/row and clamp it to
   `[0, width - 1]` / `[0, height - 1]`.
6. Read the raw `Float32` value.
7. Return `raw * rawValueToMeters`.

The returned depth MUST represent distance from the camera plane to
real-world geometry, matching the WebXR Depth Sensing model. It MUST NOT be
ray length.

## `xr-camera-image`

`view.camera` MUST:

1. Throw `InvalidStateError` if the view's frame is inactive.
2. Return `null` if `"camera-access"` was not granted.
3. Return `null` if ARKit did not produce a camera image for this frame.
4. Return an `XRCamera` object otherwise.

`XRCPUCameraBinding.getCameraImage(camera)` is a repo-local CPU camera extension
that intentionally mirrors the standard binding shape more closely than an
`XRFrame` method. It MUST:

1. Throw `NotSupportedError` if `"camera-access"` was not granted.
2. Throw `InvalidStateError` if `frame` is inactive or not an animation frame.
3. Throw `InvalidStateError` if `camera` belongs to a different session.
4. Return `null` if no aligned camera image is available.
5. Return an `XRCPUCameraImage` object otherwise.

`XRCPUCameraImage` fields:

- `width` and `height` MUST match the image dimensions.
- `format` MUST be either `"rgba8unorm"` or `"bgra8unorm"`.
- `data` MUST be a tightly packed `ArrayBuffer` containing
  `width * height * 4` bytes.
- `normCameraImageFromNormView` MUST map normalized view coordinates into
  normalized camera-image coordinates. It MAY be identity only if the returned
  image is already view-aligned.

The implementation SHOULD return the selected camera format without an extra
copy when feasible. The current WebGPU renderer creates a `bgra8unorm` texture
when the XR camera image format is `"bgra8unorm"`, avoiding the per-frame
BGRA-to-RGBA swizzle that dominated physical-device profiling.
For ARKit's common bi-planar YCbCr camera buffers, the native WebXR runtime MAY
generate the requested low-resolution BGRA CPU image by directly downsampling
and converting YCbCr into the returned tight buffer, falling back to the
platform image renderer for uncommon pixel formats. This keeps the
app-facing WebXR camera-image shape unchanged while avoiding a GPU render/sync
for each colorized surfel keyframe.
When the native bridge has already produced an exact tight `ArrayBuffer`, the
JS WebXR profile MAY return that buffer directly instead of making another
JavaScript copy.
The implementation MAY also defer camera-image rendering/copying until
`XRCPUCameraBinding.getCameraImage(camera)` is called for the active frame.
If the lazy native camera-payload bridge is missing, throws, or reports no
aligned camera bytes, `XRCPUCameraBinding.getCameraImage(camera)` MUST return
`null` for that image and SHOULD emit internal diagnostic telemetry with the
frame number, request type, fallback reason, and error detail when available.
This camera-payload failure MUST NOT abort depth-backed frame delivery; callers
that can use fallback colors should still be able to process the active depth
frame.
Implementations MAY emit internal diagnostic telemetry for native payload
copy/render timing and pose availability, but that telemetry MUST NOT add
app-facing fields to `XRFrame`, `XRDepthInformation`, `XRCamera`, or
`XRCPUCameraImage`.

## `xr-mesh-detection`

This repo-local slice follows the WebXR Real World Meshing draft shape without
claiming browser conformance.

`frame.detectedMeshes` MUST:

1. Throw `InvalidStateError` if the frame is inactive.
2. Return an empty readonly setlike object when `"mesh-detection"` was not
   granted.
3. Return one `XRMesh` per ARKit mesh anchor in the frame snapshot otherwise.

Each `XRMesh` MUST expose anchor-local `Float32Array` `vertices`, optional
anchor-local `Float32Array` `normals`, `Uint32Array` triangle `indices`,
`lastChangedTime`, nullable `semanticLabel`, and a `meshSpace`.

`frame.getPose(mesh.meshSpace, localReferenceSpace)` MUST return the mesh
anchor transform in the WebXR `"local"` reference space. Application code MUST
consume this pose instead of reading ARKit anchor transforms directly.

The native bridge MAY materialize `detectedMeshes` from lightweight per-anchor
summaries first, as long as the setlike object corresponds to the active
`XRFrame` snapshot. In that implementation, reading `XRMesh.meshSpace`,
`XRMesh.lastChangedTime`, or `XRMesh.semanticLabel` MUST NOT require copying
the full vertex/index buffers; reading `XRMesh.vertices`, `XRMesh.normals`, or
`XRMesh.indices` MAY lazily fetch the full geometry for that same frame.
If the optional native mesh-payload bridge is unavailable or throws while
resolving those lazy full-geometry buffers, the runtime SHOULD fail closed to
an empty mesh set for that frame and emit diagnostic telemetry; it MUST NOT let
optional mesh access abort depth/camera frame delivery for the active WebXR
session.
The bridge MAY cache copied native mesh buffers by anchor identity and
`lastChangedTime`; if it does, each returned `XRMesh` MUST still expose the
current frame's `meshSpace` pose and the cached geometry MUST only be reused
while the native geometry-change timestamp is unchanged.
The bridge MAY return lower-detail mesh geometry than ARKit's full
`ARMeshGeometry` buffers for dense anchors, because WebXR exposes
UA-provided mesh geometry rather than an ARKit buffer identity contract. If it
does, the returned `vertices`, `normals`, and `indices` MUST still be
internally consistent typed arrays in anchor-local coordinates, and
`lastChangedTime` MUST continue to track changes in the native source mesh
rather than changes in the chosen level of detail.
Within a session, the WebXR runtime SHOULD reuse the same `XRMesh` object for
the same logical native mesh anchor across frames and keep `mesh.meshSpace` as a
`[SameObject]` space whose pose is refreshed through `frame.getPose()`. This
matches the WebXR Mesh Detection draft's assumption that native mesh objects
maintain identity across frames, without exposing native anchor identifiers to
application code.
For the ARKit-backed implementation, `lastChangedTime` MUST describe mesh
geometry changes rather than pose-only anchor updates. `ARSessionDelegate`
updates can still refresh the current `meshSpace` pose for
`frame.getPose(mesh.meshSpace, ...)` without invalidating cached vertices,
normals, or indices when the anchor-local mesh geometry is unchanged.
Mesh data is sensitive room-scale geometry and MUST remain gated behind an
explicit user-initiated immersive AR session.
For the ARKit-backed implementation, the native WebXR runtime MAY enable
`ARWorldTrackingConfiguration.planeDetection` while mesh detection is active so
ARKit can improve or smooth its scene reconstruction mesh on detected flat
surfaces. Any `ARPlaneAnchor` values produced by that native analysis MUST stay
internal to the runtime and MUST NOT be surfaced as `XRMesh` objects or as
application-visible native anchors.

## WebGPU Upload

This profile intentionally does not define `XRWebGPUBinding` in v1. The demo
uses CPU-visible buffers and ordinary WebGPU queue uploads:

```ts
const depthValues = new Uint8Array(depth.data);
device.queue.writeTexture(
  { texture: depthTexture },
  padRows(depthValues, depth.width * 4),
  { bytesPerRow: alignedDepthBytesPerRow, rowsPerImage: depth.height },
  { width: depth.width, height: depth.height }
);

const cameraBytes = new Uint8Array(camera.data);
device.queue.writeTexture(
  { texture: cameraTexture },
  padRows(cameraBytes, camera.width * 4),
  { bytesPerRow: alignedCameraBytesPerRow, rowsPerImage: camera.height },
  { width: camera.width, height: camera.height }
);
```

A future LLP may define an `XRWebGPUBinding` extension if the app needs
zero-copy camera/depth textures. That should be a separate proposal because the
current WebXR depth and raw camera drafts expose GPU resources through WebGL
bindings.

## ARKit Mapping

Native implementation sketch:

| WebXR-shaped concept | ARKit / iOS source |
|---|---|
| `XRSession` | `ARSession` running `ARWorldTrackingConfiguration` |
| `"depth-sensing"` support | `ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)` or `.smoothedSceneDepth` |
| `"smooth"` depth type | `.smoothedSceneDepth` |
| `"raw"` depth type | `.sceneDepth` |
| `XRCPUDepthInformation.data` | `ARFrame.smoothedSceneDepth?.depthMap` or `ARFrame.sceneDepth.depthMap`, copied as tight `Float32` |
| `XRCPUCameraImage.data` | `ARFrame.capturedImage`, converted/cropped/scaled to the selected RGBA/BGRA format |
| `XRView.projectionMatrix` | A WebXR/OpenGL-style projection matrix derived from `ARCamera.intrinsics`, scaled to the scene-depth buffer and adjusted for WebXR normalized texel centers |
| `XRView.transform` | `ARCamera.transform` |
| `"mesh-detection"` support | `ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)` |
| `XRFrame.detectedMeshes` | `ARMeshAnchor` snapshots from `ARSessionDelegate` |
| `XRMesh.vertices` / `normals` / `indices` | `ARMeshGeometry.vertices`, `normals`, and triangle faces copied or sampled into tight, internally consistent typed arrays |
| `XRMesh.meshSpace` pose | `ARMeshAnchor.transform` in `"local"` reference space |
| `predictedDisplayTime` | `ARFrame.timestamp` converted to `DOMHighResTimeStamp` |

The native implementation may use ARKit intrinsics to construct standard
`XRViewGeometry`, but it MUST NOT expose those intrinsics as an app-facing
extension. The depth view is aligned with the scene-depth/captured-image plane;
`normDepthBufferFromNormView` may therefore be identity when the returned depth
buffer already uses that coordinate system.
Internal telemetry MAY report the `ARCamera.imageResolution` basis used to scale
intrinsics into the projection matrix and the resulting depth-to-projection
scale, but those diagnostics MUST remain outside the WebXR object model.

`ARFrame.displayTransform(for:viewportSize:)` is a display helper for rotating
and cropping the raw captured image into a UIKit viewport. It MUST NOT be baked
into `XRView.transform` or the scene-depth projection for this profile unless a
future version explicitly defines the XR view as that display-oriented
viewport. Camera preview crop/scale belongs in `normCameraImageFromNormView`.

The implementation MUST copy frame buffers before returning them to JS, or
otherwise guarantee their lifetime until the animation-frame callback returns.
If it retains native ARKit frame snapshots to satisfy lazy payload access, that
retention MUST be bounded tightly enough that held camera/depth buffers do not
starve the native frame producer.

Current implementation limit: the native transform/projection metadata is
computed for the scene-depth/captured-image plane, not for a full compositor
viewport model. The CPU camera image may remain a landscape-aspect cropped copy
of `ARFrame.capturedImage` (`1920 x 1080` in the current implementation,
intentionally larger than common scene-depth buffer dimensions); callers must
use `normCameraImageFromNormView` to sample it from normalized view
coordinates.
This is enough to make timing and view/camera/depth coordinate objects
data-backed instead of placeholders, but it is not a general orientation-aware
WebXR compositor model.

## Permissions and Privacy

`requestSession("immersive-ar", ...)` MUST require user activation.

The implementation MUST request native camera permission before starting ARKit.
Denied or restricted permission MUST reject with `NotAllowedError`.

Raw camera bytes and depth geometry MUST be available only when the caller has
explicitly requested `"camera-access"` and `"depth-sensing"` respectively.

The implementation SHOULD show the native camera indicator whenever the session
is active.

The implementation MUST end the session or return no new frames when the app is
backgrounded, camera permission changes, or iOS reports an AR session
interruption.

The implementation MUST NOT persist camera or depth frames to disk.

The implementation SHOULD avoid exposing more world geometry than the demo
needs. This v1 surface exposes only the current RGB frame and current aligned
depth buffer.

## Error Mapping

| Condition | Error |
|---|---|
| Unsupported session mode | `NotSupportedError` |
| Unsupported required feature | `NotSupportedError` |
| Missing `depthSensing` for required `"depth-sensing"` | `NotSupportedError` |
| Missing `cameraAccess` for required `"camera-access"` | `NotSupportedError` |
| Unsupported depth usage/format or camera usage/format | `NotSupportedError` |
| No user activation for `requestSession()` | `SecurityError` |
| Camera permission denied or restricted | `NotAllowedError` |
| Session already active | `InvalidStateError` |
| Accessing frame-scoped data after callback returns | `InvalidStateError` |
| Calling depth/camera APIs with a view from another frame/session | `InvalidStateError` |
| Native ARKit runtime failure after session start | Fire `end`; subsequent frame APIs throw `InvalidStateError` |

## Validation Plan

Minimum tests for an implementation:

1. `navigator.xr` is absent unless the WebXR research profile is explicitly
   installed.
2. `isSessionSupported("immersive-ar")` resolves `false` on simulator.
3. `requestSession("inline")` rejects with `NotSupportedError`.
4. `requestSession("immersive-ar")` without user activation rejects with
   `SecurityError`.
5. Required `"depth-sensing"` without `depthSensing` rejects with
   `NotSupportedError`.
6. Required `"camera-access"` without `cameraAccess` rejects with
   `NotSupportedError`.
7. On a LiDAR-capable iPhone with permission granted, `requestSession()` starts
   ARKit and resolves an `XRSession`.
8. `requestReferenceSpace("viewer")` and `requestReferenceSpace("local")`
   resolve; `"local-floor"`, `"bounded-floor"`, and `"unbounded"` reject.
9. The first frame has exactly one view with `eye === "none"` and `index === 0`.
10. `frame.getDepthInformation(view)` returns non-null on live LiDAR frames and
    reports `data.byteLength === width * height * 4`.
11. `depth.getDepthInMeters(0.5, 0.5)` matches the `Float32` sample at
    `trunc(0.5 * width), trunc(0.5 * height)` multiplied by
    `rawValueToMeters`.
12. Invalid depth samples return `0`.
13. `view.camera` plus `XRCPUCameraBinding.getCameraImage(camera)` returns non-null and reports
    `data.byteLength === width * height * 4`.
14. Depth and camera access after the animation-frame callback throws
    `InvalidStateError`.
15. `pauseDepthSensing()` makes `getDepthInformation(view)` return `null`.
16. `resumeDepthSensing()` allows later frames to return depth again.
17. `end()` stops ARKit, fires `end`, and releases the camera for
    `getUserMedia`.

## Implementation Status

The first research implementation is present as:

- `modules/standard-camera/src/WebXRDepthProfile.ts`
- `src/app/(tabs)/(demo)/lidar-depth-webxr.tsx`

The implementation is a JavaScript WebXR-shaped profile over the existing
native LiDAR sidecar from LLP 0012. It installs `navigator.xr` only when the
WebXR profile installer is called, then implements the supported profile from
this LLP: `"immersive-ar"`, `"viewer"`/`"local"` reference spaces,
`"depth-sensing"`, `"camera-access"`, CPU `float32` depth, CPU camera bytes,
one `XRView` with `eye === "none"`, and an XR animation-frame loop.

React Native has no browser `navigator.userActivation`. The route bridges this
with a repo-local `runWithWebXRUserActivation()` helper that must wrap the
`requestSession()` call from a button press. This is not a WebXR API surface; it
is the native-app equivalent of the transient activation gate required by
`requestSession()`.

The research route intentionally still uploads CPU-visible `ArrayBuffer` data
through ordinary WebGPU queue writes. It does not implement `XRWebGLBinding`,
`XRWebGLDepthInformation`, `XRWebGPUBinding`, or zero-copy XR textures.

The route uses `view.camera` plus the repo-local `XRCPUCameraBinding` analog for
camera bytes. The first prototype's `frame.getCameraImage(view)` helper was
removed because it hid the standard Raw Camera Access ownership model. This
repo-local CPU binding remains non-standard because the standard binding returns
a `WebGLTexture`.

## Implementation Recommendation

Keep this as the only user-facing LiDAR demo route, while continuing to label
the `navigator.xr` surface as a research profile rather than a general WebXR
runtime. The removed direct-native route should not be restored unless there is
a specific native-side validation need that cannot be covered by the WebXR
route. The next useful increment would be to add more WebXR-compatible metadata
to the native sidecar payload:

- `depthType`
- `depthUsage`
- `depthDataFormat`
- `rawValueToMeters`
- `normDepthBufferFromNormView`
- `cameraFormat`
- `normCameraImageFromNormView`

That gives the current WebGPU demo the most valuable WebXR semantics without
claiming that this app implements `navigator.xr`.
