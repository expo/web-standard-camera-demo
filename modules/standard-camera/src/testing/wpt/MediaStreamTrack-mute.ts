// @ref LLP 0003#track-events — mute/unmute when AVCaptureSession is interrupted.
// We don't port these from the canonical WPT suite because that suite tests via
// the (Permissions-API-driven) revoke flow which we don't model; instead we drive
// the same DOM-side observation via a synthetic interruption that mirrors what
// iOS does for backgrounding, in-use-by-another-app, and thermal pressure.

import {
  assert_equals,
  assert_false,
  assert_true,
  nextEvent,
  promise_test,
} from '../testharness';

// AVCaptureSession.InterruptionReason raw values
const REASON_VIDEO_DEVICE_NOT_AVAILABLE_IN_BACKGROUND = 1;
const REASON_AUDIO_DEVICE_IN_USE_BY_ANOTHER_CLIENT = 2;
const REASON_VIDEO_DEVICE_IN_USE_BY_ANOTHER_CLIENT = 3;
const REASON_VIDEO_DEVICE_NOT_AVAILABLE_WITH_MULTIPLE_FOREGROUND_APPS = 4;
// 4 used to be system pressure; on iOS it became 4 in the enum.
// Apple changed the numbering in newer SDKs — the value we send is informational
// only; the native side mutes on *any* AVCaptureSession.wasInterrupted notification.
const REASON_VIDEO_DEVICE_NOT_AVAILABLE_DUE_TO_SYSTEM_PRESSURE = 4;

type NativeBackdoor = {
  _native: {
    __simulateInterruptionForTesting(reasonCode: number, ended: boolean): void;
  };
};

function simulate(stream: MediaStream, reasonCode: number, ended: boolean): void {
  (stream as unknown as NativeBackdoor)._native.__simulateInterruptionForTesting(reasonCode, ended);
}

// @ref LLP 0003#track-muted — initially false
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  assert_false(track.muted, 'track is not muted initially');
  for (const t of stream.getTracks()) t.stop();
}, 'MediaStreamTrack.muted is false on a live track');

// @ref LLP 0003#track-events — mute event fires on interruption
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  const mute = nextEvent(track, 'mute', 2000);
  simulate(stream, REASON_VIDEO_DEVICE_NOT_AVAILABLE_DUE_TO_SYSTEM_PRESSURE, false);
  await mute;
  assert_true(track.muted, 'track.muted is true after interruption');
  for (const t of stream.getTracks()) t.stop();
}, 'track fires "mute" event when AVCaptureSession is interrupted (thermal pressure)');

// @ref LLP 0003#track-events — unmute event fires on interruption end
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  const mute = nextEvent(track, 'mute', 2000);
  simulate(stream, REASON_VIDEO_DEVICE_NOT_AVAILABLE_IN_BACKGROUND, false);
  await mute;
  const unmute = nextEvent(track, 'unmute', 2000);
  simulate(stream, 0, true);
  await unmute;
  assert_false(track.muted, 'track.muted is false after interruption ended');
  for (const t of stream.getTracks()) t.stop();
}, 'track fires "unmute" event when AVCaptureSession interruption ends');

// @ref LLP 0003#track-events — a stopped track does not emit mute/unmute
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  track.stop();
  // After stop, the track should not fire mute even if the session is interrupted.
  let fired = false;
  track.addEventListener('mute', () => { fired = true; });
  simulate(stream, REASON_VIDEO_DEVICE_NOT_AVAILABLE_DUE_TO_SYSTEM_PRESSURE, false);
  await new Promise((r) => setTimeout(r, 200));
  assert_false(fired, 'mute did not fire on a stopped track');
}, 'A stopped track does not fire "mute" on subsequent interruptions');

// @ref LLP 0003#track-stop — step 4: stop the underlying capture session
// when no live tracks remain. We can't directly observe AVCaptureSession from JS,
// so we verify the visible consequence: stream.active becomes false.
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  assert_true(stream.active, 'stream is active before stop');
  for (const t of stream.getTracks()) t.stop();
  assert_false(stream.active, 'stream is inactive after all tracks stop');
}, 'stream.active is false after every track is stopped');
