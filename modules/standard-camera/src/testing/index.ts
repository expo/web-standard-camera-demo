// @ref LLP 0010 — In-scope WPT tests are registered as a side-effect of these imports.
//
// `wpt/*.ts` files are verbatim 1:1 ports of the upstream
// web-platform-tests/wpt/mediacapture-streams suite. `local/*.ts` files are
// project-specific tests that cover behavior outside the WPT corpus (e.g.
// our AVCaptureSession interruption-driven mute/unmute path).
//
// Within each group we keep the upstream alphabetical ordering. WPT files
// whose required APIs are outside LLP 0002 (`getDisplayMedia`, Browser Capture
// crop/restrict, cross-origin iframe transfer, Permissions Policy headers,
// SecureContext-only behavior, canvas/WebAudio frame inspection) are kept on
// disk for provenance but are not imported into the active compliance suite.

// WPT — testable on iOS (alphabetical, matching upstream listing)
import './wpt/GUM-api';
import './wpt/GUM-deny';
import './wpt/GUM-echoCancellation-all';
import './wpt/GUM-echoCancellation-boolean';
import './wpt/GUM-echoCancellation-remote-only';
import './wpt/GUM-empty-option-param';
import './wpt/GUM-impossible-constraint';
import './wpt/GUM-invalid-facing-mode';
import './wpt/GUM-non-applicable-constraint';
import './wpt/GUM-optional-constraint';
import './wpt/GUM-permissions-query';
import './wpt/GUM-required-constraint-with-ideal-value';
import './wpt/GUM-trivial-constraint';
import './wpt/GUM-unknownkey-option-param';
import './wpt/historical';
import './wpt/MediaDevices-enumerateDevices';
import './wpt/MediaDevices-enumerateDevices-returned-objects';
import './wpt/MediaDevices-getSupportedConstraints';
import './wpt/MediaDevices-getUserMedia';
import './wpt/MediaStream-add-audio-track';
import './wpt/MediaStream-audio-only';
import './wpt/MediaStream-clone';
import './wpt/MediaStream-finished-add';
import './wpt/MediaStream-gettrackid';
import './wpt/MediaStream-id';
import './wpt/MediaStream-idl';
import './wpt/MediaStream-MediaElement-firstframe';
import './wpt/MediaStream-MediaElement-preload-none';
import './wpt/MediaStream-MediaElement-srcObject';
import './wpt/MediaStream-removetrack';
import './wpt/MediaStream-video-only';
import './wpt/MediaStreamTrack-applyConstraints';
import './wpt/MediaStreamTrack-getCapabilities';
import './wpt/MediaStreamTrack-getSettings';
import './wpt/MediaStreamTrack-id';
import './wpt/MediaStreamTrack-init';
import './wpt/MediaStreamTrackEvent-constructor';
import './wpt/overconstrained_error';

// Project-local tests covering behavior outside the WPT corpus.
import './local/deviceId-pick';
import './local/enumerate-multi-device';
import './local/enumerateDevices-not-allowed-camera';
import './local/enumerateDevices-not-allowed-mic';
import './local/facingMode-switch';
import './local/frameRate-resolution';
import './local/MediaStream-construction';
import './local/MediaStreamTrack-disabled-audio';
import './local/MediaStreamTrack-disabled-video';
import './local/MediaStreamTrack-mute';

export * from './testharness';
