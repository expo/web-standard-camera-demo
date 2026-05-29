// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/GUM-api.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-api.https.html

import { wptSource, test, assert_true } from '../testharness';

wptSource('GUM-api.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
test(function () {
  assert_true(undefined !== navigator.mediaDevices && undefined !== navigator.mediaDevices.getUserMedia, "navigator.mediaDevices.getUserMedia exists");
}, "mediaDevices.getUserMedia() is present on navigator");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-api.https.html — module load failed');
}
