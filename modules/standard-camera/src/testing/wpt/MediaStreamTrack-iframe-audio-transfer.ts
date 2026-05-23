// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStreamTrack-iframe-audio-transfer.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrack-iframe-audio-transfer.https.html

import { wptSource, test, assert_equals, assert_not_equals, promise_test } from '../testharness';

wptSource('MediaStreamTrack-iframe-audio-transfer.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  const iframe = document.createElement("iframe");
  await test_driver.bless('getDisplayMedia');
  const stream = await navigator.mediaDevices.getDisplayMedia({audio:true, video: true});
  const track = stream.getAudioTracks()[0];
  const result = new Promise((resolve, reject) => {
    window.onmessage = (e) => {
      if (e.data.result === 'Failure') {
        reject('Failed: ' + e.data.error);
      } else {
        resolve();
      }
    };
  });
  iframe.addEventListener("load", () => {
    assert_not_equals(track.readyState, "ended");
    iframe.contentWindow.postMessage(track);
    assert_equals(track.readyState, "ended");
  });
  iframe.src = "support/iframe-MediaStreamTrack-transfer.html";
  document.body.appendChild(iframe);
  return result;
});
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrack-iframe-audio-transfer.https.html — module load failed');
}
