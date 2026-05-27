export type CameraStartBlockReason = 'duplicate-default-start' | 'external-lock';
export type ExternalCameraSessionState =
  | 'failed'
  | 'idle'
  | 'interrupted'
  | 'running'
  | 'starting'
  | 'stopped';

export interface CameraStartGateInput {
  explicitConstraints: boolean;
  hasStream: boolean;
}

export interface ExternalCameraSessionEvent {
  sessionId?: number | null;
  state: ExternalCameraSessionState;
}

export interface ExternalCameraSessionDecision {
  accepted: boolean;
  releaseLock: boolean;
  reason?: 'stale-session' | 'terminal-before-session';
}

export interface CameraOwnershipGate {
  activeExternalSessionId(): number | null;
  handleExternalSessionEvent(event: ExternalCameraSessionEvent): ExternalCameraSessionDecision;
  isExternalLocked(): boolean;
  lockExternal(): void;
  setStartInFlight(inFlight: boolean): void;
  startBlockReason(input: CameraStartGateInput): CameraStartBlockReason | null;
  unlockExternal(): void;
}

export function createCameraOwnershipGate(): CameraOwnershipGate {
  let activeExternalSessionId: number | null = null;
  let externalLocked = false;
  let startInFlight = false;

  return {
    activeExternalSessionId: () => activeExternalSessionId,
    handleExternalSessionEvent: ({ sessionId, state }) => {
      const eventSessionId = typeof sessionId === 'number' && Number.isFinite(sessionId)
        ? sessionId
        : null;
      const terminal = state === 'failed' || state === 'stopped';
      if (
        activeExternalSessionId !== null &&
        eventSessionId !== null &&
        eventSessionId !== activeExternalSessionId
      ) {
        return { accepted: false, releaseLock: false, reason: 'stale-session' };
      }
      if (terminal && externalLocked && activeExternalSessionId === null) {
        return { accepted: false, releaseLock: false, reason: 'terminal-before-session' };
      }
      if (
        eventSessionId !== null &&
        (state === 'starting' || state === 'running' || state === 'interrupted')
      ) {
        activeExternalSessionId = eventSessionId;
      }
      if (terminal) {
        activeExternalSessionId = null;
        return { accepted: true, releaseLock: true };
      }
      return { accepted: true, releaseLock: false };
    },
    isExternalLocked: () => externalLocked,
    lockExternal: () => {
      externalLocked = true;
      startInFlight = false;
      activeExternalSessionId = null;
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
      activeExternalSessionId = null;
    },
  };
}
