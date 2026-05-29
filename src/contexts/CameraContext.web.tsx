import * as React from 'react';

import { cameraConstraintsEqual, mergeCameraConstraints } from '@/lib/camera-constraints';
import {
  DEFAULT_FACING_AVAILABILITY,
  type CameraFacingAvailability,
  type CameraFacingModeAvailability,
} from '@/lib/camera-facing';

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'starting'
  | 'playing'
  | 'stopping'
  | 'ended'
  | 'error';

export type CameraHardwareOwner = 'standard' | 'lidar' | null;
export type CameraHardwarePhase = 'stopped' | 'starting' | 'started' | 'stopping';
export type LiDARCameraStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'interrupted'
  | 'stopping'
  | 'stopped'
  | 'unsupported'
  | 'error';

export interface CameraHardwareState {
  owner: CameraHardwareOwner;
  phase: CameraHardwarePhase;
}

export interface CameraConstraints {
  deviceId?: string;
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface CameraContextValue {
  stream: MediaStream | null;
  status: CameraStatus;
  hardware: CameraHardwareState;
  error: string | null;
  constraints: CameraConstraints;
  settings: MediaTrackSettings | null;
  devices: MediaDeviceInfo[];
  facingModeAvailability: CameraFacingAvailability;
  userStopped: boolean;
  externalLocked: boolean;
  lidarStatus: LiDARCameraStatus;
  lidarError: string | null;
  start: (next?: CameraConstraints) => Promise<void>;
  stop: () => void;
  lockExternal: () => Promise<void>;
  unlockExternal: () => void;
  applyConstraints: (patch: Partial<CameraConstraints>) => void;
}

const DEFAULT_CONSTRAINTS: CameraConstraints = { facingMode: 'user' };
const CameraContext = React.createContext<CameraContextValue | null>(null);

function isNoEnvironmentCameraError(error: unknown): boolean {
  const err = error as { name?: string; constraint?: string } | undefined;
  return (
    err?.name === 'OverconstrainedError' ||
    err?.name === 'NotFoundError' ||
    err?.constraint === 'facingMode'
  );
}

export function CameraProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [status, setStatus] = React.useState<CameraStatus>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [constraints, setConstraints] = React.useState<CameraConstraints>(DEFAULT_CONSTRAINTS);
  const [settings, setSettings] = React.useState<MediaTrackSettings | null>(null);
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [environmentFacingAvailability, setEnvironmentFacingAvailability] =
    React.useState<CameraFacingModeAvailability>('unknown');
  const [userStopped, setUserStopped] = React.useState(false);
  const streamRef = React.useRef<MediaStream | null>(null);
  const requestIdRef = React.useRef(0);

  const stop = React.useCallback((): void => {
    requestIdRef.current += 1;
    const live = streamRef.current;
    streamRef.current = null;
    if (live) {
      for (const track of live.getTracks()) track.stop();
    }
    setStream(null);
    setSettings(null);
    setUserStopped(true);
    setStatus('idle');
  }, []);

  const refreshDevices = React.useCallback(async (): Promise<void> => {
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    const all = await mediaDevices.enumerateDevices();
    setDevices(all.filter((device) => device.kind === 'videoinput'));
  }, []);

  const probeEnvironmentFacingMode = React.useCallback(
    async (mediaDevices: MediaDevices, requestId: number): Promise<void> => {
      if (environmentFacingAvailability !== 'unknown') return;
      // @ref LLP 0009#decision — Once a camera grant exists, exact
      // `environment` is the browser-backed probe for whether a Back camera is
      // actually available. Stop the probe stream immediately so the visible
      // app stream keeps owning the UI.
      try {
        const probe = await mediaDevices.getUserMedia({
          video: { facingMode: { exact: 'environment' } },
        });
        for (const track of probe.getTracks()) track.stop();
        if (requestId === requestIdRef.current) {
          setEnvironmentFacingAvailability('available');
        }
      } catch (e) {
        if (requestId !== requestIdRef.current) return;
        setEnvironmentFacingAvailability(isNoEnvironmentCameraError(e) ? 'unavailable' : 'unknown');
      }
    },
    [environmentFacingAvailability]
  );

