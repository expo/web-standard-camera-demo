// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/GUM-empty-option-param.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-empty-option-param.https.html

import { wptSource, test, assert_false, assert_throws_js, assert_unreached, promise_test } from '../testharness';

wptSource('GUM-empty-option-param.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  try {
    // Race a settled promise to check that the returned promise is already
    // rejected.
    await Promise.race([navigator.mediaDevices.getUserMedia({}),
                       Promise.resolve()]);
  } catch (error) {
    assert_throws_js(TypeError, () => { throw error });
    assert_false('constraintName' in error,
                 "constraintName attribute not set as expected");
    return;
  }
  assert_unreached("should have returned an already-rejected promise.");
}, "Tests that getUserMedia is rejected with a TypeError when used with an empty options parameter");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-empty-option-param.https.html — module load failed');
}
