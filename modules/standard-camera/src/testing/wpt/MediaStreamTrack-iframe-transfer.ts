// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStreamTrack-iframe-transfer.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrack-iframe-transfer.https.html

import { wptSource, test, assert_equals, assert_not_equals, promise_test } from '../testharness';

wptSource('MediaStreamTrack-iframe-transfer.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  const iframe = document.createElement("iframe");
  await test_driver.bless('getDisplayMedia');
  const stream = await navigator.mediaDevices.getDisplayMedia({video: true});
  const track = stream.getVideoTracks()[0];
  const iframeLoaded = new Promise((resolve) => {iframe.onload = resolve});

  iframe.src = "support/iframe-MediaStreamTrack-transfer.html";
  document.body.appendChild(iframe);

  await iframeLoaded;

  const nextMessage = new Promise((resolve) => {
    window.onmessage = resolve
  });

  assert_not_equals(track.readyState, "ended");
  iframe.contentWindow.postMessage(track);
  assert_equals(track.readyState, "ended");

  const message = await nextMessage;
  assert_not_equals(message.data.result, 'Failure', 'Failed: ' + message.data.error);
});
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrack-iframe-transfer.https.html — module load failed');
}
