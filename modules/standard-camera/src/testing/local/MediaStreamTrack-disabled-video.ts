// @ref LLP 0003#track-enabled — A disabled MediaStreamTrack should render
// "as if it were producing solid black frames". Upstream WPT
// (`MediaStreamTrack-MediaElement-disabled-video-is-black`) verifies this by
// rendering the <video> into a <canvas> via `drawImage()` and reading back
// pixels. We can't run that test (canvas/2d frame inspection is out of scope
// per LLP 0001), so this project-local test asserts the equivalent
// observation at the *source* end: while the track is disabled, the
// AVCaptureConnection between the device input and `FrameSink` is gated off
// (see `MediaStreamTrack.swift:36`), so `__getLatestFrame()`'s `frameNumber`
// stops advancing. Re-enabling re-opens the connection and the counter
// resumes.
//
// Known gap: `VideoView` uses an `AVCaptureVideoPreviewLayer` whose own
// connection is *not* gated by `track.enabled` (see VideoView.swift:81-82,
// 124). That means a `<Video srcObject={stream}>` still shows live pixels
// while `track.enabled = false` — non-spec-compliant for the rendering case.
// Fixing that requires a VideoView change (drop the preview layer in favour
// of rendering the FrameSink output, or gate the preview connection on
// track.enabled). This test deliberately stays at the source end so it
// passes today and the rendering fix can be a focused follow-up.

import {
  assert_equals,
  assert_greater_than,
  promise_test,
  wptSource,
  wptRequires,
} from '../testharness';

wptSource(null);
wptRequires('camera');

interface VideoBackdoor {
  _native: {
    __getLatestFrame(): { width: number; height: number; data: Uint8Array; frameNumber: number } | null;
  };
}

function latestFrameNumber(track: MediaStreamTrack): number | null {
  const frame = (track as unknown as VideoBackdoor)._native.__getLatestFrame();
  return frame ? frame.frameNumber : null;
}

// Wait until `__getLatestFrame()` reports a frameNumber distinct from
// `previous`, polling every 16ms. Bounds the wait so a stalled capture
// session fails the test rather than hanging the suite.
async function waitForFrameAdvance(track: MediaStreamTrack, previous: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = latestFrameNumber(track);
    if (n != null && n !== previous) return n;
    await new Promise<void>((r) => setTimeout(r, 16));
  }
  throw new Error(`frameNumber did not advance from ${previous} within ${timeoutMs}ms`);
}

// Wait the given duration, then return the current frameNumber. Used after
// disabling to give the in-flight sample buffer time to drain.
async function frameNumberAfter(track: MediaStreamTrack, ms: number): Promise<number | null> {
  await new Promise<void>((r) => setTimeout(r, ms));
  return latestFrameNumber(track);
}

promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  try {
    // Sanity: capture is live — frameNumber must advance while enabled.
    const start = latestFrameNumber(track);
    if (start == null) {
      // First frame hasn't landed yet — wait for one before measuring.
      await waitForFrameAdvance(track, -1, 2000);
    }
    const before = latestFrameNumber(track)!;
    const afterTick = await waitForFrameAdvance(track, before, 2000);
    assert_greater_than(afterTick, before, 'frameNumber advanced while track was enabled');

    // Disable: the input → FrameSink connection is gated. Let any in-flight
    // sample buffer drain (~one frame at 30fps = 33ms), then snapshot.
    track.enabled = false;
    const disabledA = await frameNumberAfter(track, 100);
    const disabledB = await frameNumberAfter(track, 200);
    assert_equals(
      disabledB,
      disabledA,
      `frameNumber stayed flat while disabled (saw ${disabledA} → ${disabledB})`
    );

    // Re-enable: counter resumes within a normal frame-arrival window.
    track.enabled = true;
    const resumed = await waitForFrameAdvance(track, disabledB!, 2000);
    assert_greater_than(resumed, disabledB!, 'frameNumber resumed advancing after re-enable');
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}, 'disabled video track stops delivering frames to the source-side sink');

wptRequires(null);
