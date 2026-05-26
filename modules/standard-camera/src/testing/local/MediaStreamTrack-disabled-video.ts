// @ref LLP 0003#track-enabled — A disabled MediaStreamTrack should render
// "as if it were producing solid black frames". Upstream WPT
// (`MediaStreamTrack-MediaElement-disabled-video-is-black`) verifies this by
// rendering the <video> into a <canvas> via `drawImage()` and reading back
// pixels. We can't run that test (canvas/2d frame inspection is out of scope
// per LLP 0001), so this project-local test asserts the equivalent at two
// observable points:
//
//   1. The source end — `__getLatestFrame()`'s `frameNumber` stops
//      advancing while the track is disabled (the input → FrameSink
//      connection is gated by `MediaStreamTrack.swift:36`).
//   2. The renderer end — `__getPreviewEnabledForTesting()` flips to false
//      while the track is disabled (the `CaptureSource.setVideoEnabled`
//      fan-out reaches every subscribed `VideoView`'s preview layer,
//      which is then also hidden so the view's black background shows).
//
// Both assertions are required because the source-side and renderer-side
// AVCaptureConnections are independent: a regression that only fixes
// `videoConnection.isEnabled = false` (the old behaviour) would still
// pass the source assertion while leaving the on-screen `<Video>`
// rendering live pixels.

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
    __getPreviewEnabledForTesting(): boolean | null;
  };
}

function latestFrameNumber(track: MediaStreamTrack): number | null {
  const frame = (track as unknown as VideoBackdoor)._native.__getLatestFrame();
  return frame ? frame.frameNumber : null;
}

function previewEnabled(track: MediaStreamTrack): boolean | null {
  return (track as unknown as VideoBackdoor)._native.__getPreviewEnabledForTesting();
}

// Wait for `__getPreviewEnabledForTesting()` to report the expected value.
// `setPreviewEnabled` dispatches the layer mutation to the main thread so
// the toggle is observable a few main-thread ticks later, not synchronously.
async function waitForPreviewEnabled(track: MediaStreamTrack, expected: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (previewEnabled(track) === expected) return;
    await new Promise<void>((r) => setTimeout(r, 16));
  }
  throw new Error(`preview did not become ${expected ? 'enabled' : 'disabled'} within ${timeoutMs}ms (last value=${previewEnabled(track)})`);
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
  // Attach to the runner's on-screen <Video> so the preview-layer
  // fan-out has a subscriber to flip — without an attached VideoView,
  // `__getPreviewEnabledForTesting()` returns null and the renderer-end
  // assertions can't run.
  const videoEl = (globalThis as unknown as { video: HTMLVideoElement }).video;
  const prevSrcObject = videoEl.srcObject;
  videoEl.srcObject = stream;
  try {
    // Sanity: capture is live — frameNumber must advance while enabled.
    const start = latestFrameNumber(track);
    if (start == null) {
      await waitForFrameAdvance(track, -1, 2000);
    }
    const before = latestFrameNumber(track)!;
    const afterTick = await waitForFrameAdvance(track, before, 2000);
    assert_greater_than(afterTick, before, 'frameNumber advanced while track was enabled');
    await waitForPreviewEnabled(track, true, 2000);

    // Disable: the input → FrameSink connection is gated AND the preview
    // layer is hidden via the setVideoEnabled fan-out.
    track.enabled = false;
    const disabledA = await frameNumberAfter(track, 100);
    const disabledB = await frameNumberAfter(track, 300);
    assert_equals(
      disabledB,
      disabledA,
      `frameNumber stayed flat while disabled (saw ${disabledA} → ${disabledB})`
    );
    await waitForPreviewEnabled(track, false, 2000);

    // Re-enable: counter resumes within a normal frame-arrival window
    // and the preview layer comes back.
    track.enabled = true;
    const resumed = await waitForFrameAdvance(track, disabledB!, 2000);
    assert_greater_than(resumed, disabledB!, 'frameNumber resumed advancing after re-enable');
    await waitForPreviewEnabled(track, true, 2000);
  } finally {
    videoEl.srcObject = prevSrcObject;
    for (const t of stream.getTracks()) t.stop();
  }
}, 'disabled video track stops delivering frames to the source-side sink and hides the preview');

wptRequires(null);
