// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaDevices-SecureContext.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-SecureContext.html

import { wptSource, test, assert_false } from '../testharness';

wptSource('MediaDevices-SecureContext.html');

try {
// === BEGIN WPT BODY (verbatim) ===
test(function() {
  assert_false(window.isSecureContext, "This test must be run in a non secure context");
  assert_false('MediaDevices' in window, "MediaDevices is not exposed");
  assert_false('MediaDeviceInfo' in window, "MediaDeviceInfo is not exposed");
  assert_false('getUserMedia' in navigator, "getUserMedia is not exposed");
  assert_false('mediaDevices' in navigator, "mediaDevices is not exposed");
});
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaDevices-SecureContext.html — module load failed');
}
