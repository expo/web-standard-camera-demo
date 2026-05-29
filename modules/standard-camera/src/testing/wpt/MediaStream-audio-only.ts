// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStream-audio-only.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-audio-only.https.html

import { wptSource, test, assert_equals, assert_true, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStream-audio-only.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () =>  {
  await setMediaPermission();
  const stream = await navigator.mediaDevices.getUserMedia({audio:true});
  assert_true(stream instanceof MediaStream, "getUserMedia success callback comes with a MediaStream object");
  assert_equals(stream.getAudioTracks().length, 1, "the media stream has exactly one audio track");
  assert_equals(stream.getAudioTracks()[0].kind, "audio", "getAudioTracks() returns a sequence of tracks whose kind is 'audio'");
  assert_equals(stream.getVideoTracks().length, 0, "the media stream has zero video track");
}, "Tests that a MediaStream with exactly one audio track is returned");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-audio-only.https.html — module load failed');
}
