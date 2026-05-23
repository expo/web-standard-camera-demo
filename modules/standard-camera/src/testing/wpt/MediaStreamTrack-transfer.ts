// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStreamTrack-transfer.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrack-transfer.https.html

import { wptSource, test, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStreamTrack-transfer.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
self.onmessage = (e) => {
  try {
    if(e.data instanceof MediaStreamTrack) {
      self.postMessage({result: 'Success'});
      return;
    } else {
      self.postMessage({
        result: 'Failure',
        error: `${e.data} is not a MediaStreamTrack`
      });
    }
  } catch (error) {
    self.postMessage({
      result: 'Failure',
      error
    });
  }
}



promise_test(async () => {
  const workerBlob = new Blob([document.querySelector('#workerCode').textContent],
                {type: "text/javascript"});
  const workerUrl = window.URL.createObjectURL(workerBlob);
  const worker = new Worker(workerUrl);
  window.URL.revokeObjectURL(workerUrl);
  await setMediaPermission("granted", ["camera"]);
  const stream = await navigator.mediaDevices.getDisplayMedia({video: true});
  const track = stream.getVideoTracks()[0];
  const result = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.result === 'Failure') {
        reject('Failed: ' + e.data.error);
      } else {
        resolve();
      }
    };
  });
  worker.postMessage(track, [track]);
  return result;
});
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrack-transfer.https.html — module load failed');
}
