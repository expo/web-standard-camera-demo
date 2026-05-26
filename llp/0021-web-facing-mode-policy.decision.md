# LLP 0021: Web facing-mode camera selection

**Type:** Decision
**Status:** Active
**Systems:** demo-app, web
**Author:** James Ide
**Date:** 2026-05-26
**Related:** 0000, 0002, 0019

## Context

The Expo Web target uses the browser's native `navigator.mediaDevices` and a
real `HTMLVideoElement`; it does not use the iOS `standard-camera` backend. On
Chrome desktop on a MacBook Pro, a device normally has a single built-in camera
and no physical back-facing camera. Today the demo starts with
`facingMode: "environment"` and the UI exposes a "Back" choice. Because a bare
`facingMode` value is an ideal constraint, Chrome may still return the only
available camera. The result is misleading: the user chooses Back, but the
front-facing built-in camera appears.

The web platform only exposes camera direction when the user agent has a
direction signal for that source. `getSupportedConstraints().facingMode` means
the browser understands the constraint name; it does not prove that any
particular camera has a known direction. `getSettings().facingMode` and
`getCapabilities().facingMode` are positive evidence only when they actually
contain `"user"`, `"environment"`, `"left"`, or `"right"`. On Chrome desktop
MacBook Pro, empirical testing reports no facing mode for the built-in camera.

Chromium's macOS capture path has historically enumerated AVFoundation cameras
with a `VideoCaptureDeviceDescriptor` constructed without a facing-mode
argument, leaving the descriptor at its default `MEDIA_VIDEO_FACING_NONE`.
WPT likewise treats `settings.facingMode` as optional because not all platforms
provide this information.

## Decision

For web, the demo treats a missing facing mode as front/self-view for display
purposes. This is an app UX convention, not a claim that the browser reported
`"user"`.

1. **Default web camera is front/self-view.** The web camera provider starts
   with `facingMode: "user"` as a best-effort ideal. If Chrome returns a stream
   with no reported `settings.facingMode`, the demo resolves the display-facing
   mode to `"user"`.
2. **Reported modes still win.** If a browser reports `"environment"` for the
   active stream, the UI treats it as Back. If it reports `"user"`, the UI
   treats it as Front.
3. **Missing mode snaps back to Front.** If state or a route asks for
   `facingMode: "environment"` on web and Chrome returns a stream with no
   reported facing mode, the app treats the active/default desktop camera as
   Front rather than showing a successful Back selection.
4. **Back availability is probed after permission.** After the first successful
   video grant, the web provider requests
   `facingMode: { exact: "environment" }` on a short-lived probe stream. A
   successful probe enables Back. `OverconstrainedError` / `NotFoundError`
   disables Back for the current page.
5. **Every Back camera switcher respects availability.** Home and camera demo
   segmented controls keep the Back option visible for layout consistency, but
   disable it once the provider reports no environment camera.
6. **Ambiguous webcams are self-view by convention.** A USB webcam, Continuity
   Camera, virtual camera, capture card, or any other source whose orientation
   can change is displayed as Front when the browser gives no facing-mode
   signal. The browser still has not proven the physical direction.
7. **Mirroring follows display-facing mode.** The preview mirrors when the
   display-facing mode is `"user"`, including the missing-mode web convention.

The iOS native path keeps its stricter behavior from LLP 0002: AVFoundation
exposes `.front` and `.back`, and our native implementation treats an explicit
`facingMode` request as exact.

## Consequences

- Chrome on a MacBook Pro should show the built-in camera as Front/self-view
  when Chrome omits `settings.facingMode`.
- External webcams remain selectable by device name, but missing direction is
  treated as Front/self-view by convention. This is a display choice, not proof
  of physical camera orientation.
- A Back selection on desktop Chrome with no reported facing mode should snap
  back to Front after the browser returns the stream, and Back should gray out
  in Home and every camera demo once the exact probe proves no browser-known
  environment camera exists.
- A browser that actually reports `"environment"` still gets a Back selection
  and an unmirrored preview.

## References

- W3C Media Capture and Streams: bare constraints are optional/ideal; only
  `min`, `max`, and `exact` are required constraints.
  https://www.w3.org/TR/mediacapture-streams/#dfn-selectsettings
- W3C Media Capture and Streams: facing modes are `"user"`, `"environment"`,
  `"left"`, and `"right"`.
  https://w3c.github.io/mediacapture-main/getusermedia.html#dom-videofacingmodeenum
- WPT `MediaStreamTrack-getSettings`: facingMode is not mandatory because not
  all platforms provide it.
  https://chromium.googlesource.com/external/w3c/web-platform-tests/+/refs/tags/merge_pr_53804/mediacapture-streams/MediaStreamTrack-getSettings.https.html
- MDN: exact constraints are needed when the caller must know what it actually
  got; otherwise `getSettings()` is the source of truth for selected settings.
  https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Constraints
- Chromium macOS AVFoundation enumeration has constructed device descriptors
  without a facing argument, leaving the default facing mode as none.
  https://chromium.googlesource.com/chromium/src/+/0a611f37b80a2b3ba7a3916d0408de7d2309e5cd/media/capture/video/mac/video_capture_device_factory_mac.mm
