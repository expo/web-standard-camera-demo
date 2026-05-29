// @ref LLP 0010 — Port of MediaStream constructor / addTrack / removeTrack /
// getTrackById invariants. Combines what upstream WPT splits across
// MediaStream-gettrackid.https.html, MediaStream-finished-add.https.html,
// MediaStream-removetrack.https.html, plus IDL-driven constructor cases that
// don't have their own canonical test file but are exercised throughout the
// suite.
//
// All cases here are video-only since v1 has no audio support.

import {
  assert_equals,
  assert_false,
  assert_not_equals,
  assert_throws_dom,
  assert_true,
  assert_unreached,
  promise_test,
  test,
  wptSource,
} from '../testharness';

wptSource(null);

// @ref LLP 0001#mediastream-constructor — 0-arg, sequence, and copy forms
test(() => {
  const empty = new MediaStream();
  assert_equals(empty.getTracks().length, 0, 'new MediaStream() has zero tracks');
  assert_false(empty.active, 'new MediaStream() is inactive (no live tracks)');
}, 'new MediaStream() returns an inactive stream with no tracks');

test(() => {
  const a = new MediaStream();
  const b = new MediaStream();
  assert_not_equals(a.id, b.id, 'distinct streams have distinct ids');
}, 'Distinct MediaStream constructions yield distinct ids');

// @ref LLP 0001#mediastream-constructor — copy constructor: tracks are shared,
// not cloned (compare with new MediaStream(stream.clone()) for true cloning).
promise_test(async () => {
  const original = await navigator.mediaDevices.getUserMedia({ video: true });
  const copy = new MediaStream(original);
  assert_not_equals(copy.id, original.id, 'copy has a fresh id');
  assert_equals(copy.getTracks().length, original.getTracks().length, 'same track count');
  // Per spec, the copy constructor adds the *same* track references; it does
  // not clone them.
  assert_equals(copy.getTracks()[0], original.getTracks()[0], 'track is shared, not cloned');
  for (const t of original.getTracks()) t.stop();
}, 'new MediaStream(stream) shares tracks with the source stream');

// @ref LLP 0001#mediastream-constructor — sequence form
promise_test(async () => {
  const src = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = src.getVideoTracks()[0];
  const stream = new MediaStream([track]);
  assert_equals(stream.getTracks().length, 1, 'sequence form takes the given tracks');
  assert_equals(stream.getVideoTracks()[0], track, 'same track reference');
  for (const t of src.getTracks()) t.stop();
}, 'new MediaStream(tracks) builds a stream from a sequence');

// @ref LLP 0001#mediastream-constructor — duplicate entries in the sequence are deduped
promise_test(async () => {
  const src = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = src.getVideoTracks()[0];
  const stream = new MediaStream([track, track]);
  assert_equals(stream.getTracks().length, 1, 'duplicate tracks in the sequence are deduped');
  for (const t of src.getTracks()) t.stop();
}, 'new MediaStream(tracks) dedupes a repeated MediaStreamTrack');

// @ref LLP 0001#mediastream-constructor — sequence with a non-track throws TypeError
test(() => {
  assert_throws_dom(
    'TypeError',
    () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new MediaStream([42 as any]);
    },
    'invalid sequence content throws TypeError'
  );
}, 'new MediaStream([non-track]) throws TypeError');

// @ref LLP 0004#stream-getTrackById — getTrackById returns the matching track or null
// Port of MediaStream-gettrackid.https.html
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const track = stream.getVideoTracks()[0];
  assert_equals(stream.getTrackById(track.id), track, 'getTrackById returns track of given id');
  assert_equals(stream.getTrackById(track.id + 'foo'), null, 'getTrackById of nonexistent id returns null');
  for (const t of stream.getTracks()) t.stop();
}, 'MediaStream.getTrackById returns the track or null');

// @ref LLP 0004#stream-addtrack — addTrack on a previously inactive stream
// Port of MediaStream-finished-add.https.html (adapted to video-only)
promise_test(async () => {
  // We get two video streams. Stop one, then move the other's track into it.
  const a = await navigator.mediaDevices.getUserMedia({ video: true });
  const b = await navigator.mediaDevices.getUserMedia({ video: true });
  const aTrack = a.getVideoTracks()[0];
  aTrack.stop();
  assert_false(a.active, 'a is inactive after stopping its only video track');
  assert_true(b.active, 'b is active');

  const bTrack = b.getVideoTracks()[0];
  a.addTrack(bTrack);
  assert_true(a.active, 'a becomes active after addTrack of a live track');
  a.removeTrack(aTrack);
  assert_equals(a.getTracks().length, 1, 'after addTrack and removeTrack, a has one track');
  assert_equals(a.getTracks()[0], bTrack, 'the remaining track is b\'s track');

  bTrack.stop();
}, 'Adding a track to an inactive MediaStream is allowed');

// @ref LLP 0004#stream-removetrack — script-initiated removeTrack does not fire onremovetrack
// Port of MediaStream-removetrack.https.html (adapted to video-only)
promise_test(async () => {
  const a = await navigator.mediaDevices.getUserMedia({ video: true });
  const b = await navigator.mediaDevices.getUserMedia({ video: true });
  const tracks = [a.getVideoTracks()[0], b.getVideoTracks()[0]];
  const stream = new MediaStream(tracks);

  stream.onremovetrack = () => assert_unreached('onremovetrack is not triggered by script itself');

  assert_equals(stream.getTracks().length, 2, 'mediastream starts with 2 tracks');
  stream.removeTrack(stream.getVideoTracks()[0]);
  assert_equals(stream.getTracks().length, 1, 'mediastream has 1 track left');
  stream.removeTrack(stream.getVideoTracks()[0]);
  assert_equals(stream.getTracks().length, 0, 'mediastream has no tracks left');
  // Removing a track that isn't in the set should not throw, per spec.
  stream.removeTrack(tracks[0]);

  // Allow time to verify no events fire.
  await new Promise((r) => setTimeout(r, 50));

  for (const t of tracks) t.stop();
}, 'MediaStream.removeTrack works and does not fire onremovetrack');

// @ref LLP 0004#stream-addtrack — script-initiated addTrack does not fire onaddtrack
promise_test(async () => {
  const src = await navigator.mediaDevices.getUserMedia({ video: true });
  const stream = new MediaStream();
  stream.onaddtrack = () => assert_unreached('onaddtrack is not triggered by script itself');
  stream.addTrack(src.getVideoTracks()[0]);
  await new Promise((r) => setTimeout(r, 50));
  assert_equals(stream.getTracks().length, 1, 'one track was added');
  for (const t of src.getTracks()) t.stop();
}, 'MediaStream.addTrack works and does not fire onaddtrack');
