// @ref LLP 0007 — Port of wpt/mediacapture-streams/MediaStream-MediaElement-srcObject.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStream-MediaElement-srcObject.https.html

import {
  assert_equals,
  assert_false,
  assert_true,
  nextEvent,
  promise_test,
} from '../testharness';

// @ref LLP 0004#srcObject — basic assignment
promise_test(async ({ video }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  assert_equals(video.srcObject, stream, 'srcObject reflects assigned MediaStream');
  for (const t of stream.getTracks()) t.stop();
}, 'A MediaStream can be assigned to a video element with srcObject');

// @ref LLP 0004#srcobject-seekable / seeking
promise_test(async ({ video }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  assert_false(video.seeking, 'A MediaStream is not seekable');
  assert_equals(video.seekable.length, 0, 'video.seekable.length === 0');
  for (const t of stream.getTracks()) t.stop();
}, 'A MediaStream assigned to a video element is not seekable');

// @ref LLP 0004#srcobject-readyState
promise_test(async ({ video }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  assert_equals(
    video.readyState,
    video.HAVE_NOTHING,
    'readyState is HAVE_NOTHING before assignment'
  );
  video.srcObject = stream;
  await nextEvent(video, 'loadeddata', 10_000);
  assert_equals(
    video.readyState,
    video.HAVE_ENOUGH_DATA,
    'readyState is HAVE_ENOUGH_DATA after loadeddata'
  );
  for (const t of stream.getTracks()) t.stop();
}, 'readyState transitions to HAVE_ENOUGH_DATA on loadeddata');

// @ref LLP 0004#srcobject-duration
promise_test(async ({ video }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  assert_true(Number.isNaN(video.duration), 'duration is NaN before assignment');
  video.srcObject = stream;
  await nextEvent(video, 'durationchange', 10_000);
  assert_equals(video.duration, Infinity, 'duration is Infinity after durationchange');
  for (const t of stream.getTracks()) t.stop();
}, 'duration transitions NaN → Infinity with durationchange event');

// @ref LLP 0004#srcobject-buffered / preload
promise_test(async ({ video }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  assert_equals(video.buffered.length, 0, 'buffered.length is 0');
  assert_equals(video.preload, 'none', 'preload is "none"');
  for (const t of stream.getTracks()) t.stop();
}, 'A MediaStream cannot be preloaded — preload must always be "none"');

// @ref LLP 0004#srcobject-playbackRate
promise_test(async ({ video }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  assert_equals(video.defaultPlaybackRate, 1, 'defaultPlaybackRate is 1');
  video.playbackRate = 0.5;
  assert_equals(video.playbackRate, 1, 'Setting playbackRate must be ignored');
  for (const t of stream.getTracks()) t.stop();
}, 'playbackRate setter is ignored for MediaStream sources');

// @ref LLP 0004#srcobject-currentTime
promise_test(async ({ video }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await nextEvent(video, 'loadeddata', 10_000);
  const before = video.currentTime;
  // Spec: setter MUST be ignored
  video.currentTime = 42;
  assert_true(video.currentTime < before + 1, 'currentTime did not jump to 42');
  for (const t of stream.getTracks()) t.stop();
}, 'currentTime setter is ignored for MediaStream sources');

// @ref LLP 0004#ended
promise_test(async ({ video }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;
  await nextEvent(video, 'loadeddata', 10_000);
  for (const t of stream.getTracks()) t.stop();
  await nextEvent(video, 'ended', 5_000);
  assert_true(video.ended, 'video.ended is true after all tracks stop');
}, 'video.ended becomes true when its MediaStream provider becomes inactive');
