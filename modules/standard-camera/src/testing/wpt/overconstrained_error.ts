// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/overconstrained_error.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/overconstrained_error.https.html

import { wptSource, test, assert_equals, assert_true, assert_unreached, promise_test } from '../testharness';

wptSource('overconstrained_error.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async t => {
  try {
    stream = await navigator.mediaDevices.getUserMedia(
      {video: {width: {exact: 639}, resizeMode: {exact: "none"}}});
    t.add_cleanup(()=>stream.getVideoTracks()[0].stop());
    t.step(() => assert_unreached('applyConstraints should have failed'));
  } catch(e) {
    assert_true(e instanceof DOMException);
    assert_equals(e.name, 'OverconstrainedError');
    assert_equals(e.constraint, 'width');
  }
}, 'Error of OverconstrainedError type inherit from DOMException');

promise_test(async t => {
    assert_true(new OverconstrainedError("constraint") instanceof DOMException);
}, 'OverconstrainedError class inherits from DOMException');
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'overconstrained_error.https.html — module load failed');
}
