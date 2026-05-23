// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/MediaStreamTrackEvent-constructor.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrackEvent-constructor.https.html

import { wptSource, test, assert_equals, assert_throws_js, assert_true } from '../testharness';

wptSource('MediaStreamTrackEvent-constructor.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
test(function() {
  assert_equals(MediaStreamTrackEvent.length, 2);
  assert_throws_js(TypeError, function() {
    new MediaStreamTrackEvent("type");
  });
  assert_throws_js(TypeError, function() {
    new MediaStreamTrackEvent("type", null);
  });
  assert_throws_js(TypeError, function() {
    new MediaStreamTrackEvent("type", undefined);
  });
}, "The eventInitDict argument is required");

test(function() {
  assert_throws_js(TypeError, function() {
    new MediaStreamTrackEvent("type", {});
  });
  assert_throws_js(TypeError, function() {
    new MediaStreamTrackEvent("type", { track: null });
  });
  assert_throws_js(TypeError, function() {
    new MediaStreamTrackEvent("type", { track: undefined });
  });
}, "The eventInitDict's track member is required.");

test(function() {
  // a MediaStreamTrack instance is needed to test, any instance will do.
  var context = new AudioContext();
  var dest = context.createMediaStreamDestination();
  var track = dest.stream.getTracks()[0];
  assert_true(track instanceof MediaStreamTrack);
  var event = new MediaStreamTrackEvent("type", { track: track });
  assert_equals(event.type, "type");
  assert_equals(event.track, track);
}, "The MediaStreamTrackEvent instance's track attribute is set.");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrackEvent-constructor.https.html — module load failed');
}
