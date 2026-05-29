// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStreamTrack-id.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrack-id.https.html

import { wptSource, test, assert_not_equals, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStreamTrack-id.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  await setMediaPermission();
  const stream = await navigator.mediaDevices.getUserMedia({video: true, audio: true})
  assert_not_equals(stream.getVideoTracks()[0], stream.getAudioTracks()[0].id, "audio and video tracks have distinct ids");
}, "Tests that distinct mediastream tracks have distinct ids ");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrack-id.https.html — module load failed');
}
