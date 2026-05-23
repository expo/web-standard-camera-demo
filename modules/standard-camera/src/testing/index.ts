// @ref LLP 0007 — All ported WPT tests are registered as a side-effect of these imports.
//
// `wpt/*.ts` files are verbatim 1:1 ports of the upstream
// web-platform-tests/wpt/mediacapture-streams suite. `local/*.ts` files are
// project-specific tests that cover behavior outside the WPT corpus (e.g.
// our AVCaptureSession interruption-driven mute/unmute path).
//
// Within each group we keep the upstream alphabetical ordering. The "Not
// applicable in React Native" group at the bottom collects sources that
// depend on browser-platform constructs we don't ship — cross-origin
// iframes, Permissions Policy HTTP headers, SecureContext — and that the
// runner always marks as `skip` via `ENV_SKIPPED_SOURCES`. Grouping them
// last keeps the list of testable-on-iOS tests scannable at the top.

// WPT — testable on iOS (alphabetical, matching upstream listing)
import './wpt/BrowserCaptureMediaStreamTrack-cropTo';
import './wpt/BrowserCaptureMediaStreamTrack-restrictTo';
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
import './wpt/MediaStreamTrack-end-manual';
import './wpt/MediaStreamTrack-getCapabilities';
import './wpt/MediaStreamTrack-getSettings';
import './wpt/MediaStreamTrack-id';
import './wpt/MediaStreamTrack-init';
import './wpt/MediaStreamTrack-MediaElement-disabled-audio-is-silence';
import './wpt/MediaStreamTrack-MediaElement-disabled-video-is-black';
import './wpt/MediaStreamTrackEvent-constructor';
import './wpt/overconstrained_error';
import './wpt/parallel-capture-requests';

// Project-local tests covering behavior outside the WPT corpus.
import './local/deviceId-pick';
import './local/enumerate-multi-device';
import './local/facingMode-switch';
import './local/MediaStream-construction';
import './local/MediaStreamTrack-mute';
import './local/overconstrained-error';

// WPT — not applicable in React Native. These depend on browser-platform
// constructs we don't ship: cross-origin iframes / postMessage transfer,
// Permissions Policy HTTP headers, and SecureContext infrastructure. The
// runner skips them unconditionally via `ENV_SKIPPED_SOURCES`. They are
// imported to keep the pre-rendered test list complete, and grouped here
// so they don't clutter the testable-on-iOS list above.
import './wpt/enumerateDevices-with-navigation';
import './wpt/MediaDevices-after-discard';
import './wpt/MediaDevices-enumerateDevices-not-allowed-camera';
import './wpt/MediaDevices-enumerateDevices-not-allowed-mic';
import './wpt/MediaDevices-enumerateDevices-per-origin-ids.sub';
import './wpt/MediaDevices-enumerateDevices-persistent-permission';
import './wpt/MediaDevices-SecureContext';
import './wpt/MediaStream-default-permissions-policy';
import './wpt/MediaStream-supported-by-permissions-policy';
import './wpt/MediaStreamTrack-iframe-audio-transfer';
import './wpt/MediaStreamTrack-iframe-transfer';
import './wpt/MediaStreamTrack-transfer';
import './wpt/MediaStreamTrack-transfer-video';

export * from './testharness';
