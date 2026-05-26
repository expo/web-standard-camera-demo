// @ts-nocheck
// @ref LLP 0007 — Adapted from wpt/mediacapture-streams/MediaStreamTrack-getCapabilities.https.html
// Original: https://github.com/web-platform-tests/wpt/blob/master/mediacapture-streams/MediaStreamTrack-getCapabilities.https.html
//
// This file DEVIATES from the verbatim-port convention: upstream registers
// each per-property sub-test from inside its parent test's body (after the
// device's capabilities are read at runtime). Our runner now forbids
// mid-run registration (see LLP 0007#static-test-registration), so we flatten
// the pattern: a single "setup" test per category opens the stream and
// snapshots capabilities into module-scope state, and the per-property
// sub-tests are pre-registered at module load and consume that snapshot.

import { wptSource, wptRequires, test, assert_equals, assert_in_array, assert_inherits, assert_less_than_equal, assert_true, promise_test, setMediaPermission } from '../testharness';

wptSource('MediaStreamTrack-getCapabilities.https.html');

try {
// === BEGIN ADAPTED WPT BODY ===
const audioProperties = [
  { name: 'sampleRate', type: 'number' },
  { name: 'sampleSize', type: 'number' },
  { name: 'echoCancellation', type: 'boolean or string', validValues: [true, false, 'all', 'remote-only'] },
  { name: 'autoGainControl', type: 'boolean' },
  { name: 'noiseSuppression', type: 'boolean' },
  { name: 'voiceIsolation', type: 'boolean' },
  { name: 'latency', type: 'number' },
  { name: 'channelCount', type: 'number' },
  { name: 'deviceId', type: 'string' },
  { name: 'groupId', type: 'string' },
];

const videoProperties = [
  { name: 'width', type: 'number' },
  { name: 'height', type: 'number' },
  { name: 'aspectRatio', type: 'number' },
  { name: 'frameRate', type: 'number' },
  { name: 'facingMode', type: 'enum-any', validValues: ['user', 'environment', 'left', 'right'] },
  { name: 'resizeMode', type: 'enum-all', validValues: ['none', 'crop-and-scale'] },
  { name: 'deviceId', type: 'string' },
  { name: 'groupId', type: 'string' },
];

// Per-category capability snapshots. Each setup test resets and populates its
// slot at the start of every run; the per-property sub-tests read the slot.
// If the setup fails (e.g., the device kind isn't available), the recorded
// error is thrown by every dependent sub-test so they all show the same
// concrete cause rather than "snapshot undefined".
const snapshots = {
  audioTrack: { caps: null, error: null },
  videoTrack: { caps: null, error: null },
  audioDevice: { caps: null, error: null },
  videoDevice: { caps: null, error: null },
};

function makeSetup(key, label, requirement, fetch) {
  // Apply the per-source requirement override only to the audio setups so the
  // pre-registered audio sub-tests are correctly classified as `microphone`
  // by the runner's environment gate (otherwise they inherit `camera` from
  // the source default and would run on a camera-only device, then fail).
  if (requirement) wptRequires(requirement);
  promise_test(async () => {
    snapshots[key].caps = null;
    snapshots[key].error = null;
    try {
      snapshots[key].caps = await fetch();
    } catch (e) {
      snapshots[key].error = e;
      throw e;
    }
  }, `Setup ${label}`);
  if (requirement) wptRequires(null);
}

function readSnapshot(key) {
  const s = snapshots[key];
  if (s.error) throw s.error;
  if (!s.caps) {
    throw new Error('snapshot not populated — the setup test must run first');
  }
  return s.caps;
}

function verifyBooleanCapability(capability) {
  assert_less_than_equal(capability.length, 2);
  capability.forEach((c) => assert_equals(typeof c, 'boolean'));
}

function verifyNumberCapability(capability) {
  assert_equals(typeof capability, 'object');
  assert_equals(Object.keys(capability).length, 2);
  assert_true(capability.hasOwnProperty('min'));
  assert_true(capability.hasOwnProperty('max'));
  assert_less_than_equal(capability.min, capability.max);
}

function verifyEnumAnyCapability(capability, enumMembers) {
  capability.forEach((c) => {
    assert_equals(typeof c, 'string');
    assert_in_array(c, enumMembers);
  });
}

function verifyBooleanOrStringCapability(capability, validMembers) {
  capability.forEach((c) => {
    assert_true(typeof c === 'boolean' || typeof c === 'string');
    assert_in_array(c, validMembers);
  });
}

function registerPropertyTests(snapshotKey, properties, prefix, requirement) {
  // Same per-source requirement trick as in makeSetup: scope the override to
  // just this registration block so audio sub-tests get `microphone` and
  // video sub-tests get the source default (`camera`).
  if (requirement) wptRequires(requirement);
  for (const property of properties) {
    const baseName = `${prefix} ${property.name}`;
    promise_test(async () => {
      const caps = readSnapshot(snapshotKey);
      assert_true(caps.hasOwnProperty(property.name));
    }, `${baseName} property present.`);

    const supportedName = `${baseName} properly supported.`;
    promise_test(async () => {
      const caps = readSnapshot(snapshotKey);
      const capability = caps[property.name];
      switch (property.type) {
        case 'string':
          assert_equals(typeof capability, 'string');
          break;
        case 'boolean':
          verifyBooleanCapability(capability);
          break;
        case 'boolean or string':
          verifyBooleanOrStringCapability(capability, property.validValues);
          break;
        case 'number':
          verifyNumberCapability(capability);
          break;
        case 'enum-any':
        case 'enum-all':
          verifyEnumAnyCapability(capability, property.validValues);
          break;
      }
    }, supportedName);

    if (property.type === 'enum-all') {
      for (const member of property.validValues) {
        promise_test(async () => {
          const caps = readSnapshot(snapshotKey);
          assert_in_array(member, caps[property.name]);
        }, `${supportedName} Value: ${member}`);
      }
    }
  }
  if (requirement) wptRequires(null);
}

makeSetup('audioTrack', 'audio MediaStreamTrack getCapabilities', 'microphone', async () => {
  await setMediaPermission('granted', ['microphone']);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const caps = stream.getAudioTracks()[0].getCapabilities();
  for (const t of stream.getTracks()) t.stop();
  return caps;
});

makeSetup('videoTrack', 'video MediaStreamTrack getCapabilities', 'camera', async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const caps = stream.getVideoTracks()[0].getCapabilities();
  for (const t of stream.getTracks()) t.stop();
  return caps;
});

