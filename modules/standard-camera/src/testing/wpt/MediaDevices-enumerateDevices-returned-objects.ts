// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaDevices-enumerateDevices-returned-objects.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaDevices-enumerateDevices-returned-objects.https.html

import { wptSource, test, assert_equals, assert_in_array, assert_not_equals, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaDevices-enumerateDevices-returned-objects.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
function doTest(callGetUserMedia, testName)
{
    promise_test(async () => {
        if (callGetUserMedia) {
            await setMediaPermission();
            await navigator.mediaDevices.getUserMedia({audio : true, video: true});
        }

        const deviceList1 =  await navigator.mediaDevices.enumerateDevices();
        const deviceList2 =  await navigator.mediaDevices.enumerateDevices();

        assert_equals(deviceList1.length, deviceList2.length);
        for (let i = 0; i < deviceList1.length; i++) {
            const device1 = deviceList1[i];
            const device2 = deviceList2[i];
            assert_not_equals(device1, device2);
            assert_equals(device1.deviceId, device2.deviceId, "deviceId");
            assert_equals(device1.kind, device2.kind, "kind");
            if (!callGetUserMedia) {
              /* For camera and microphone devices,
               if the browsing context did not capture (i.e. getUserMedia() was not called or never resolved successfully),
               the MediaDeviceInfo object will contain a valid value for kind
               but empty strings for deviceId, label, and groupId. */
              assert_equals(device1.deviceId, "", "deviceId is empty before capture");
              assert_equals(device1.groupId, "", "groupId is empty before capture");
              assert_equals(device1.label, "", "label is empty before capture");
              assert_in_array(device1.kind, ["audioinput", "audiooutput", "videoinput"],
                              "kind is set to a valid value before capture");
            }
        }
        /* Additionally, at most one device of each kind
           will be listed in enumerateDevices() result. */
        // FIXME: ensure browsers are tested as if they had multiple devices of at least one kind -
        // this probably needs https://w3c.github.io/mediacapture-automation/ support
        if (!callGetUserMedia) {
            const deviceKinds = deviceList1.map(d => d.kind);
            for (let kind of deviceKinds) {
              assert_equals(deviceKinds.filter(x => x===kind).length, 1, "At most 1 " + kind + " prior to capture");
            }
        }
    }, testName);
}

doTest(false, "enumerateDevices exposes mostly empty objects ahead of successful getUserMedia call");
doTest(true, "enumerateDevices exposes expected objects after successful getUserMedia call");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaDevices-enumerateDevices-returned-objects.https.html — module load failed');
}
