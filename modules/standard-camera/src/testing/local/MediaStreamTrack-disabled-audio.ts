// @ref LLP 0003#track-enabled — A disabled MediaStreamTrack should render
// audio "as if it were producing silence". Upstream WPT
// (`MediaStreamTrack-MediaElement-disabled-audio-is-silence`) verifies this
// by attaching the stream to a media element, wiring an AudioContext
// analyser, and asserting the analyser's frame is silent. We can't run that
// test (Web Audio is out of scope per LLP 0001), so this project-local test
// asserts the equivalent observation at the *sink* end: while the track is
// disabled, the AVCaptureConnection between the device input and `AudioSink`
// is gated off (see `MediaStreamTrack.swift:36-37`), so
// `__getLatestAudioBuffer()`'s `frameNumber` stops advancing. Re-enabling
// re-opens the connection and the counter resumes.
//
// Symmetric with `MediaStreamTrack-disabled-video.ts` — see that file for
// the same spec-divergence note (our impl stops delivery; the spec phrasing
// asks for substitute silence). The disabled-audio rendering case is moot
// because the project has no audio renderer in v1.

import {
  assert_equals,
  assert_greater_than,
  promise_test,
  wptSource,
  wptRequires,
} from '../testharness';

wptSource(null);
wptRequires('microphone');

interface AudioBackdoor {
  _native: {
    __getLatestAudioBuffer(maxFrames: number): {
      samples: Uint8Array;
      sampleRate: number;
      channelCount: number;
      frameNumber: number;
    } | null;
  };
}

// One frame at 48 kHz = ~21 µs; 4800 is ~100 ms of audio, plenty for a
// "is anything arriving" probe without forcing the sink to oversize its ring.
const PROBE_FRAMES = 4800;

class AudioSamplesUnavailableError extends Error {
  name = 'NotFoundError';
}

function latestAudioFrameNumber(track: MediaStreamTrack): number | null {
  const buf = (track as unknown as AudioBackdoor)._native.__getLatestAudioBuffer(PROBE_FRAMES);
  return buf ? buf.frameNumber : null;
}

async function waitForAudioFrameAdvance(track: MediaStreamTrack, previous: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = latestAudioFrameNumber(track);
    if (n != null && n !== previous) return n;
    await new Promise<void>((r) => setTimeout(r, 16));
  }
  throw new Error(`audio frameNumber did not advance from ${previous} within ${timeoutMs}ms`);
}

async function audioFrameNumberAfter(track: MediaStreamTrack, ms: number): Promise<number | null> {
  await new Promise<void>((r) => setTimeout(r, ms));
  return latestAudioFrameNumber(track);
}

promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0];
  try {
    // Sanity: capture is live — frameNumber advances while enabled. AVCapture
    // delivers audio in ~10–20 ms chunks, so a 2 s budget is generous.
    const start = latestAudioFrameNumber(track);
    if (start == null) {
      try {
        await waitForAudioFrameAdvance(track, -1, 2000);
      } catch {
        throw new AudioSamplesUnavailableError('no audio samples delivered by this simulator audio route');
      }
    }
    const before = latestAudioFrameNumber(track)!;
    let afterTick: number;
    try {
      afterTick = await waitForAudioFrameAdvance(track, before, 2000);
    } catch {
      throw new AudioSamplesUnavailableError('no audio samples delivered by this simulator audio route');
    }
    assert_greater_than(afterTick, before, 'audio frameNumber advanced while enabled');

    // Disable: the input → AudioSink connection is gated. Let any in-flight
    // chunk drain, then assert the counter stayed put across a comparison
    // window of ~200 ms (which is many audio chunks at 48 kHz).
    track.enabled = false;
    const disabledA = await audioFrameNumberAfter(track, 100);
    const disabledB = await audioFrameNumberAfter(track, 200);
    assert_equals(
      disabledB,
      disabledA,
      `audio frameNumber stayed flat while disabled (saw ${disabledA} → ${disabledB})`
    );

    // Re-enable: counter resumes within a normal chunk-arrival window.
    track.enabled = true;
    const resumed = await waitForAudioFrameAdvance(track, disabledB!, 2000);
    assert_greater_than(resumed, disabledB!, 'audio frameNumber resumed advancing after re-enable');
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}, 'disabled audio track stops delivering samples to the source-side sink');

wptRequires(null);
