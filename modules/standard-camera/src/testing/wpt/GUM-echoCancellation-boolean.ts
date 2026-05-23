// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/GUM-echoCancellation-boolean.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-echoCancellation-boolean.https.html

import { wptSource, test, assert_equals, promise_test, setMediaPermission } from '../testharness';

wptSource('GUM-echoCancellation-boolean.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
  // https://w3c.github.io/mediacapture-main/#dfn-echocancellation

  promise_test(async t => {
    await setMediaPermission("granted", ["microphone"]);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {echoCancellation: {exact: true}},
    });
    const track = stream.getAudioTracks()[0];
    t.add_cleanup(() => track.stop());
    const settings = track.getSettings();
    assert_equals(settings.echoCancellation, true);
  }, 'getUserMedia suports true');

  promise_test(async t => {
    await setMediaPermission("granted", ["microphone"]);
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {echoCancellation: {exact: false}},
    });
    const track = stream.getAudioTracks()[0];
    t.add_cleanup(() => track.stop());
    const settings = track.getSettings();
    assert_equals(settings.echoCancellation, false);
  }, 'getUserMedia suports false');
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-echoCancellation-boolean.https.html — module load failed');
}
