// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/historical.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/historical.https.html

import { wptSource, test, assert_false, assert_throws_js } from '../testharness';

wptSource('historical.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
test(function() {
  assert_false("webkitMediaStream" in window);
}, "webkitMediaStream interface should not exist");

test(function() {
  assert_false("getUserMedia" in navigator);
}, "navigator.getUserMedia should not exist");

test(function() {
  assert_false("webkitGetUserMedia" in navigator);
}, "navigator.webkitGetUserMedia should not exist");

test(function() {
  assert_false("mozGetUserMedia" in navigator);
}, "navigator.mozGetUserMedia should not exist");

test(() => {
  const mediaStream = new MediaStream();
  assert_throws_js(TypeError, () => URL.createObjectURL(mediaStream));
}, "Passing MediaStream to URL.createObjectURL() should throw");

test(() => {
  const mediaStream = new MediaStream();
  assert_false("onactive" in mediaStream);
}, "MediaStream.onactive should not exist");

test(() => {
  const mediaStream = new MediaStream();
  assert_false("oninactive" in mediaStream);
}, "MediaStream.oninactive should not exist");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'historical.https.html — module load failed');
}
