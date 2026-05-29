// @ref LLP 0001#dom-mediadevices-enumeratedevices — Audio-side analog of
// `enumerateDevices-not-allowed-camera`. Upstream's
// `MediaDevices-enumerateDevices-not-allowed-mic` blocks the microphone
// via a cross-origin Permissions-Policy header (out of scope for us);
// `setMediaPermission('denied', ['microphone'])` plays the same role here.

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
  await setMediaPermission('denied', ['microphone']);
  const deviceList = await navigator.mediaDevices.enumerateDevices();
  for (const mediaInfo of deviceList) {
    assert_not_equals(mediaInfo.deviceId, undefined, "mediaInfo's deviceId should exist.");
    assert_not_equals(mediaInfo.kind, undefined, "mediaInfo's kind should exist.");
    assert_not_equals(mediaInfo.label, undefined, "mediaInfo's label should exist.");
    assert_not_equals(mediaInfo.groupId, undefined, "mediaInfo's groupId should exist.");
    assert_in_array(mediaInfo.kind, ['videoinput', 'audiooutput']);
  }
}, 'Microphone is not exposed in enumerateDevices() when the kind is denied');

wptRequires(null);
