// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStreamTrack-transfer-video.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrack-transfer-video.https.html

import { wptSource, test, promise_test } from '../testharness';

wptSource('MediaStreamTrack-transfer-video.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  const iframe = document.createElement("iframe");
  const stream = await navigator.mediaDevices.getUserMedia({video: true});
  const track = stream.getVideoTracks()[0];
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
    iframe.contentWindow.postMessage(track, "*", [track]);
  });
  iframe.src = "support/iframe-MediaStreamTrack-transfer-video.html";
  document.body.appendChild(iframe);
  return result;
});
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrack-transfer-video.https.html — module load failed');
}
