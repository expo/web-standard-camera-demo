// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaDevices-enumerateDevices-persistent-permission.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-enumerateDevices-persistent-permission.https.html

import { wptSource, test, assert_equals, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaDevices-enumerateDevices-persistent-permission.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async t => {
    await setMediaPermission();
    const stream = await navigator.mediaDevices.getUserMedia({audio : true, video: true});
    stream.getTracks().forEach(t => t.stop());
    // the page loaded below hasn't had capture enabled
    // so enumerateDevices should not list detailed info yet
    const iframe = document.createElement("iframe");
    iframe.setAttribute("allow", "microphone;camera");
    iframe.src = "/mediacapture-streams/iframe-enumerate-nogum.html";
    document.body.appendChild(iframe);
    const loadWatcher = new EventWatcher(t, iframe, ['load']);
    await loadWatcher.wait_for('load');
    const msgWatcher = new EventWatcher(t, window, ['message']);
    frames[0].postMessage('run', '*')
    const e = await msgWatcher.wait_for('message');
    const iframeDevices = e.data.devices;
    const kinds = iframeDevices.map(({kind}) => kind);
    assert_equals(kinds.length, new Set(kinds).size, "At most one of a kind prior to capture");
    for (const device of iframeDevices) {
      assert_equals(device.deviceId, "", "deviceId pre-capture is empty");
      assert_equals(device.label, "", "label pre-capture is empty");
      assert_equals(device.groupId, "", "groupId pre-capture is empty");
    }
  });
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaDevices-enumerateDevices-persistent-permission.https.html — module load failed');
}