  const start = React.useCallback(
    async (next?: CameraConstraints): Promise<void> => {
      const mediaDevices = globalThis.navigator?.mediaDevices;
      if (!mediaDevices?.getUserMedia) {
        setError('NotSupportedError: navigator.mediaDevices.getUserMedia is unavailable');
        setStatus('error');
        return;
      }

      const effective = next ?? constraints;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const previous = streamRef.current;
      if (previous) {
        for (const track of previous.getTracks()) track.stop();
      }

      const video: MediaTrackConstraints = {};
      if (effective.deviceId) {
        video.deviceId = { exact: effective.deviceId };
      } else if (effective.facingMode) {
        video.facingMode = effective.facingMode;
      }
      if (effective.width && effective.height) {
        video.width = { exact: effective.width };
        video.height = { exact: effective.height };
      }
      if (effective.frameRate) {
        video.frameRate = { ideal: effective.frameRate };
      }

      setError(null);
      setStatus('requesting');
      setUserStopped(false);
      try {
        const nextStream = await mediaDevices.getUserMedia({ video });
        if (requestId !== requestIdRef.current) {
          for (const track of nextStream.getTracks()) track.stop();
          return;
        }
        streamRef.current = nextStream;
        setStream(nextStream);
        const nextSettings = nextStream.getVideoTracks()[0]?.getSettings() ?? null;
        setSettings(nextSettings);
        if (nextSettings?.facingMode === 'environment') {
          setEnvironmentFacingAvailability('available');
        }
        if (!effective.deviceId && effective.facingMode === 'environment' && !nextSettings?.facingMode) {
          setConstraints((previous) =>
            previous.facingMode === 'environment'
              ? { ...previous, facingMode: 'user' }
              : previous
          );
        }
        setStatus('playing');
        await refreshDevices();
        void probeEnvironmentFacingMode(mediaDevices, requestId);
      } catch (e) {
        if (requestId !== requestIdRef.current) return;
        const err = e as Error & { name?: string; constraint?: string };
        const constraintHint = err.constraint ? ` (${err.constraint})` : '';
        setError(`${err.name ?? 'Error'}${constraintHint}: ${err.message}`);
        setStatus('error');
      }
    },
    [constraints, probeEnvironmentFacingMode, refreshDevices]
  );

  const applyConstraints = React.useCallback(
    (patch: Partial<CameraConstraints>): void => {
      setConstraints((previous) => {
        const merged = mergeCameraConstraints(previous, patch);
        if (cameraConstraintsEqual(previous, merged)) return previous;
        if (streamRef.current) {
          void start(merged);
        }
        return merged;
      });
    },
    [start]
  );

  React.useEffect(() => {
    queueMicrotask(() => {
      void refreshDevices();
    });
    return () => {
      const live = streamRef.current;
      if (live) {
        for (const track of live.getTracks()) track.stop();
        streamRef.current = null;
      }
    };
  }, [refreshDevices]);

  const hardware: CameraHardwareState = React.useMemo(() => {
    if (status === 'requesting' || status === 'starting') {
      return { owner: 'standard', phase: 'starting' };
    }
    if (status === 'playing') return { owner: 'standard', phase: 'started' };
    if (status === 'stopping') return { owner: 'standard', phase: 'stopping' };
    return { owner: null, phase: 'stopped' };
  }, [status]);

  const facingModeAvailability: CameraFacingAvailability = React.useMemo(
    () => ({
      ...DEFAULT_FACING_AVAILABILITY,
      environment: environmentFacingAvailability,
    }),
    [environmentFacingAvailability]
  );

  const value: CameraContextValue = React.useMemo(
    () => ({
      stream,
      status,
      hardware,
      error,
      constraints,
      settings,
      devices,
      facingModeAvailability,
      userStopped,
      externalLocked: false,
      lidarStatus: 'unsupported',
      lidarError: null,
      start,
      stop,
      lockExternal: async () => stop(),
      unlockExternal: () => {},
      applyConstraints,
    }),
    [
      applyConstraints,
      constraints,
      devices,
      error,
      facingModeAvailability,
      hardware,
      settings,
      start,
      status,
      stop,
      stream,
      userStopped,
    ]
  );

  return <CameraContext.Provider value={value}>{children}</CameraContext.Provider>;
}

export function useCamera(): CameraContextValue {
  const ctx = React.useContext(CameraContext);
  if (!ctx) {
    throw new Error('useCamera must be called inside a <CameraProvider>');
  }
  return ctx;
}
