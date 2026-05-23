// @ref LLP 0002#mediadevices-enumeratedevices — Verifies that
// `enumerateDevices()` returns every built-in camera on the device, not just
// the system default. On a modern iPhone this is at least one front and one
// rear camera; on a Pro / Pro Max it is typically four or more (front
// TrueDepth + rear wide + ultra-wide + telephoto + the virtual auto-switching
// triple/dual-wide cameras).
//
// Upstream WPT can't assert this because the corpus runs on hardware that
// varies wildly (some browsers report zero devices in CI). Our pipeline only
// runs on iOS, which lets us require at least two `videoinput` entries with
// distinct `deviceId`s.

import { assert_equals, assert_greater_than_equal, assert_not_equals, assert_true, promise_test, wptSource } from '../testharness';

wptSource(null);

promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');
    assert_greater_than_equal(
      videoInputs.length,
      2,
      'enumerateDevices() reports both front and rear cameras'
    );

    // Every entry has a non-empty deviceId/label/groupId after the grant.
    const seen = new Set<string>();
    for (const d of videoInputs) {
      assert_not_equals(d.deviceId, '', 'deviceId is non-empty after grant');
      assert_not_equals(d.label, '', 'label is non-empty after grant');
      assert_not_equals(d.groupId, '', 'groupId is non-empty after grant');
      seen.add(d.deviceId);
    }
    assert_equals(
      seen.size,
      videoInputs.length,
      'every videoinput has a distinct deviceId'
    );
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}, 'enumerateDevices() reports each built-in camera as a distinct videoinput');

// Every videoinput must expose a `getCapabilities()` of the InputDeviceInfo
// subclass — the spec defines `InputDeviceInfo extends MediaDeviceInfo` for
// input devices specifically (vs. `MediaDeviceInfo` for audiooutput devices).
promise_test(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');
    for (const d of videoInputs) {
      const caps = (d as { getCapabilities?: () => Record<string, unknown> }).getCapabilities?.();
      assert_true(caps != null, 'videoinput has getCapabilities()');
      assert_true(
        Array.isArray((caps as { facingMode?: unknown }).facingMode),
        'capabilities.facingMode is an array'
      );
    }
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}, 'enumerateDevices() videoinputs are InputDeviceInfo with capabilities');
