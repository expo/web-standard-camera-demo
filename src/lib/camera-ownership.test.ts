import { expect, test } from 'bun:test';

import { createCameraOwnershipGate } from './camera-ownership';

test('camera ownership gate blocks stale start closures after WebXR locks the camera', () => {
  const gate = createCameraOwnershipGate();
  const staleStartClosure = () => gate.startBlockReason({
    explicitConstraints: false,
    hasStream: false,
  });

  expect(staleStartClosure()).toBeNull();

  gate.lockExternal();

  expect(staleStartClosure()).toBe('external-lock');

  gate.unlockExternal();

  expect(staleStartClosure()).toBeNull();
});

test('camera ownership gate coalesces only duplicate default starts', () => {
  const gate = createCameraOwnershipGate();

  gate.setStartInFlight(true);

  expect(gate.startBlockReason({
    explicitConstraints: false,
    hasStream: false,
  })).toBe('duplicate-default-start');
  expect(gate.startBlockReason({
    explicitConstraints: true,
    hasStream: false,
  })).toBeNull();
  expect(gate.startBlockReason({
    explicitConstraints: false,
    hasStream: true,
  })).toBeNull();
});
