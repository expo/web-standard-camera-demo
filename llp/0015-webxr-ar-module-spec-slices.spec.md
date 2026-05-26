# LLP 0015: WebXR Augmented Reality Module - spec slices

**Type:** Spec
**Status:** Active
**Systems:** webxr-lidar-api
**Author:** James Ide
**Date:** 2026-05-25
**Related:** 0013, 0014, 0016, 0017

## Purpose

This LLP is a trimmed, repo-local copy of the WebXR Augmented Reality Module
sections that matter to the proposed WebXR-shaped LiDAR API in
[LLP 0013](./0013-webxr-lidar-depth-api.spec.md).

Authoritative source: https://www.w3.org/TR/webxr-ar-module-1/

Deleted as unrelated: general XR UI guidance, world-space interaction details,
DOM overlays, secondary views as a capture feature, and broad compositor
implementation guidance beyond the privacy and `"immersive-ar"` constraints
listed below.

## `ar-session-mode`

The AR module enables the `"immersive-ar"` session mode from the WebXR Device
API. An `"immersive-ar"` session is intended to blend rendered content with the
real-world environment and uses exclusive access to the immersive device display.

LLP 0013 uses `"immersive-ar"` as the only supported session mode because ARKit
scene depth is an AR session capability, not an inline or VR capability.

## `ar-display-technology`

The AR module distinguishes display technologies:

- additive / see-through displays
- pass-through displays
- opaque displays attempting AR compatibility

For this repo, iPhone ARKit is modeled as pass-through handheld AR: native
cameras collect real-world imagery and the runtime composites or exposes that
imagery in an AR session.

LLP 0013 keeps only this pass-through interpretation. Head-worn additive
displays and opaque VR compatibility paths are unrelated to the LiDAR demo.

## `ar-environment-blend-mode`

Relevant upstream surface:

```webidl
enum XREnvironmentBlendMode {
  "opaque",
  "alpha-blend",
  "additive"
};

partial interface XRSession {
  readonly attribute XREnvironmentBlendMode environmentBlendMode;
};
```

`environmentBlendMode` reports how rendered pixels are blended with the real
world.

LLP 0013 does not need this attribute for the current WebGPU demo. If it is
implemented, an iPhone pass-through AR session SHOULD report `"alpha-blend"`.

## `ar-interaction-mode`

Relevant upstream surface:

```webidl
enum XRInteractionMode {
  "screen-space",
  "world-space"
};

partial interface XRSession {
  readonly attribute XRInteractionMode interactionMode;
};
```

For phone AR, screen-space UI is the natural shape. LLP 0013 does not need this
attribute because the LiDAR demo already uses ordinary React Native controls
outside the proposed WebXR frame objects.

## `ar-compositor-privacy`

The AR module is explicit that an AR session alone must not give content raw
camera images, camera intrinsics, media streams, or real-world geometry. Extra
real-world data requires additional feature descriptors and user consent.

This is the key AR-module rule for LLP 0013:

- `"immersive-ar"` alone is not enough.
- Depth requires `"depth-sensing"`.
- Raw camera access requires `"camera-access"`.
- The repo-local API must keep those grants separate.

## `ar-first-person-observer-view`

The AR module defines a first-person observer view with `eye === "none"` for
recording/streaming use cases. It is gated by `"secondary-views"`.

LLP 0013 does not implement `"secondary-views"`, but it borrows the `"none"`
eye value for the single phone-camera view. This is a deliberate simplification:
the demo has one camera-aligned view, not left/right stereo views plus a
secondary observer view.
