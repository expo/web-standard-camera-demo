// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/parallel-capture-requests.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/parallel-capture-requests.https.html

import { wptSource, test, assert_equals, assert_greater_than_equal, assert_less_than_equal, promise_test } from '../testharness';

wptSource('parallel-capture-requests.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
async function getDisplayMedia(constraints) {
  const p = new Promise(r => button.onclick = r);
  await test_driver.click(button);
  await p;
  return navigator.mediaDevices.getDisplayMedia(constraints);
}

promise_test(function() {
  const getUserMediaPromise =
        navigator.mediaDevices.getUserMedia({audio: true, video:true});
  const getDisplayMediaPromise =
        getDisplayMedia({video: true, audio: true});
  return Promise.all([getUserMediaPromise, getDisplayMediaPromise])
      .then(function(s) {
        assert_greater_than_equal(s[0].getTracks().length, 1);
        assert_less_than_equal(s[0].getTracks().length, 2);
        assert_equals(s[0].getVideoTracks().length, 1);
        assert_less_than_equal(s[0].getAudioTracks().length, 1);
        assert_greater_than_equal(s[1].getTracks().length, 1);
        assert_less_than_equal(s[1].getTracks().length, 2);
        assert_equals(s[1].getVideoTracks().length, 1);
        assert_less_than_equal(s[1].getAudioTracks().length, 1);
      });
}, 'getDisplayMedia() and parallel getUserMedia()');

promise_test(function() {
  const getDisplayMediaPromise =
        getDisplayMedia({video: true, audio: true});
  const getUserMediaPromise =
        navigator.mediaDevices.getUserMedia({audio: true, video:true});
  return Promise.all([getDisplayMediaPromise, getUserMediaPromise])
      .then(function(s) {
        assert_greater_than_equal(s[0].getTracks().length, 1);
        assert_less_than_equal(s[0].getTracks().length, 2);
        assert_equals(s[0].getVideoTracks().length, 1);
        assert_less_than_equal(s[0].getAudioTracks().length, 1);
        assert_greater_than_equal(s[1].getTracks().length, 1);
        assert_less_than_equal(s[1].getTracks().length, 2);
        assert_equals(s[1].getVideoTracks().length, 1);
        assert_less_than_equal(s[1].getAudioTracks().length, 1);
      });
}, 'getUserMedia() and parallel getDisplayMedia()');
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'parallel-capture-requests.https.html — module load failed');
}
