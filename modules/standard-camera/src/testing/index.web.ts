// @ref LLP 0011#browser-tests-tab — Expo Web registers only the in-scope
// browser-runnable subset. Web uses the browser's own Media Capture APIs; it
// must not import project-local iOS backdoor tests that depend on
// NativeStandardCamera internals.

// WPT — in-scope Media Capture and Streams / srcObject coverage.
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

// Project-local tests that exercise the common web-shaped API surface without
// reaching into iOS native backdoors or requiring multiple built-in cameras.
import './local/enumerateDevices-not-allowed-camera';
import './local/enumerateDevices-not-allowed-mic';
import './local/MediaStream-construction';

export * from './testharness';
