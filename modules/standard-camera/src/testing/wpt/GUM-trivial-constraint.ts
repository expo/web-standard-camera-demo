// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/GUM-trivial-constraint.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-trivial-constraint.https.html

import { wptSource, test, assert_equals, assert_unreached, promise_test, setMediaPermission } from '../testharness';

wptSource('GUM-trivial-constraint.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  await setMediaPermission();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({video: {width: {min:0}}})
    assert_equals(stream.getVideoTracks().length, 1, "the media stream has exactly one video track");
  } catch (error) {
    assert_unreached("a Video stream of minimally zero width can always be created");
  }
}, "Tests that setting a trivial mandatory constraint in getUserMedia works");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-trivial-constraint.https.html — module load failed');
}
