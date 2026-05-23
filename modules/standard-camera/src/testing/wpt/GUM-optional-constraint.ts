// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/GUM-optional-constraint.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-optional-constraint.https.html

import { wptSource, test, assert_equals, assert_unreached, promise_test, setMediaPermission } from '../testharness';

wptSource('GUM-optional-constraint.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  await setMediaPermission("granted", ["camera"]);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({video: {advanced: [{width: {min:1024, max: 800}}]}});
    assert_equals(stream.getVideoTracks().length, 1, "the media stream has exactly one video track");
  } catch (error) {
    assert_unreached("an optional constraint can't stop us from obtaining a video stream");
  }
}, "Tests that setting an optional constraint in getUserMedia is handled as optional");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-optional-constraint.https.html — module load failed');
}
