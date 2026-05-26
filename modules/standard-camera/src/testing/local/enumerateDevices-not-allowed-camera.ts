// @ref LLP 0008#mediadevices-enumeratedevices — When a device kind is
// blocked from the document, `enumerateDevices()` MUST omit it entirely
// (not the pre-grant "one empty entry" representation). Upstream WPT
// (`MediaDevices-enumerateDevices-not-allowed-camera`) drives this state
// with a cross-origin Permissions-Policy header, which we can't replicate
// (LLP 0001 puts cross-origin frames out of scope). Our project-local
// `setMediaPermission('denied', ['camera'])` helper plays the same role:
// it marks the kind as denied and `MediaDevices.enumerateDevices` honours
// the denial set the same way it honours the Permissions-Policy block.

import {
  assert_in_array,
  assert_not_equals,
  promise_test,
  setMediaPermission,
  wptSource,
  wptRequires,
} from '../testharness';

wptSource(null);
wptRequires('always');

promise_test(async () => {
  await setMediaPermission('denied', ['camera']);
  const deviceList = await navigator.mediaDevices.enumerateDevices();
  for (const mediaInfo of deviceList) {
    assert_not_equals(mediaInfo.deviceId, undefined, "mediaInfo's deviceId should exist.");
    assert_not_equals(mediaInfo.kind, undefined, "mediaInfo's kind should exist.");
    assert_not_equals(mediaInfo.label, undefined, "mediaInfo's label should exist.");
    assert_not_equals(mediaInfo.groupId, undefined, "mediaInfo's groupId should exist.");
    // The denied kind must not appear. `audiooutput` is allowed but our
    // platform doesn't enumerate any (no speaker enumeration in v1).
    assert_in_array(mediaInfo.kind, ['audioinput', 'audiooutput']);
  }
}, 'Camera is not exposed in enumerateDevices() when the kind is denied');

wptRequires(null);
