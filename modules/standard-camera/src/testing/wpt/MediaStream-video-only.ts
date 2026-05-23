// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStream-video-only.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-video-only.https.html

import { wptSource, test, assert_equals, assert_true, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStream-video-only.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () =>  {
  await setMediaPermission("granted", ["camera"]);
  const stream = await navigator.mediaDevices.getUserMedia({video: true});
  assert_true(stream instanceof MediaStream, "getUserMedia success callback comes with a MediaStream object");
  assert_equals(stream.getAudioTracks().length, 0, "the media stream has zero audio track");
  assert_equals(stream.getVideoTracks().length, 1, "the media stream has exactly one video track");
  assert_equals(stream.getVideoTracks()[0].kind, "video", "getAudioTracks() returns a sequence of tracks whose kind is 'video'");
}, "Tests that a MediaStream with at least one video track is returned");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-video-only.https.html — module load failed');
}
