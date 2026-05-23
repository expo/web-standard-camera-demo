// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStream-supported-by-permissions-policy.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-supported-by-permissions-policy.html

import { wptSource, test, assert_in_array } from '../testharness';

wptSource('MediaStream-supported-by-permissions-policy.html');

try {
// === BEGIN WPT BODY (verbatim) ===
test(() => {
    assert_in_array('camera', document.permissionsPolicy.features());
}, 'document.permissionsPolicy.features should advertise camera.');

test(() => {
    assert_in_array('microphone', document.permissionsPolicy.features());
}, 'document.permissionsPolicy.features should advertise microphone.');
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-supported-by-permissions-policy.html — module load failed');
}
