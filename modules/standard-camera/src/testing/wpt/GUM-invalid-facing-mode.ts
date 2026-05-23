// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/GUM-invalid-facing-mode.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-invalid-facing-mode.https.html

import { wptSource, test, assert_equals, assert_unreached, promise_test, setMediaPermission } from '../testharness';

wptSource('GUM-invalid-facing-mode.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  await setMediaPermission("granted", ["camera"]);
  try {
    await navigator.mediaDevices.getUserMedia({video: {facingMode: {exact: ''}}});
    assert_unreached("The empty string is not a valid facingMode");
  } catch (error) {
    assert_equals(error.name, "OverconstrainedError");
    assert_equals(error.constraint, "facingMode");
  };
}, "Tests that setting an invalid facingMode constraint in getUserMedia fails");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-invalid-facing-mode.https.html — module load failed');
}
