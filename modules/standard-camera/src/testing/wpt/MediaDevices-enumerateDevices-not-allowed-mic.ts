// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaDevices-enumerateDevices-not-allowed-mic.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-enumerateDevices-not-allowed-mic.https.html

import { wptSource, test, assert_in_array, assert_not_equals, promise_test } from '../testharness';

wptSource('MediaDevices-enumerateDevices-not-allowed-mic.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  assert_not_equals(navigator.mediaDevices.enumerateDevices, undefined, "navigator.mediaDevices.enumerateDevices exists");
  const deviceList =  await navigator.mediaDevices.enumerateDevices();
  for (const mediaInfo of deviceList) {
    assert_not_equals(mediaInfo.deviceId, undefined, "mediaInfo's deviceId should exist.");
    assert_not_equals(mediaInfo.kind, undefined,     "mediaInfo's kind     should exist.");
    assert_not_equals(mediaInfo.label, undefined,    "mediaInfo's label    should exist.");
    assert_not_equals(mediaInfo.groupId, undefined,  "mediaInfo's groupId  should exist.");
    assert_in_array(mediaInfo.kind, ["videoinput", "audiooutput"]);
  }
}, "Microphone is not exposed in mediaDevices.enumerateDevices() when blocked by Permissions-Policy");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaDevices-enumerateDevices-not-allowed-mic.https.html — module load failed');
}
