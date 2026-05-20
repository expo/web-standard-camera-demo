// @ref LLP 0007 — Port of wpt/mediacapture-streams/MediaDevices-getUserMedia.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-getUserMedia.https.html

import {
  assert_equals,
  assert_not_equals,
  assert_greater_than_equal,
  assert_true,
  promise_test,
  test,
} from '../testharness';

// @ref LLP 0001#mediadevices-getusermedia
test(() => {
  assert_not_equals(
    navigator.mediaDevices.getUserMedia,
    undefined,
    'navigator.mediaDevices.getUserMedia exists.'
  );
}, 'getUserMedia exists on navigator.mediaDevices');

// @ref LLP 0002 — happy path: video-only returns a MediaStream with one video track
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  assert_true(stream.active, 'stream is active');
  assert_equals(stream.getTracks().length, 1, 'stream has exactly one track');
  assert_equals(stream.getVideoTracks().length, 1, 'stream has one video track');
  assert_equals(stream.getAudioTracks().length, 0, 'stream has no audio tracks');

  const track = stream.getVideoTracks()[0];
  assert_equals(track.kind, 'video', 'track.kind is "video"');
  assert_equals(track.readyState, 'live', 'track.readyState is "live"');

  for (const t of stream.getTracks()) t.stop();
}, 'getUserMedia({video:true}) returns a MediaStream with one live video track');

// @ref LLP 0003#track-getSettings — settings shape
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  assert_not_equals(settings.deviceId, undefined, 'settings.deviceId present');
  assert_not_equals(settings.facingMode, undefined, 'settings.facingMode present');
  assert_greater_than_equal(settings.width ?? 0, 1, 'settings.width > 0');
  assert_greater_than_equal(settings.height ?? 0, 1, 'settings.height > 0');
  assert_greater_than_equal(settings.frameRate ?? 0, 1, 'settings.frameRate > 0');
  for (const t of stream.getTracks()) t.stop();
}, 'video track getSettings() returns plausible settings');

// @ref LLP 0002#gum-validate-constraints — empty constraints rejects with TypeError
promise_test(async () => {
  try {
    await navigator.mediaDevices.getUserMedia({});
    throw new Error('did not reject');
  } catch (e) {
    const err = e as Error;
    assert_equals(err.name, 'TypeError', 'rejection name is TypeError');
  }
}, 'getUserMedia({}) rejects with TypeError');

// @ref LLP 0001#mediadevices-getsupportedconstraints
test(() => {
  const supported = navigator.mediaDevices.getSupportedConstraints();
  assert_equals(supported.width, true, 'width supported');
  assert_equals(supported.height, true, 'height supported');
  assert_equals(supported.facingMode, true, 'facingMode supported');
}, 'getSupportedConstraints reports the documented subset');
