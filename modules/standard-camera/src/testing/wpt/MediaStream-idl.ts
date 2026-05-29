// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStream-idl.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-idl.https.html

import { wptSource, test, assert_equals, assert_false, assert_not_equals, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStream-idl.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  await setMediaPermission();
  const stream = await navigator.mediaDevices.getUserMedia({video: true, audio:true})
  let stream1 = new MediaStream();
  assert_not_equals(stream.id, stream1.id, "Two different MediaStreams have different ids");
  let stream2 = new MediaStream(stream);
  assert_not_equals(stream.id, stream2.id, "A MediaStream constructed from another has a different id");
  let audioTrack1 = stream.getAudioTracks()[0];
  let videoTrack = stream.getVideoTracks()[0];
  assert_equals(audioTrack1, stream2.getAudioTracks()[0], "A MediaStream constructed from another shares the same audio track");
  assert_equals(videoTrack, stream2.getVideoTracks()[0], "A MediaStream constructed from another shares the same video track");
  let stream4 = new MediaStream([audioTrack1]);
  assert_equals(stream4.getTrackById(audioTrack1.id), audioTrack1, "a non-ended track gets added via the MediaStream constructor");

  let audioTrack2 = audioTrack1.clone();
  audioTrack2.addEventListener("ended", () => {
    throw new Error("ended event should not be fired by MediaStreamTrack.stop().")
  });
  audioTrack2.stop();
  assert_equals(audioTrack2.readyState, "ended", "a stopped track is marked ended synchronously");

  let stream3 = new MediaStream([audioTrack2, videoTrack]);
  assert_equals(stream3.getTrackById(audioTrack2.id), audioTrack2, "an ended track gets added via the MediaStream constructor");
  assert_equals(stream3.getTrackById(videoTrack.id), videoTrack, "a non-ended track gets added via the MediaStream constructor even if the previous track was ended");

  let stream5 = new MediaStream([audioTrack2]);
  assert_equals(stream5.getTrackById(audioTrack2.id), audioTrack2, "an ended track gets added via the MediaStream constructor");
  assert_false(stream5.active, "a MediaStream created using the MediaStream() constructor whose arguments are lists of MediaStreamTrack objects that are all ended, the MediaStream object MUST be created with its active attribute set to false");

  audioTrack1.stop();
  assert_equals(audioTrack1.readyState, "ended",
        "Stopping audioTrack1 marks it ended synchronously");

  videoTrack.stop();
  assert_equals(videoTrack.readyState, "ended",
        "Stopping videoTrack marks it ended synchronously");

  assert_false(stream.active,
        "The original MediaStream is marked inactive synchronously");
  assert_false(stream1.active,
        "MediaStream 1 is marked inactive synchronously");
  assert_false(stream2.active,
        "MediaStream 2 is marked inactive synchronously");
  assert_false(stream3.active,
        "MediaStream 3 is marked inactive synchronously");
  assert_false(stream4.active,
        "MediaStream 4 is marked inactive synchronously");

}, "Tests that a MediaStream constructor follows the algorithm set in the spec");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-idl.https.html — module load failed');
}
