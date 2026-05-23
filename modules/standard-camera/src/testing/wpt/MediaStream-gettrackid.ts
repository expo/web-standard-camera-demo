// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStream-gettrackid.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-gettrackid.https.html

import { wptSource, test, assert_equals, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStream-gettrackid.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
promise_test(async () => {
  await setMediaPermission("granted", ["camera"]);
  const stream = await  navigator.mediaDevices.getUserMedia({video: true});
  var track = stream.getVideoTracks()[0];
  assert_equals(track, stream.getTrackById(track.id), "getTrackById returns track of given id");
  assert_equals(stream.getTrackById(track.id + "foo"), null, "getTrackById of inexistant id  returns null");
}, "Tests that MediaStream.getTrackById works as expected");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStream-gettrackid.https.html — module load failed');
}
