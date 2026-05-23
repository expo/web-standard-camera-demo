// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/BrowserCaptureMediaStreamTrack-cropTo.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/BrowserCaptureMediaStreamTrack-cropTo.https.html

import { wptSource, test, assert_equals, assert_false, assert_true, promise_test } from '../testharness';

wptSource('BrowserCaptureMediaStreamTrack-cropTo.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
    async function getDisplayMedia() {
      const p = new Promise(r => button.onclick = r);
      await test_driver.click(button);
      await p;
      return navigator.mediaDevices.getDisplayMedia(
            {video:{displaySurface:"browser"}, selfBrowserSurface:"include"});
    }

    promise_test(async t => {
      const stream = await getDisplayMedia();
      assert_true(stream.active, "stream should be active.");

      assert_equals(stream.getVideoTracks().length, 1);
      const [videoTrack] = stream.getVideoTracks();
      assert_true(videoTrack instanceof MediaStreamTrack,
            "track should be either MediaStreamTrack or a subclass thereof.");
      assert_equals(videoTrack.readyState, "live");

      const div = document.getElementById('test-div');
      const cropTarget = await CropTarget.fromElement(div);
      assert_true(!!videoTrack.cropTo, "cropTo exposed.");
      assert_true(typeof videoTrack.cropTo === 'function',
                  "cropTo is a function.");
      await videoTrack.cropTo(cropTarget);

      assert_true(stream.active, "stream should be active.");
      assert_false(videoTrack.muted, "track should not be muted.");
    }, "Tests that cropping MediaStreamTrack objects works as expected");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'BrowserCaptureMediaStreamTrack-cropTo.https.html — module load failed');
}
