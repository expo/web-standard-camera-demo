// @ref LLP 0002#gum-pick-device — Verifies that `getUserMedia` with a
// `deviceId: {exact: …}` constraint picks the requested camera and that
// `track.getSettings().deviceId` round-trips back to the same value.
//
// Upstream WPT cannot rely on this because browsers may decline to surface
// `deviceId` until the user has granted persistent permission. On iOS we
// surface it after the first successful gUM (LLP 0002).

import {
  assert_equals,
  assert_true,
  promise_test,
  wptSource,
} from '../testharness';

wptSource(null);

promise_test(async () => {
  // Grant once so `enumerateDevices` returns real deviceIds.
  const grant = await navigator.mediaDevices.getUserMedia({ video: true });
  for (const t of grant.getTracks()) t.stop();

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  assert_true(videoInputs.length >= 2, 'at least two video inputs are present');

  // Pick the second device — distinct from the default the system would have
  // returned with `{video: true}` alone, so we know `deviceId` is doing work.
  const target = videoInputs[1];

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: target.deviceId } },
  });
  try {
    const settings = stream.getVideoTracks()[0].getSettings();
    assert_equals(
      settings.deviceId,
      target.deviceId,
      'track.getSettings().deviceId matches the exact deviceId constraint'
    );
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}, 'getUserMedia({deviceId: {exact}}) picks the requested device and round-trips it via getSettings()');
