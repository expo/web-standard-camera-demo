// @ts-nocheck
// @ref LLP 0010 — Verbatim port of wpt/mediacapture-streams/MediaStreamTrack-MediaElement-disabled-audio-is-silence.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrack-MediaElement-disabled-audio-is-silence.https.html

import { wptSource, test, assert_equals, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStreamTrack-MediaElement-disabled-audio-is-silence.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
const aud = document.getElementById("aud");
promise_test(async t => {
  await setMediaPermission("granted", ["microphone"]);
  const stream = await navigator.mediaDevices.getUserMedia({audio: true});
  var ctx = new AudioContext();
  var streamSource = ctx.createMediaStreamSource(stream);
  var silenceDetector = ctx.createScriptProcessor(1024);
  var count = 10;
  let resolveAudioProcessPromise;
  const audioProcessed = new Promise(res => resolveAudioProcessPromise = res)

  silenceDetector.onaudioprocess = function (e) {
    var buffer1 = e.inputBuffer.getChannelData(0);
    var buffer2 = e.inputBuffer.getChannelData(1);
    var out = e.outputBuffer.getChannelData(0);
    out = new Float32Array(buffer1);
    for (var i = 0; i < buffer1.length; i++) {
      assert_equals(buffer1[i], 0, "Audio buffer entry #" + i + " in channel 0 is silent");
    }
    for (var i = 0; i < buffer2.length; i++) {
      assert_equals(buffer2[i], 0, "Audio buffer entry #" + i + " in channel 1 is silent");
    }
    count--;
    if (count === 0) {
      silenceDetector.onaudioprocess = null;
      resolveAudioProcessPromise();
    }
  };
  stream.getAudioTracks()[0].enabled = false;

  streamSource.connect(silenceDetector);
  silenceDetector.connect(ctx.destination);
}, "Tests that a disabled audio track in a MediaStream is rendered as silence");
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrack-MediaElement-disabled-audio-is-silence.https.html — module load failed');
}