makeSetup('audioDevice', 'audio InputDeviceInfo getCapabilities', 'microphone', async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const device of devices) {
    if (device.kind === 'audioinput') {
      assert_inherits(device, 'getCapabilities');
      return device.getCapabilities();
    }
  }
  throw new Error('NotFoundError: no audioinput device in enumerateDevices()');
});

makeSetup('videoDevice', 'video InputDeviceInfo getCapabilities', 'camera', async () => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const device of devices) {
    if (device.kind === 'videoinput') {
      assert_inherits(device, 'getCapabilities');
      return device.getCapabilities();
    }
  }
  throw new Error('NotFoundError: no videoinput device in enumerateDevices()');
});

registerPropertyTests('audioTrack', audioProperties, 'Audio track getCapabilities()', 'microphone');
registerPropertyTests('videoTrack', videoProperties, 'Video track getCapabilities()', 'camera');
registerPropertyTests('audioDevice', audioProperties, 'Audio device getCapabilities()', 'microphone');
registerPropertyTests('videoDevice', videoProperties, 'Video device getCapabilities()', 'camera');
// === END ADAPTED WPT BODY ===
} catch (__wptModuleLoadError) {
  test(() => { throw __wptModuleLoadError; }, 'MediaStreamTrack-getCapabilities.https.html — module load failed');
}
