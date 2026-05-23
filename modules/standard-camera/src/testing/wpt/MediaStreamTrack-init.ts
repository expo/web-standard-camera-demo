// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStreamTrack-init.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrack-init.https.html

import { wptSource, test, assert_equals, assert_true, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStreamTrack-init.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  await setMediaPermission("granted", ["camera"]);
  const stream = await navigator.mediaDevices.getUserMedia({video: true});
  const videoTracks = stream.getVideoTracks();
  assert_equals(videoTracks.length, 1, "There is exactly one video track in the media stream");
  track = videoTracks[0];
  assert_equals(track.readyState, "live", "The track object is in live state");
  assert_equals(track.kind, "video", "The track object is of video kind");
  // Not clear that this is required by the spec,
  // see https://www.w3.org/Bugs/Public/show_bug.cgi?id=22212
  assert_true(track.enabled, "The track object is enabed");
});
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrack-init.https.html — module load failed');
}
