// @ref LLP 0003#gum-build-session — Regression coverage for two bugs in the
// AVCaptureSession configuration path:
//
//   1. AVCaptureSession.Preset caps most iPhone formats at 30 fps. Requesting
//      `frameRate: 60` via the preset path silently degraded to 30. The fix
//      switches the session to `.inputPriority` when a frame rate or
//      resolution is requested, walks `device.formats` to pick the closest
//      match, and locks the device's `activeFormat` + `activeVideoMin/
//      MaxFrameDuration` to the requested rate.
//
//   2. `track.getSettings().frameRate` previously reported the active
//      format's `videoSupportedFrameRateRanges.first.maxFrameRate` — which on
//      a 60 fps-capable format is 60 regardless of what was actually
//      configured. The fix derives the reported rate from
//      `activeVideoMinFrameDuration` so the dict matches what the consumer
//      will observe.
//
// Upstream WPT cannot test these directly because the spec is permissive —
// the UA is free to deliver any reasonable rate. iOS is concrete, so we
// assert the round-trip ourselves. The simulator has no AVCaptureDevice, so
// these tests skip with `environment-skip` there and only run on a physical
// device (see LLP 0010#the-simulator-does-not-have-a-camera-device).

import {
  assert_equals,
  promise_test,
  wptSource,
} from '../testharness';

wptSource(null);

// Pin to the back camera so the test runs on a format we know supports
// 1280×720 @ 60 fps on every shipping iPhone. The front (TrueDepth) camera's
// 60 fps support varies by model.
const BACK_720P_60: MediaStreamConstraints = {
  video: { facingMode: 'environment', width: 1280, height: 720, frameRate: 60 },
};

const BACK_720P_30: MediaStreamConstraints = {
  video: { facingMode: 'environment', width: 1280, height: 720, frameRate: 30 },
};

const BACK_1080P: MediaStreamConstraints = {
  video: { facingMode: 'environment', width: 1920, height: 1080 },
};

promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia(BACK_720P_60);
  try {
    const settings = stream.getVideoTracks()[0].getSettings();
    assert_equals(settings.frameRate, 60, 'requested 60 fps is delivered, not silently capped at 30');
    assert_equals(settings.width, 1280, 'requested width is delivered');
    assert_equals(settings.height, 720, 'requested height is delivered');
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}, 'getUserMedia({width:1280,height:720,frameRate:60}) delivers 60 fps at 720p');

// When the active format's maxFrameRate is 60 but the caller asked for 30,
// the settings dict must report 30 — not the format's max. The pre-fix code
// read `videoSupportedFrameRateRanges.first.maxFrameRate` and so always
// reported 60 here.
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia(BACK_720P_30);
  try {
    const settings = stream.getVideoTracks()[0].getSettings();
    assert_equals(settings.frameRate, 30, 'getSettings reports the configured rate, not the format max');
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}, 'getUserMedia({frameRate:30}) reports 30 fps even when the active format supports up to 60');

// The camera tab restarts gUM on every pill tap; verify that switching the
// frame rate back and forth across calls round-trips each time. Catches a
// regression where the device's frame-duration lock from a previous call
// leaks into the next session.
promise_test(async () => {
  const observed: (number | undefined)[] = [];
  for (const fps of [60, 30, 60] as const) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: 1280, height: 720, frameRate: fps },
    });
    observed.push(stream.getVideoTracks()[0].getSettings().frameRate as number | undefined);
    for (const t of stream.getTracks()) t.stop();
  }
  assert_equals(observed[0], 60, 'first request delivers 60 fps');
  assert_equals(observed[1], 30, 'second request delivers 30 fps');
  assert_equals(observed[2], 60, 'third request re-delivers 60 fps');
}, 'Re-running getUserMedia with different frameRate values round-trips each time');

// 1080p was deliverable via the preset path too, but the format-walk path is
// what keeps it working when frame rate is co-specified. Asserts the
// resolution round-trip in isolation.
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia(BACK_1080P);
  try {
    const settings = stream.getVideoTracks()[0].getSettings();
    assert_equals(settings.width, 1920, '1080p width is delivered');
    assert_equals(settings.height, 1080, '1080p height is delivered');
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}, 'getUserMedia({width:1920,height:1080}) delivers 1920×1080');
