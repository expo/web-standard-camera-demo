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

test('camera ownership gate ignores stale terminal LiDAR events while a new WebXR lock is pending', () => {
  const gate = createCameraOwnershipGate();

  gate.lockExternal();

  expect(gate.handleExternalSessionEvent({
    sessionId: 1,
    state: 'stopped',
  })).toMatchObject({
    accepted: false,
    reason: 'terminal-before-session',
    releaseLock: false,
  });
  expect(gate.isExternalLocked()).toBe(true);
  expect(gate.activeExternalSessionId()).toBeNull();

  expect(gate.handleExternalSessionEvent({
    sessionId: 2,
    state: 'starting',
  })).toEqual({
    accepted: true,
    releaseLock: false,
  });
  expect(gate.activeExternalSessionId()).toBe(2);

  expect(gate.handleExternalSessionEvent({
    sessionId: 1,
    state: 'stopped',
  })).toMatchObject({
    accepted: false,
    reason: 'stale-session',
    releaseLock: false,
  });
  expect(gate.isExternalLocked()).toBe(true);
  expect(gate.activeExternalSessionId()).toBe(2);

  expect(gate.handleExternalSessionEvent({
    sessionId: 2,
    state: 'stopped',
  })).toEqual({
    accepted: true,
    releaseLock: true,
  });
});
