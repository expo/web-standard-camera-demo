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
  planes, meshes, bounded-floor spaces, DOM overlays, layers, stereo rendering,
  or world-space UI.
- No WebGL rendering path for this demo.
- No attempt to claim compatibility with browsers that implement WebXR.
- No Media Capture depth track or `videoKind: "depth"` implementation.

## Supported Profile

This repo-local profile supports exactly:

- `XRSessionMode`: `"immersive-ar"`
- `XRReferenceSpaceType`: `"viewer"`
- Feature descriptors:
  - `"depth-sensing"`
  - `"camera-access"`
- Depth usage:
  - `"cpu-optimized"`
- Depth data format:
  - `"float32"`
- Depth type:
  - `"smooth"` when ARKit smoothed scene depth is available
  - `"raw"` otherwise
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
type XRReferenceSpaceType = "viewer";
type XRFeatureDescriptor = "depth-sensing" | "camera-access";

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

  getViewerPose(referenceSpace: XRReferenceSpace): XRViewerPose | null;
  getDepthInformation(view: XRView): XRCPUDepthInformation | null;
}

interface XRReferenceSpace extends EventTarget {
  readonly type: XRReferenceSpaceType;
}

interface XRViewerPose {
  readonly transform: XRRigidTransform;
  readonly views: readonly XRView[];
}

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
4. If neither `"depth-sensing"` nor `"camera-access"` is requested, reject with
   `NotSupportedError`. This profile exists only for the LiDAR camera/depth
   demo.
5. If `"depth-sensing"` is required and `options.depthSensing` is missing,
   reject with `NotSupportedError`.
6. If `"camera-access"` is required and `options.cameraAccess` is missing,
   reject with `NotSupportedError`.
7. Select a depth configuration:
   - `usagePreference` MUST include `"cpu-optimized"`.
   - `dataFormatPreference` MUST include `"float32"`.
   - `depthTypeRequest` SHOULD prefer `"smooth"` before `"raw"`.
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
9. Request native camera permission. If permission is denied or restricted,
   reject with `NotAllowedError`.
10. If another `getUserMedia` or LiDAR session is active, stop or suspend it
    through the same external-lock mechanism used by LLP 0012.
11. Start `ARSession` with `ARWorldTrackingConfiguration` and either
    `.smoothedSceneDepth` or `.sceneDepth`.
12. Resolve with a new `XRSession`.

At most one immersive session may be active at a time. If a session is active,
a second `requestSession("immersive-ar")` call MUST reject with
`InvalidStateError`.

## `xr-camera-resolution`

This section documents a native implementation detail, not a WebXR-facing
configuration surface.

The WebXR research profile uses CPU-visible camera bytes because the current
renderer uploads into WebGPU textures directly. Native WebXR frame delivery uses
a WebXR-specific frame accessor so preview-size tuning remains an implementation
detail of this research profile.

The current native tuning requests 1280x960 BGRA camera frames for the WebXR
route. That value MUST NOT be exposed as a request-session option or other
caller-selectable camera resolution; callers only observe the actual returned
image dimensions through `XRCPUCameraImage.width` and
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

`end()` MUST pause the native `ARSession`, release the external camera lock, fire
an `end` event, and resolve once no new animation frames will be delivered.

## `xr-reference-space`

Only `session.requestReferenceSpace("viewer")` is supported.

Requests for `"local"`, `"local-floor"`, `"bounded-floor"`, or `"unbounded"`
MUST reject with `NotSupportedError`.

The `"viewer"` reference space is sufficient for the demo because every effect
is screen/view relative. The API still exposes transforms so this profile can
grow into an honest XR mapping later.

## `xr-frame-loop`

`session.requestAnimationFrame(callback)` MUST schedule callbacks on the native
AR frame cadence when possible.

Each callback receives:

- `time`: a `DOMHighResTimeStamp` derived from the native AR frame timestamp.
- `frame`: a fresh `XRFrame` object whose active flag is true only for the
  duration of the callback.

After the callback returns, attempts to access frame-scoped data such as
`depth.data`, `depth.getDepthInMeters()`, `camera.data`, or `view.camera` MUST
throw `InvalidStateError`.

If no new AR frame is available, the implementation MAY skip a callback rather
than reusing stale depth data.

`session.cancelAnimationFrame(handle)` MUST prevent the matching callback if it
has not already started.

## `xr-viewer-pose`

`frame.getViewerPose(referenceSpace)` MUST:

1. Throw `InvalidStateError` if `frame` is inactive.
2. Throw `InvalidStateError` if `referenceSpace` does not belong to
   `frame.session`.
3. Return `null` if the native AR frame is unavailable.
4. Return an `XRViewerPose` with exactly one `XRView`.

The single `XRView` MUST have:

- `eye === "none"`
- `index === 0`
- `recommendedViewportScale === null`
- `projectionMatrix` from ARKit camera intrinsics/projection when available,
  otherwise an identity-compatible placeholder for this demo profile.
- `transform` from ARKit camera transform when available, otherwise identity.

The current LiDAR demo does not consume world poses, but exposing them here
keeps the API shape close to WebXR and avoids inventing a non-XR frame object.

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
- `data` MUST be a tightly packed `ArrayBuffer` containing
  `width * height` little-endian `Float32` values.
- `rawValueToMeters` MUST be `1` for `float32` ARKit meters.
- Invalid or unavailable depth pixels MUST be encoded as `0`.
- `normDepthBufferFromNormView` MUST map normalized view coordinates into
  normalized depth-buffer coordinates. It MAY be identity only if the native
  implementation has already produced view-aligned depth.

`getDepthInMeters(x, y)` MUST:

1. Throw `InvalidStateError` if the frame is inactive.
2. Transform `(x, y)` by `normDepthBufferFromNormView`.
3. Clamp to the depth buffer.
4. Read the raw `Float32` value.
5. Return `raw * rawValueToMeters`.

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
| `XRView.projectionMatrix` | `ARCamera.projectionMatrix` for the active viewport/orientation |
| `XRView.transform` | `ARCamera.transform` |
| `predictedDisplayTime` | `ARFrame.timestamp` converted to `DOMHighResTimeStamp` |

The implementation MUST copy frame buffers before returning them to JS, or
otherwise guarantee their lifetime until the animation-frame callback returns.

Current implementation limit: the native transform/projection metadata is
computed for the portrait WebXR demo viewport. That is enough to make timing and
view/camera/depth coordinate objects data-backed instead of placeholders, but it
is not a general orientation-aware WebXR compositor model.

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
8. `requestReferenceSpace("viewer")` resolves; every other reference space type
   rejects.
9. The first frame has exactly one view with `eye === "none"` and `index === 0`.
10. `frame.getDepthInformation(view)` returns non-null on live LiDAR frames and
    reports `data.byteLength === width * height * 4`.
11. `depth.getDepthInMeters(0.5, 0.5)` matches the corresponding center
    `Float32` sample multiplied by `rawValueToMeters`.
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
this LLP: `"immersive-ar"`, `"viewer"`, `"depth-sensing"`, `"camera-access"`,
CPU `float32` depth, CPU camera bytes, one `XRView` with `eye === "none"`, and
an XR animation-frame loop.

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
