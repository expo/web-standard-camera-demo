// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStream-finished-add.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-finished-add.https.html

import { wptSource, test, assert_false, assert_true, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStream-finished-add.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  await setMediaPermission();
  const audio = await navigator.mediaDevices.getUserMedia({audio:true});
  const video = await navigator.mediaDevices.getUserMedia({video:true});
  audio.getAudioTracks()[0].stop();
  assert_false(audio.active, "audio stream is inactive after stopping its only audio track");
  assert_true(video.active, "video stream is active");
  audio.addTrack(video.getVideoTracks()[0]);
  audio.removeTrack(audio.getAudioTracks()[0]);
}, "Tests that adding a track to an inactive MediaStream is allowed");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-finished-add.https.html — module load failed');
}
