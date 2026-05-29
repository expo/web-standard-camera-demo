// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStream-add-audio-track.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-add-audio-track.https.html

import { wptSource, test, assert_equals, assert_unreached, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStream-add-audio-track.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async t => {
  await setMediaPermission();
  const audio = await navigator.mediaDevices.getUserMedia({audio: true});
  const video = await navigator.mediaDevices.getUserMedia({video: true});
  assert_equals(video.getAudioTracks().length, 0, "video mediastream starts with no audio track");
  video.addTrack(audio.getAudioTracks()[0]);
  assert_equals(video.getAudioTracks().length, 1, "video mediastream has now one audio track");
  video.addTrack(audio.getAudioTracks()[0]);
  // If track is already in stream's track set, then abort these steps.
  assert_equals(video.getAudioTracks().length, 1, "video mediastream still has one audio track");

  audio.onaddtrack = t.step_func(function () {
    assert_unreached("onaddtrack is not fired when the script directly modified the track of a mediastream");
  });

  assert_equals(audio.getVideoTracks().length, 0, "audio mediastream starts with no video track");
  audio.addTrack(video.getVideoTracks()[0]);
  assert_equals(audio.getVideoTracks().length, 1, "audio mediastream now has one video track");
}, "Tests that adding a track to a MediaStream works as expected");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-add-audio-track.https.html — module load failed');
}
