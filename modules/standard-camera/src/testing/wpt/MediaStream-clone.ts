// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStream-clone.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-clone.https.html

import { wptSource, test, assert_equals, assert_false, assert_not_equals, assert_true, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStream-clone.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async t => {
  await setMediaPermission();
  const stream = await navigator.mediaDevices.getUserMedia({video: true, audio: true});
  assert_equals(stream.getAudioTracks().length, 1);
  assert_equals(stream.getVideoTracks().length, 1);

  const clone1 = stream.clone();
  assert_equals(clone1.getAudioTracks().length, 1);
  assert_equals(clone1.getVideoTracks().length, 1);
  assert_not_equals(stream.getAudioTracks()[0].id, clone1.getAudioTracks()[0].id);
  assert_not_equals(stream.getVideoTracks()[0].id, clone1.getVideoTracks()[0].id);

  stream.getTracks().forEach(track => track.stop());
  assert_false(stream.active);
  assert_equals(stream.getAudioTracks()[0].readyState, "ended");
  assert_equals(stream.getVideoTracks()[0].readyState, "ended");
  assert_true(clone1.active);
  assert_equals(clone1.getAudioTracks()[0].readyState, "live");
  assert_equals(clone1.getVideoTracks()[0].readyState, "live");

  clone1.getAudioTracks()[0].stop();
  assert_true(clone1.active);
  assert_equals(clone1.getAudioTracks()[0].readyState, "ended");
  assert_equals(clone1.getVideoTracks()[0].readyState, "live");

  const clone2 = clone1.clone();
  assert_true(clone2.active);
  assert_equals(clone2.getAudioTracks()[0].readyState, "ended");
  assert_equals(clone2.getVideoTracks()[0].readyState, "live");

  clone1.getVideoTracks()[0].stop();
  clone2.getVideoTracks()[0].stop();

  const clone3 = clone2.clone();
  assert_false(clone3.active);
  assert_equals(clone3.getAudioTracks()[0].readyState, "ended");
  assert_equals(clone3.getVideoTracks()[0].readyState, "ended");
  assert_not_equals(clone1.getAudioTracks()[0].id, clone2.getAudioTracks()[0].id);
  assert_not_equals(clone1.getVideoTracks()[0].id, clone2.getVideoTracks()[0].id);
  assert_not_equals(clone2.getAudioTracks()[0].id, clone3.getAudioTracks()[0].id);
  assert_not_equals(clone2.getVideoTracks()[0].id, clone3.getVideoTracks()[0].id);
  assert_not_equals(clone1.getAudioTracks()[0].id, clone3.getAudioTracks()[0].id);
  assert_not_equals(clone1.getVideoTracks()[0].id, clone3.getVideoTracks()[0].id);
}, "Tests that cloning MediaStream objects works as expected");

promise_test(async t => {
  const stream = await navigator.mediaDevices.getUserMedia({video: true, audio: true});
  assert_equals(stream.getAudioTracks().length, 1);
  assert_equals(stream.getVideoTracks().length, 1);
  assert_equals(stream.getAudioTracks()[0].readyState, "live");
  assert_equals(stream.getVideoTracks()[0].readyState, "live");
  assert_true(stream.active);

  const audio_clone = stream.getAudioTracks()[0].clone();
  const video_clone = stream.getVideoTracks()[0].clone();
  assert_equals(audio_clone.readyState, "live");
  assert_equals(video_clone.readyState, "live");
  assert_not_equals(stream.getAudioTracks()[0].id, audio_clone.id);
  assert_not_equals(stream.getVideoTracks()[0].id, video_clone.id);

  stream.getTracks().forEach(track => track.stop());
  assert_false(stream.active);
  assert_equals(stream.getAudioTracks()[0].readyState, "ended");
  assert_equals(stream.getVideoTracks()[0].readyState, "ended");
  assert_equals(audio_clone.readyState, "live");
  assert_equals(video_clone.readyState, "live");

  stream.addTrack(audio_clone);
  stream.addTrack(video_clone);
  assert_true(stream.active);

  stream.getTracks().forEach(track => track.stop());
  assert_false(stream.active);
  assert_equals(audio_clone.readyState, "ended");
  assert_equals(video_clone.readyState, "ended");
}, "Tests that cloning MediaStreamTrack objects works as expected");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-clone.https.html — module load failed');
}
