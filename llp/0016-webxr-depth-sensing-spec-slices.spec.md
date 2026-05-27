# LLP 0016: WebXR Depth Sensing Module - spec slices

**Type:** Spec
**Status:** Active
**Systems:** webxr-lidar-api
**Author:** James Ide
**Date:** 2026-05-25
**Related:** 0013, 0014, 0015, 0017

## Purpose

This LLP is a trimmed, repo-local copy of the WebXR Depth Sensing Module
sections that matter to the proposed WebXR-shaped LiDAR API in
[LLP 0013](./0013-webxr-lidar-depth-api.spec.md).

Authoritative source: https://www.w3.org/TR/webxr-depth-sensing-1/

Deleted as unrelated: the `"luminance-alpha"` and `"unsigned-short"` formats for
the proposed implementation path, WebGL shader examples, texture-array handling,
MDN support tables, acknowledgements, change logs, and broad index/reference
boilerplate. Kept as context but not implemented: the upstream WebGL GPU depth
path, because it explains why LLP 0013 defines CPU buffers for WebGPU upload.

## `depth-feature-descriptor`

The Depth Sensing Module adds the `"depth-sensing"` feature descriptor to
`XRSessionInit.requiredFeatures` / `optionalFeatures`.

A device supports the feature only when it has native depth sensing capability.
Inline XR devices are not considered depth-capable.

LLP 0013 maps this to ARKit scene depth support:

- `.smoothedSceneDepth` or `.sceneDepth` means the feature can be supported.
- iOS Simulator and non-LiDAR devices return unsupported.

## `depth-type-usage-format`

Relevant upstream enums:

```webidl
enum XRDepthType {
  "raw",
  "smooth"
};

enum XRDepthUsage {
  "cpu-optimized",
  "gpu-optimized"
};

enum XRDepthDataFormat {
  "luminance-alpha",
  "float32",
  "unsigned-short"
};
```

Upstream meanings:

- `"raw"` means minimal post-processing.
- `"smooth"` means the runtime may denoise or smooth the depth texture.
- `"cpu-optimized"` means authors consume `XRCPUDepthInformation`.
- `"gpu-optimized"` means authors consume `XRWebGLDepthInformation`.
- `"float32"` means each depth-buffer item is a 32-bit float.

LLP 0013 keeps only `"cpu-optimized"` and `"float32"` because the current demo
uploads CPU-visible `Float32` depth data into WebGPU.

## `depth-session-init`

Relevant upstream shape:

```webidl
dictionary XRDepthStateInit {
  required sequence<XRDepthUsage> usagePreference;
  required sequence<XRDepthDataFormat> dataFormatPreference;
  sequence<XRDepthType> depthTypeRequest;
  boolean matchDepthView = true;
};

partial dictionary XRSessionInit {
  XRDepthStateInit depthSensing;
};
```

The upstream spec requires `depthSensing` when `"depth-sensing"` is requested.
If required depth sensing cannot be configured, session creation rejects with
`NotSupportedError`.

LLP 0013 requires:

- `usagePreference` includes `"cpu-optimized"`
- `dataFormatPreference` includes `"float32"`
- `depthTypeRequest` prefers `"smooth"` then `"raw"`
- `matchDepthView` is treated as `true`

## `depth-session-attributes`

Relevant upstream surface:

```webidl
partial interface XRSession {
  readonly attribute XRDepthUsage depthUsage;
  readonly attribute XRDepthDataFormat depthDataFormat;
  readonly attribute XRDepthType? depthType;
  readonly attribute boolean? depthActive;

  undefined pauseDepthSensing();
  undefined resumeDepthSensing();
};
```

The upstream spec sets these attributes from the chosen depth configuration.
Access on a session without depth sensing throws `InvalidStateError`.

`depthActive` starts true. When false, depth APIs return no depth data.

LLP 0013 keeps this behavior.

## `depth-information`

Relevant upstream surface:

```webidl
[SecureContext, Exposed=Window]
interface XRDepthInformation {
  readonly attribute unsigned long width;
  readonly attribute unsigned long height;
  [SameObject] readonly attribute XRRigidTransform normDepthBufferFromNormView;
  readonly attribute float rawValueToMeters;
};

XRDepthInformation includes XRViewGeometry;
```

Relevant upstream semantics:

- `width` and `height` are the depth-buffer dimensions.
- `normDepthBufferFromNormView` maps normalized view coordinates into normalized
  depth-buffer coordinates.
- `rawValueToMeters` scales raw depth-buffer values into meters.

LLP 0013 uses the same fields. For ARKit `Float32` meters,
`rawValueToMeters === 1`.

## `cpu-depth-information`

Relevant upstream surface:

```webidl
[Exposed=Window]
interface XRCPUDepthInformation : XRDepthInformation {
  [SameObject] readonly attribute ArrayBuffer data;
  float getDepthInMeters(float x, float y);
};

partial interface XRFrame {
  XRCPUDepthInformation? getDepthInformation(XRView view);
};
```

Relevant upstream semantics:

- `data` is a tight row-major depth buffer with no padding.
- Members are frame-scoped; access after the frame becomes inactive throws
  `InvalidStateError`.
- `getDepthInMeters(x, y)` samples at normalized view coordinates, rejecting
  inputs outside `[0, 1]`.
- Sampling applies `normDepthBufferFromNormView`, scales the normalized depth
  coordinate by `width` and `height`, truncates to an integer column/row, clamps
  to the buffer edge, reads the raw value, and multiplies by `rawValueToMeters`.

LLP 0013 keeps this CPU shape and maps `data` to a tight little-endian
`Float32Array`-compatible `ArrayBuffer`.

## `webgl-depth-information`

Relevant upstream surface:

```webidl
[Exposed=Window]
interface XRWebGLDepthInformation : XRDepthInformation {
  [SameObject] readonly attribute WebGLTexture texture;
  readonly attribute XRTextureType textureType;
  readonly attribute unsigned long? imageIndex;
};

partial interface XRWebGLBinding {
  XRWebGLDepthInformation? getDepthInformation(XRView view);
};
```

This is the standardized GPU path. It is explicitly WebGL-oriented.

LLP 0013 does not implement this path because the LiDAR demo uses
`react-native-wgpu` and WGSL. The proposed WebXR-shaped API instead exposes CPU
buffers and lets JS upload them through ordinary WebGPU queue writes.

## `depth-interpretation`

Relevant upstream semantics:

- Invalid or unavailable depth pixels return `0`.
- Depth values represent distance from the camera plane to real-world geometry.
- Depth values are not ray lengths.

LLP 0013 keeps this interpretation. This is important for LiDAR center-depth
readouts and for WebGPU effects that compare depth against a target distance.

## `native-depth-sensing`

Relevant upstream requirements for native depth data:

- buffer dimensions
- units / scale to meters
- normalized-view to normalized-depth-buffer transform
- sensor projection matrix
- sensor transform
- raw vs smooth depth capability

LLP 0013 maps these to ARKit:

- `ARFrame.sceneDepth.depthMap` or `smoothedSceneDepth.depthMap`
- `Float32` meters
- an identity transform only when the returned depth is already view-aligned
- ARKit camera projection and transform when wired through

## `depth-privacy-security`

The upstream module treats depth as real-world environmental information. User
agents should seek user consent and may reduce resolution, quantize values, or
block depth entirely. If depth becomes as revealing as camera access, consent
should be equivalent to camera consent.

LLP 0013 keeps the same posture:

- depth requires explicit `"depth-sensing"`
- native camera permission is still requested before ARKit starts
- the implementation may return `null` or reduce precision if privacy policy
  requires it
