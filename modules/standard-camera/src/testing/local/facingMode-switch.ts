// @ref LLP 0002#gum-pick-device — Verifies that `getUserMedia` with
// `facingMode: 'user'` and `facingMode: 'environment'` return tracks backed by
// genuinely different `AVCaptureDevice`s. Upstream WPT does not assert this
// because browsers can't guarantee both cameras exist; on iOS we can (every
// shipping iPhone has both).

import {
  assert_equals,
  assert_not_equals,
  promise_test,
  wptSource,
} from '../testharness';

wptSource(null);

promise_test(async () => {
  const front = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
  const frontTrack = front.getVideoTracks()[0];
  const frontSettings = frontTrack.getSettings();
  assert_equals(frontSettings.facingMode, 'user', 'front camera reports facingMode: user');
  const frontDeviceId = frontSettings.deviceId;
  for (const t of front.getTracks()) t.stop();

  const back = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  const backTrack = back.getVideoTracks()[0];
  const backSettings = backTrack.getSettings();
  assert_equals(backSettings.facingMode, 'environment', 'back camera reports facingMode: environment');
  const backDeviceId = backSettings.deviceId;
  for (const t of back.getTracks()) t.stop();

  assert_not_equals(
    frontDeviceId,
    backDeviceId,
    'front and back cameras have different deviceIds'
  );
}, 'getUserMedia({facingMode: user|environment}) returns tracks from distinct devices');

// `facingMode: {exact: <invalid>}` must reject with OverconstrainedError — the
// JS normalizer collapses `{exact}` and the basic-constraint forms into the
// same flat scalar, so any explicit value that isn't `'user'` / `'environment'`
// / `'left'` / `'right'` is unsatisfiable.
promise_test(async () => {
  try {
    await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: 'invalid' } } });
    throw new Error('getUserMedia should have rejected');
  } catch (e) {
    const err = e as { name?: string; constraint?: string };
    assert_equals(err.name, 'OverconstrainedError', 'rejects with OverconstrainedError');
    assert_equals(err.constraint, 'facingMode', 'constraint name is facingMode');
  }
}, 'getUserMedia({facingMode: {exact: <invalid>}}) rejects with OverconstrainedError');
