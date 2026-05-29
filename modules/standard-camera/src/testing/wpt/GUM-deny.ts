// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/GUM-deny.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-deny.https.html

import { wptSource, test, assert_false, assert_throws_dom, assert_unreached, promise_test, setMediaPermission } from '../testharness';

wptSource('GUM-deny.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  try {
    await setMediaPermission('denied', ['camera']);
    await navigator.mediaDevices.getUserMedia({video: true})
  } catch (error) {
    assert_throws_dom("NotAllowedError", () => { throw error });
    assert_false('constraintName' in error,
                 "constraintName attribute not set as expected");
    return;
  };
  assert_unreached("The success callback should not be triggered since access is to be denied");
}, "Tests that the error callback is triggered when permission is denied");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-deny.https.html — module load failed');
}
