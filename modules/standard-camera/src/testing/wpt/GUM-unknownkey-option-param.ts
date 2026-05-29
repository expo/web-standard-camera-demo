// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/GUM-unknownkey-option-param.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-unknownkey-option-param.https.html

import { wptSource, test, assert_equals, assert_unreached, promise_test } from '../testharness';

wptSource('GUM-unknownkey-option-param.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  try {
    await navigator.mediaDevices.getUserMedia({doesnotexist:true})
    assert_unreached("This should never be triggered since the constraints parameter only contains an unrecognized constraint");
  } catch (error) {
    assert_equals(error.name, "TypeError", "TypeError returned as expected");
    assert_equals(error.constraintName, undefined, "constraintName attribute not set as expected");
  }
}, "Tests that getUserMedia is rejected with a TypeError when used with an unknown constraint");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-unknownkey-option-param.https.html — module load failed');
}
