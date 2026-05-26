# LLP 0017: WebXR Raw Camera Access - spec slices

**Type:** Spec
**Status:** Active
**Systems:** webxr-lidar-api
**Author:** James Ide
**Date:** 2026-05-25
**Related:** 0013, 0014, 0015, 0016

## Purpose

This LLP is a trimmed, repo-local copy of the WebXR Raw Camera Access sections
that matter to the proposed WebXR-shaped LiDAR API in
[LLP 0013](./0013-webxr-lidar-depth-api.spec.md).

Authoritative source: https://immersive-web.github.io/raw-camera-access/

This source is an Immersive Web draft, not a W3C Recommendation-track TR page.
It is still the relevant WebXR camera-pixel API shape.

Deleted as unrelated: acknowledgements, indexes, broad references, examples of
general user prompts, and WebGL texture caching details except where they affect
the WebGPU design decision.

## `raw-camera-feature-descriptor`

The draft adds the `"camera-access"` feature descriptor. Applications request it
through `navigator.xr.requestSession("immersive-ar", { requiredFeatures:
["camera-access"] })`.

A device supports the feature only when it has native camera capability. Inline
XR devices are not considered capable.

The feature requires XR spatial tracking policy and camera policy to be allowed.

LLP 0013 keeps the feature name but does not claim compatibility with the draft
because it returns CPU-visible bytes instead of WebGL textures.

## `xr-view-camera`

Relevant upstream surface:

```webidl
partial interface XRView {
  [SameObject] readonly attribute XRCamera? camera;
};
```

Relevant upstream behavior:

- `view.camera` returns `null` unless `"camera-access"` was granted.
- Access is only valid during an active animation frame.
- The returned camera image must be aligned with the `XRView`.
- Repeated access for the same `XRView` returns the same `XRCamera` object, or
  `null` if no camera is available.

LLP 0013 keeps `view.camera` as metadata and adds a repo-local
`frame.getCameraImage(view)` CPU path.

## `xr-camera`

Relevant upstream surface:

```webidl
[SecureContext, Exposed=Window]
interface XRCamera {
  readonly attribute unsigned long width;
  readonly attribute unsigned long height;
};
```

`XRCamera` describes the camera texture obtainable through `XRWebGLBinding`.

LLP 0013 extends the local shape with `format` and
`normCameraImageFromNormView` because the WebGPU demo needs to know how to
interpret and map CPU-visible bytes.

## `xr-webgl-get-camera-image`

Relevant upstream surface:

```webidl
partial interface XRWebGLBinding {
  WebGLTexture? getCameraImage(XRCamera camera);
};
```

The upstream return value is an opaque `WebGLTexture`. The draft allows user
agents to cache returned textures within the frame and tells applications to
treat them as read-only.

LLP 0013 does not implement this method because the current demo has no WebGL
binding. Instead, it defines:

```ts
interface XRFrame {
  getCameraImage(view: XRView): XRCPUCameraImage | null;
}
```

That is intentionally a repo-local CPU extension for WebGPU upload, not a
standard Raw Camera Access method.

## `native-camera-alignment`

Relevant upstream semantics:

- Native camera data must be available at the animation-frame time.
- The camera image must be aligned with the requested `XRView`.
- If native camera data cannot be aligned to the view, camera access returns
  `null`.
- A crop is acceptable when it makes the camera frustum match the view frustum.

LLP 0013 keeps this alignment requirement. If ARKit returns a wider camera
buffer, native code should crop/scale or expose a
`normCameraImageFromNormView` transform that JS/WGSL can apply.

## `raw-camera-privacy-security`

The draft treats raw camera access as a high-privacy-risk capability because it
allows direct observation of the user's environment.

Important upstream requirements and guidance:

- user consent should be obtained before enabling `"camera-access"`
- authors should not request camera access if another path can solve the use
  case
- user agents must show a camera privacy indicator while a session with
  `"camera-access"` is active
- indicators should make clear that the camera is in use and the site can access
  what the camera sees

LLP 0013 keeps this posture and maps it to native iOS camera permission plus the
system camera indicator.
