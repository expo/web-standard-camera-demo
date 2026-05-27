export type CameraStartBlockReason = 'duplicate-default-start' | 'external-lock';

export interface CameraStartGateInput {
  explicitConstraints: boolean;
  hasStream: boolean;
}

export interface CameraOwnershipGate {
  isExternalLocked(): boolean;
  lockExternal(): void;
  setStartInFlight(inFlight: boolean): void;
  startBlockReason(input: CameraStartGateInput): CameraStartBlockReason | null;
  unlockExternal(): void;
}

export function createCameraOwnershipGate(): CameraOwnershipGate {
  let externalLocked = false;
  let startInFlight = false;

  return {
    isExternalLocked: () => externalLocked,
    lockExternal: () => {
      externalLocked = true;
      startInFlight = false;
    },
    setStartInFlight: (inFlight) => {
      startInFlight = inFlight;
    },
    startBlockReason: ({ explicitConstraints, hasStream }) => {
      if (externalLocked) return 'external-lock';
      if (startInFlight && !explicitConstraints && !hasStream) {
        return 'duplicate-default-start';
      }
      return null;
    },
    unlockExternal: () => {
      externalLocked = false;
    },
  };
}
