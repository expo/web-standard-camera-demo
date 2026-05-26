# LLP 0018: Media Capture Depth Stream Extensions - spec slices

**Type:** Spec
**Status:** Active
**Systems:** standard-camera, lidar-depth-research
**Author:** James Ide
**Date:** 2026-05-25
**Related:** 0000, 0001, 0012

## Purpose

This LLP is a trimmed, repo-local copy of the W3C Media Capture Depth Stream
Extensions sections that matter to the `getUserMedia` LiDAR/depth decision in
[LLP 0012](./0012-lidar-webgpu-depth-demo.plan.md).

Authoritative source: https://www.w3.org/TR/mediacapture-depth/

The source document is a W3C Discontinued Draft from 2022. This LLP keeps the
final draft's `videoKind`-based Media Capture shape because it is directly
relevant to whether this repo should expose LiDAR through `getUserMedia`.

Deleted as unrelated: acknowledgements, reference indexes, detailed WebGL code
examples, broad use-case prose, and older 2015 draft shapes such as a separate
`MediaStreamTrack.kind === "depth"` or `stream.getDepthTracks()`. Those older
shapes are useful historical context, but they are not the final discontinued
draft this repo should evaluate.

Section headings carry stable local anchors. Code may cite these with
`@ref LLP 0018#<anchor>`.

## `depth-discontinued-status`

The upstream document is a W3C Discontinued Draft. The working group explicitly
stopped advancing the specification because of lack of implementation momentum.

LLP 0012 and LLP 0001 therefore treat this source as abandoned standards work,
not a live web-platform requirement. Any implementation of these shapes in this
repo would need to be labeled experimental and discontinued.

## `depth-mediacapture-extension`

The draft extends Media Capture and Streams so authors can request:

- a depth-only stream
- a combined depth+color stream

The extension is intentionally framed around familiar Media Capture APIs,
especially `navigator.mediaDevices.getUserMedia()`, `MediaStream`,
`MediaStreamTrack`, constraints, capabilities, and settings.

LLP 0001 keeps this entire extension out of the v1 `standard-camera` subset.
Native LiDAR may exist beside `getUserMedia`, but it is not exposed through
these Media Capture members.

## `depth-terminology`

Relevant upstream terms:

- A depth+color stream is a `MediaStream` containing one or more tracks whose
  `videoKind` setting is `"depth"` and one or more tracks whose `videoKind`
  setting is `"color"`.
- A depth-only stream is a `MediaStream` containing only depth stream tracks.
- A color-only stream is a `MediaStream` containing color stream tracks and,
  optionally, audio tracks.
- A depth stream track is a `MediaStreamTrack` whose `videoKind` setting is
  `"depth"` and whose source is a depth camera.
- A color stream track is a `MediaStreamTrack` whose `videoKind` setting is
  `"color"` and whose source is a color camera.

The final draft does not define a new `MediaStreamTrack.kind === "depth"`.
Depth remains video-like media selected through `videoKind`.

## `depth-map`

The draft defines a depth map as a two-dimensional array describing the
perpendicular distance from the surfaces of scene objects to the camera near
plane. Depth map values are normalized against the near/far plane range.

This differs from the WebXR Depth Sensing Module shape in LLP 0016, where depth
values are exposed with a `rawValueToMeters` scale and a view-to-depth-buffer
transform. The difference is one reason LLP 0012 avoids adding this discontinued
Media Capture depth model to the app's current camera API surface.

## `depth-supported-constraints`

Relevant upstream shape:

```webidl
partial dictionary MediaTrackSupportedConstraints {
  boolean videoKind = true;
};
```

The draft adds `videoKind` as an applicable constrainable property for color
and depth stream tracks.

LLP 0001 intentionally does not add `videoKind` to
`MediaTrackSupportedConstraints`, `getSupportedConstraints()`, or the TypeScript
surface.

## `depth-capabilities-constraints-settings`

Relevant upstream shapes:

```webidl
partial dictionary MediaTrackCapabilities {
  DOMString videoKind;
};

partial dictionary MediaTrackConstraintSet {
  ConstrainDOMString videoKind;
};

partial dictionary MediaTrackSettings {
  DOMString videoKind;
};

enum VideoKindEnum {
  "color",
  "depth"
};
```

The `videoKind` constrainable property applies to both color and depth stream
tracks. `"color"` selects a color camera source; `"depth"` selects a depth
camera source.

LLP 0001 keeps these members out of scope. The current implementation's
`MediaStreamTrack.getCapabilities()`, `getConstraints()`, and `getSettings()`
must not report `videoKind`.

## `depth-getusermedia-example`

The draft's final spelling for depth capture uses ordinary Media Capture
constraints:

```js
await navigator.mediaDevices.getUserMedia({
  video: { videoKind: { exact: "depth" } },
});
```

The draft also demonstrates requesting a color stream and a depth stream from
the same `groupId` so an application can pair the two streams.

LLP 0012 rejects this spelling for the default app because it would make the
demo look like a current W3C camera API feature when the relevant W3C draft is
discontinued.

## `depth-video-element-consumer`

The draft treats the `video` element as the `MediaStream` consumer for
depth-only and depth+color streams. If a track whose `videoKind` is `"depth"` is
muted or disabled, it renders frames as if all pixels were `0`.

This is not enough for the LiDAR WebGPU demo. The demo needs explicit depth
bytes in meters, RGB/depth alignment, and enough metadata to upload useful
textures into WebGPU.

## `depth-webgl-context`

The draft contains non-normative WebGL guidance for uploading depth-video
frames into floating-point textures and reading float pixels back from WebGL.

This context is relevant only as evidence that a useful depth media stream
quickly needs GPU and pixel-format details. LLP 0012 deletes the detailed WebGL
examples from the local source slice because the current demo uses
`react-native-wgpu` and WGSL, not WebGL.

## `depth-privacy-security`

The draft inherits Media Capture privacy and security considerations. Depth
data describes the user's physical environment and should be treated as
sensitive sensor data.

LLP 0012 maps that posture to an explicit native LiDAR extension, not to
default `getUserMedia` behavior. Starting the LiDAR path should request native
camera permission and make camera use visible through platform indicators.
