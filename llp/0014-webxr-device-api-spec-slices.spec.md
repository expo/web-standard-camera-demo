# LLP 0014: WebXR Device API - spec slices

**Type:** Spec
**Status:** Active
**Systems:** webxr-lidar-api
**Author:** James Ide
**Date:** 2026-05-25
**Related:** 0013, 0015, 0016, 0017

## Purpose

This LLP is a trimmed, repo-local copy of the WebXR Device API sections that
matter to the proposed WebXR-shaped LiDAR API in [LLP 0013](./0013-webxr-lidar-depth-api.spec.md).

Authoritative source: https://www.w3.org/TR/webxr/

The source document is large. This LLP intentionally deletes parts that are
unequivocally unrelated to the LiDAR Depth Studio profile: input sources,
controllers, gamepads, hand tracking, hit testing, anchors, planes, layers,
bounded spaces, DOM overlays, WebGL compositor setup, and general stereo
rendering. The kept slices are the entry point, session creation, session frame
loop, viewer pose, reference spaces, views, and transforms.

Section headings carry stable local anchors. Code may cite these with
`@ref LLP 0014#<anchor>`.

## `xr-system`

Relevant upstream surface:

```webidl
[SecureContext, Exposed=Window]
interface XRSystem : EventTarget {
  Promise<boolean> isSessionSupported(XRSessionMode mode);
  [NewObject] Promise<XRSession> requestSession(
    XRSessionMode mode,
    optional XRSessionInit options = {}
  );
  attribute EventHandler ondevicechange;
};
```

The `XRSystem` object is exposed from `navigator.xr`. It is the entry point for
checking XR support and creating sessions.

LLP 0013 keeps only `isSessionSupported()` and `requestSession()`. It omits
`ondevicechange` because the LiDAR demo does not react to XR device hotplug.

## `xr-session-mode`

Relevant upstream enum:

```webidl
enum XRSessionMode {
  "inline",
  "immersive-vr",
  "immersive-ar"
};
```

`"immersive-ar"` is defined by the AR module, not only by the core Device API.
Immersive sessions are exclusive: the document no longer presents normal HTML
content on the immersive device display while the session is visible.

LLP 0013 supports only `"immersive-ar"`. `"inline"` and `"immersive-vr"` are
deleted from the proposed implementation profile.

## `xr-session-init-features`

Relevant upstream shape:

```webidl
dictionary XRSessionInit {
  sequence<DOMString> requiredFeatures;
  sequence<DOMString> optionalFeatures;
};
```

Required features block session creation if unrecognized, unsupported, or not
granted. Optional features may be enabled when supported and granted, but their
absence does not reject the session.

LLP 0013 uses this feature-gating model for `"depth-sensing"` and
`"camera-access"`. It does not support any other feature descriptors.

## `xr-session`

Relevant upstream methods:

```webidl
[SecureContext, Exposed=Window]
interface XRSession : EventTarget {
  [NewObject] Promise<XRReferenceSpace> requestReferenceSpace(XRReferenceSpaceType type);
  unsigned long requestAnimationFrame(XRFrameRequestCallback callback);
  undefined cancelAnimationFrame(unsigned long handle);
  Promise<undefined> end();

  attribute EventHandler onend;
};

callback XRFrameRequestCallback = undefined (DOMHighResTimeStamp time, XRFrame frame);
```

LLP 0013 keeps the session as the lifetime owner of the native ARKit session. It
keeps `requestReferenceSpace()`, `requestAnimationFrame()`,
`cancelAnimationFrame()`, `end()`, and `onend`.

Deleted as unrelated: render state, target frame rate, input sources, tracked
sources, selection events, visibility state, base layers, framebuffer scale, and
system keyboard support.

## `xr-reference-space`

Relevant upstream enum:

```webidl
enum XRReferenceSpaceType {
  "viewer",
  "local",
  "local-floor",
  "bounded-floor",
  "unbounded"
};
```

The upstream spec requires every `XRSession` to support `"viewer"` reference
spaces. A viewer reference space tracks the viewer's position and orientation.

LLP 0013 supports only `"viewer"`. The current LiDAR demo's effects are
screen/view-relative and do not need local, floor, bounded, or unbounded world
spaces.

## `xr-frame-loop`

Relevant upstream behavior:

- `XRSession.requestAnimationFrame()` registers callbacks that receive an
  `XRFrame`.
- During callback delivery, the frame's active flag is true.
- After callback delivery, frame-scoped operations become invalid.
- `predictedDisplayTime` identifies the time the frame is expected to be shown.

LLP 0013 maps this to ARKit frame cadence. It preserves the important invariant:
camera and depth data are frame-scoped and cannot be read after the callback
returns.

## `xr-frame`

Relevant upstream surface:

```webidl
[SecureContext, Exposed=Window]
interface XRFrame {
  [SameObject] readonly attribute XRSession session;
  readonly attribute DOMHighResTimeStamp predictedDisplayTime;

  XRViewerPose? getViewerPose(XRReferenceSpace referenceSpace);
  XRPose? getPose(XRSpace space, XRSpace baseSpace);
};
```

LLP 0013 keeps `session`, `predictedDisplayTime`, and `getViewerPose()`.

Deleted as unrelated: general `getPose()` over arbitrary `XRSpace` objects. The
LiDAR demo has no anchors, controllers, hit-test spaces, or world-space UI.

## `xr-viewer-pose`

Relevant upstream behavior:

- `getViewerPose(referenceSpace)` is only valid for animation-frame
  `XRFrame`s.
- It can return `null` while tracking is unavailable.
- When non-null, it returns an `XRViewerPose` with a `views` array.

LLP 0013 keeps this shape but restricts the view array to one view because the
demo is phone-based, monocular, and WebGPU-rendered into one on-screen canvas.

## `xr-view`

Relevant upstream surface:

```webidl
enum XREye {
  "none",
  "left",
  "right"
};

[SecureContext, Exposed=Window]
interface XRView {
  readonly attribute XREye eye;
  readonly attribute unsigned long index;
  readonly attribute double? recommendedViewportScale;
  undefined requestViewportScale(double? scale);
};

XRView includes XRViewGeometry;
```

The upstream `XRViewGeometry` mixin provides view geometry such as transform and
projection matrix. `eye` distinguishes mono/non-eye views from left/right stereo
views.

LLP 0013 keeps `eye`, `index`, `transform`, and `projectionMatrix`, with exactly
one `XRView` whose `eye` is `"none"` and `index` is `0`.

Deleted as unrelated: viewport scaling and stereo left/right rendering.

## `xr-rigid-transform`

Relevant upstream role:

`XRRigidTransform` represents a transform matrix and its inverse. The WebXR
Depth Sensing spec uses it for `normDepthBufferFromNormView`, and the core
WebXR view geometry uses it for view transforms.

LLP 0013 keeps only:

```ts
interface XRRigidTransform {
  readonly matrix: Float32Array; // 16 entries, column-major.
  readonly inverse: XRRigidTransform;
}
```

Constructors, position/orientation accessors, ray helpers, and arbitrary
transform composition are deleted as unrelated to the demo.
