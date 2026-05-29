// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaDevices-getSupportedConstraints.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-getSupportedConstraints.https.html

import { wptSource, test, assert_equals, assert_inherits, assert_true } from '../testharness';

wptSource('MediaDevices-getSupportedConstraints.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
test(() => {
  assert_inherits(navigator.mediaDevices, "getSupportedConstraints");
  assert_equals(typeof navigator.mediaDevices.getSupportedConstraints, "function");
}, "navigator.mediaDevices.getSupportedConstraints exists");

{
  const properties = [
    "width",
    "height",
    "aspectRatio",
    "frameRate",
    "facingMode",
    "resizeMode",
    "sampleRate",
    "sampleSize",
    "echoCancellation",
    "autoGainControl",
    "noiseSuppression",
    "voiceIsolation",
    "latency",
    "channelCount",
    "deviceId",
    "groupId"];
  properties.forEach(property => {
    test(()=>{
      const supportedConstraints = navigator.mediaDevices.getSupportedConstraints();
      assert_true(supportedConstraints[property]);
    }, property + " is supported");
  });
}
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaDevices-getSupportedConstraints.https.html — module load failed');
}
