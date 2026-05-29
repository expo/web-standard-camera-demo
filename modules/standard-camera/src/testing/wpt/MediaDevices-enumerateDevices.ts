// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaDevices-enumerateDevices.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-enumerateDevices.https.html

import { wptSource, test, assert_equals, assert_greater_than, assert_greater_than_equal, assert_in_array, assert_less_than_equal, assert_not_equals, assert_true, assert_unreached, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaDevices-enumerateDevices.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
//NOTE ALEX: for completion, a test for ondevicechange event is missing.

promise_test(async () => {
  assert_not_equals(navigator.mediaDevices.enumerateDevices, undefined, "navigator.mediaDevices.enumerateDevices exists");
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const {kind, deviceId, label, groupId} of devices) {
    assert_in_array(kind, ["videoinput", "audioinput", "audiooutput"]);
    assert_equals(deviceId, "", "deviceId should be empty string if getUserMedia was never called successfully.");
    assert_equals(label, "", "label should be empty string if getUserMedia was never called successfully.");
    assert_equals(groupId, "", "groupId should be empty string if getUserMedia was never called successfully.");
  }
  assert_less_than_equal(devices.filter(({kind}) => kind == "audioinput").length,
                         1, "there should be zero or one audio input device.");
  assert_less_than_equal(devices.filter(({kind}) => kind == "videoinput").length,
                         1, "there should be zero or one video input device.");
  assert_equals(devices.filter(({kind}) => kind == "audiooutput").length,
                0, "there should be no audio output devices.");
  assert_less_than_equal(devices.length, 2,
                         "there should be no more than two devices.");
  if (devices.length > 1) {
    assert_equals(devices[0].kind, "audioinput", "audioinput is first");
    assert_equals(devices[1].kind, "videoinput", "videoinput is second");
  }
}, "mediaDevices.enumerateDevices() is present and working - before capture");

promise_test(async t => {
  await setMediaPermission("granted");
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  stream.getTracks()[0].stop();

  const devices = await navigator.mediaDevices.enumerateDevices();
  const kinds = ["audioinput", "videoinput"];
  for (const {kind, deviceId} of devices) {
    assert_in_array(kind, kinds, "camera doesn't expose audiooutput");
    assert_equals(typeof deviceId, "string", "deviceId is a string.");
    switch (kind) {
      case "videoinput":
        assert_greater_than(deviceId.length, 0, "video deviceId should not be empty.");
        break;
      case "audioinput":
        assert_equals(deviceId.length, 0, "audio deviceId should be empty.");
        break;
    }
  }
}, "mediaDevices.enumerateDevices() is working - after video capture");

// This test is designed to come after its video counterpart directly above
promise_test(async t => {
  const devices1 = await navigator.mediaDevices.enumerateDevices();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks()[0].stop();
  const devices = await navigator.mediaDevices.enumerateDevices();
  assert_equals(devices.filter(({kind}) => kind == "videoinput").length,
                devices1.filter(({kind}) => kind == "videoinput").length,
                "same number of (previously exposed) videoinput devices");
  assert_greater_than_equal(devices.filter(d => d.kind == "audioinput").length,
                            devices1.filter(d => d.kind == "audioinput").length,
                            "same number or more audioinput devices");
  const order = ["audioinput", "videoinput", "audiooutput"];
  for (const {kind, deviceId} of devices) {
    assert_in_array(kind, order, "expected kind");
    assert_equals(typeof deviceId, "string", "deviceId is a string.");
    switch (kind) {
      case "videoinput":
        assert_greater_than(deviceId.length, 0, "video deviceId should not be empty.");
        break;
      case "audioinput":
        assert_greater_than(deviceId.length, 0, "audio deviceId should not be empty.");
        break;
    }
  }
  const kinds = devices.map(({kind}) => kind);
  const correct = [...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  assert_equals(JSON.stringify(kinds), JSON.stringify(correct), "correct order");
}, "mediaDevices.enumerateDevices() is working - after video then audio capture");

promise_test(async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const mediaInfo of devices) {
    if (mediaInfo.kind == "audioinput" || mediaInfo.kind == "videoinput") {
      assert_true("InputDeviceInfo" in window, "InputDeviceInfo exists");
      assert_true(mediaInfo instanceof InputDeviceInfo);
    } else if (mediaInfo.kind == "audiooutput") {
      assert_true(mediaInfo instanceof MediaDeviceInfo);
    } else {
      assert_unreached("mediaInfo.kind should be one of 'audioinput', 'videoinput', or 'audiooutput'.")
    }
  }
}, "InputDeviceInfo is supported");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaDevices-enumerateDevices.https.html — module load failed');
}
