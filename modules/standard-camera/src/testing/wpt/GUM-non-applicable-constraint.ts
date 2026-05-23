// @ts-nocheck
// @ref LLP 0007 — Verbatim port of wpt/mediacapture-streams/GUM-non-applicable-constraint.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/GUM-non-applicable-constraint.https.html

import { wptSource, test, assert_equals, promise_test, setMediaPermission } from '../testharness';

wptSource('GUM-non-applicable-constraint.https.html');

try {
// === BEGIN WPT BODY (verbatim) ===
let video_only_valid_constraints = {
  width: {min: 0},
  height: {min: 0},
  frameRate: {min: 0},
  aspectRatio: {min: 0},
  facingMode: {ideal: 'environment'},
  resizeMode: {ideal: 'none'}
}

let video_only_invalid_constraints = {
  width: {min: 100000000},
  height: {min: 100000000},
  frameRate: {min: 100000000},
  aspectRatio: {min: 100000000},
  facingMode: {exact: 'invalid'},
  resizeMode: {exact: 'invalid'}
}

let audio_only_valid_constraints = {
  volume: {min: 0},
  sampleRate: {min: 0},
  sampleSize: {min: 0},
  echoCancellation: {ideal: true},
  autoGainControl: {ideal: true},
  noiseSuppression: {ideal: true},
  voiceIsolation: {ideal: true},
  latency: {min: 0},
  channelCount: {min: 0}
}

let audio_only_invalid_constraints = {
  volume: {min: 2},
  sampleRate: {min: 100000000},
  sampleSize: {min: 100000000},
  echoCancellation: {exact: true},
  autoGainControl: {exact: true},
  noiseSuppression: {exact: true},
  voiceIsolation: {exact: true},
  latency: {max: 0},
  channelCount: {max: 0}
}

promise_test(async () => {
  // Both permissions are needed at some point, asking for both at once
  await setMediaPermission();
  let stream = await navigator.mediaDevices.getUserMedia({audio: video_only_valid_constraints})
  assert_equals(stream.getAudioTracks().length, 1, "the media stream has exactly one audio track");
}, 'Test that setting video-only valid constraints inside of "audio" is simply ignored');

promise_test(async () => {
  let stream = await navigator.mediaDevices.getUserMedia({audio: video_only_invalid_constraints})
  assert_equals(stream.getAudioTracks().length, 1, "the media stream has exactly one audio track");
}, 'Test that setting video-only invalid constraints inside of "audio" is simply ignored');

promise_test(async () => {
  let stream = await navigator.mediaDevices.getUserMedia({video: audio_only_valid_constraints})
  assert_equals(stream.getVideoTracks().length, 1, "the media stream has exactly one video track");
}, 'Test that setting audio-only valid constraints inside of "video" is simply ignored');

promise_test(async () => {
  let stream = await navigator.mediaDevices.getUserMedia({video: audio_only_invalid_constraints})
  assert_equals(stream.getVideoTracks().length, 1, "the media stream has exactly one video track");
}, 'Test that setting audio-only invalid constraints inside of "video" is simply ignored');
// === END WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'GUM-non-applicable-constraint.https.html — module load failed');
}
