// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStreamTrack-end-manual.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrack-end-manual.https.html

import { wptSource, test, assert_equals, assert_false, assert_true, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStreamTrack-end-manual.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async t => {
  await setMediaPermission();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  });

  const vidTrack = stream.getVideoTracks()[0];
  assert_equals(vidTrack.readyState, "live",
    "The video track object is in live state");
  const vidEnded = new Promise(r => vidTrack.onended = r);
  const audTrack = stream.getAudioTracks()[0];
  assert_equals(audTrack.readyState, "live",
    "The audio track object is in live state");
  const audEnded = new Promise(r => audTrack.onended = r);

  await Promise.race([vidEnded, audEnded]);
  assert_equals(stream.getTracks().filter(t => t.readyState == "ended").length,
    1, "Only one track is ended after first track's ended event");
  assert_equals(stream.getTracks().filter(t => t.readyState == "live").length,
    1, "One track is still live after first track's ended event");
  assert_true(stream.active, "MediaStream is still active");

  await Promise.all([vidEnded, audEnded]);
  assert_equals(vidTrack.readyState, "ended", "Video track ended as expected");
  assert_equals(audTrack.readyState, "ended", "Audio track ended as expected");
  assert_false(stream.active, "MediaStream has become inactive as expected");
}, "Tests that MediaStreamTracks end properly on permission revocation");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrack-end-manual.https.html — module load failed');
}
