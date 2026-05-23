// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/GUM-required-constraint-with-ideal-value.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-required-constraint-with-ideal-value.https.html

import { wptSource, test, assert_equals, promise_test, setMediaPermission } from '../testharness';

wptSource('GUM-required-constraint-with-ideal-value.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async t => {
  await setMediaPermission("granted", ["camera"]);
  const stream = await navigator.mediaDevices.getUserMedia({video: {width: {ideal: 320, min: 160}}});
  assert_equals(stream.getVideoTracks().length, 1, "the media stream has exactly one video track");
  assert_equals(stream.getVideoTracks()[0].getSettings().width, 320, 'ideal width is selected for getUserMedia() video tracks');
  const video = document.createElement('video');
  video.srcObject = stream;
  await video.play();
  assert_equals(video.videoWidth, 320, 'video width equals to track width');
  stream.getVideoTracks()[0].stop();
}, "Tests that setting a required constraint with an ideal value in getUserMedia works");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-required-constraint-with-ideal-value.https.html — module load failed');
}
