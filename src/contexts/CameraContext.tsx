import * as React from 'react';

import { cameraConstraintsEqual, mergeCameraConstraints } from '@/lib/camera-constraints';
import { KNOWN_FACING_AVAILABILITY, type CameraFacingAvailability } from '@/lib/camera-facing';
import { createCameraOwnershipGate } from '@/lib/camera-ownership';

import {
  NativeStandardCamera,
  setWebXRDepthCameraLockHandlers,
  type NativeLiDARDepthSessionEvent,
} from '../../modules/standard-camera';

// Single owner of the app's camera MediaStream. Both the Home preview and the
// Demo tab's WebGPU cube consume from this provider so they (a) don't fight
// over the AVCaptureSession and (b) reflect the same Start / Stop state.
// Home's constraint pickers live here too — picking a new device, resolution,
// or frame rate hot-swaps the stream and every consumer sees the change.
//
// The standard camera state mirrors what Home already used: idle → requesting
// → playing / error → stopping → idle. The derived `hardware` state collapses
// that plus the LiDAR ARKit state into stopped / starting / started / stopping
// so navigation chrome can render the right control from frame zero of a push.
// Pickers funnel through `applyConstraints` so the merge semantics live in one
// place. Start / Stop is driven by focused screens that actually consume the
// standard camera stream. WebXR/LiDAR routes can therefore enter ARKit without
// first paying for an unrelated AVFoundation getUserMedia startup.

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
  /**
   * True when the user has explicitly tapped Stop. Consumers that "want the
   * camera on by default" check this before auto-starting so their intent
   * doesn't fight the user's explicit Stop.
   */
  userStopped: boolean;
  /**
   * True while some other subsystem (currently the LiDAR demo's ARKit
   * session) owns the AVCaptureDevice exclusively. Auto-start is suppressed
   * while this is set, and any active getUserMedia stream is torn down on
   * `lockExternal()`. Distinct from `userStopped` so leaving the LiDAR demo
   * doesn't strand the rest of the app in a "user explicitly stopped" state.
   */
  externalLocked: boolean;
  lidarStatus: LiDARCameraStatus;
  lidarError: string | null;
  /**
   * Open the camera with the merged constraints (or the current stored
   * constraints if none provided). Hot-swaps a running stream if one exists.
   */
  start: (next?: CameraConstraints) => Promise<void>;
  stop: () => void;
  /**
   * Tear down the getUserMedia stream so another subsystem can take the
   * AVCaptureDevice (ARKit), and gate focused standard-camera consumers until
   * `unlockExternal()` runs. Does not touch `userStopped`.
   */
  lockExternal: () => Promise<void>;
  unlockExternal: () => void;
  /**
   * Merge a partial constraints patch into the active constraints and
   * restart the stream so consumers immediately see the change. `deviceId`
   * and `facingMode` are mutually exclusive — setting one clears the other,
   * matching the W3C constrainable behavior.
   */
  applyConstraints: (patch: Partial<CameraConstraints>) => void;
}

const DEFAULT_CONSTRAINTS: CameraConstraints = { facingMode: 'environment' };
const CAMERA_HARDWARE_RELEASE_DELAY_MS = 150;

// Module-load trace so we can confirm fresh JS reached the phone — appears
// at the top of the JS evaluation, before any React renders.
console.log(`CAMERA_CTX module-load @ ${new Date().toISOString()}`);

type ReleasableNativeStream = {
  _native?: {
    __stopTracksAndWaitForCaptureReleaseAsync?: () => Promise<void>;
  };
};

async function stopTracksAndWaitForCaptureRelease(stream: MediaStream): Promise<void> {
  const nativeStream = (stream as unknown as ReleasableNativeStream)._native;
  if (nativeStream?.__stopTracksAndWaitForCaptureReleaseAsync) {
    await nativeStream.__stopTracksAndWaitForCaptureReleaseAsync();
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

const CameraContext = React.createContext<CameraContextValue | null>(null);

export function CameraProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [stream, setStreamState] = React.useState<MediaStream | null>(null);
  const [status, setStatus] = React.useState<CameraStatus>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [constraints, setConstraints] = React.useState<CameraConstraints>(DEFAULT_CONSTRAINTS);
  const [settings, setSettings] = React.useState<MediaTrackSettings | null>(null);
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  // Track explicit user intent so stop() isn't immediately undone by the
  // stream-state-driven auto-start effect.
  const [userStopped, setUserStopped] = React.useState(false);
  // Set by another subsystem (ARKit/LiDAR) that needs the AVCaptureDevice.
  // The auto-start effect bails while this is true and `lockExternal()`
  // tears down any live track so the lock-holder can acquire the device.
  const [externalLocked, setExternalLocked] = React.useState(false);
  const [lidarStatus, setLiDARStatus] = React.useState<LiDARCameraStatus>('idle');
  const [lidarError, setLiDARError] = React.useState<string | null>(null);

  const streamRef = React.useRef<MediaStream | null>(null);
  const getUserMediaInFlightRef = React.useRef<Promise<MediaStream> | null>(null);
  const startRequestRef = React.useRef(0);
  const standardStopTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = React.useRef(true);
  const cameraOwnershipGate = React.useMemo(() => createCameraOwnershipGate(), []);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (standardStopTimerRef.current) {
        clearTimeout(standardStopTimerRef.current);
        standardStopTimerRef.current = null;
      }
      const live = streamRef.current;
      if (live) {
        for (const t of live.getTracks()) t.stop();
        streamRef.current = null;
      }
      NativeStandardCamera.stopLiDARDepth();
    };
  }, []);

  const stop = React.useCallback((): void => {
    const stopRequestId = startRequestRef.current + 1;
    startRequestRef.current = stopRequestId;
    cameraOwnershipGate.setStartInFlight(false);
    if (standardStopTimerRef.current) {
      clearTimeout(standardStopTimerRef.current);
      standardStopTimerRef.current = null;
    }
    const live = streamRef.current;
    streamRef.current = null;
    if (live) {
      for (const t of live.getTracks()) t.stop();
    }
    if (mountedRef.current) {
      setStreamState(null);
      setSettings(null);
      setStatus('stopping');
      setUserStopped(true);
      standardStopTimerRef.current = setTimeout(() => {
        standardStopTimerRef.current = null;
        if (!mountedRef.current || stopRequestId !== startRequestRef.current) return;
        setStatus('idle');
      }, CAMERA_HARDWARE_RELEASE_DELAY_MS);
    }
  }, [cameraOwnershipGate]);

  const lockExternal = React.useCallback(async (): Promise<void> => {
    // Invalidate any in-flight start() so its post-await setState calls bail.
    cameraOwnershipGate.lockExternal();
    startRequestRef.current += 1;
    if (standardStopTimerRef.current) {
      clearTimeout(standardStopTimerRef.current);
      standardStopTimerRef.current = null;
    }
    const live = streamRef.current;
    const pendingMedia = getUserMediaInFlightRef.current;
    streamRef.current = null;
    if (mountedRef.current) {
      setStreamState(null);
      setSettings(null);
      setStatus('idle');
      setExternalLocked(true);
    }
    if (live) {
      await stopTracksAndWaitForCaptureRelease(live);
    }
    if (pendingMedia) {
      try {
        const pendingStream = await pendingMedia;
        if (pendingStream !== live) {
          await stopTracksAndWaitForCaptureRelease(pendingStream);
        }
      } catch {
        // The in-flight getUserMedia request may fail after the external lock
        // invalidates it; the lock still succeeded because there is no stream
        // left to hand off.
      }
    }
  }, [cameraOwnershipGate]);

  const unlockExternal = React.useCallback((): void => {
    cameraOwnershipGate.unlockExternal();
    if (mountedRef.current) {
      setExternalLocked(false);
    }
  }, [cameraOwnershipGate]);

  React.useEffect(() => {
    // @ref LLP 0013#xr-request-session — WebXR research sessions use the same
    // camera handoff path as the native LiDAR sidecar before ARKit starts.
    setWebXRDepthCameraLockHandlers({ lockExternal, unlockExternal });
    return () => {
      setWebXRDepthCameraLockHandlers(null);
    };
  }, [lockExternal, unlockExternal]);

  const start = React.useCallback(
    async (next?: CameraConstraints): Promise<void> => {
      const effective = next ?? constraints;
      let blockReason = cameraOwnershipGate.startBlockReason({
        explicitConstraints: next != null,
        hasStream: streamRef.current !== null,
      });
      if (blockReason === 'external-lock') {
        console.log(`CAMERA_CTX start blocked external-lock ${JSON.stringify(effective)}`);
        return;
      }
      if (blockReason === 'duplicate-default-start') {
        console.log(`CAMERA_CTX start skipped in-flight ${JSON.stringify(effective)}`);
        return;
      }
      if (standardStopTimerRef.current) {
        clearTimeout(standardStopTimerRef.current);
        standardStopTimerRef.current = null;
      }
      blockReason = cameraOwnershipGate.startBlockReason({
        explicitConstraints: next != null,
        hasStream: streamRef.current !== null,
      });
      if (blockReason === 'external-lock') {
        console.log(`CAMERA_CTX start blocked external-lock ${JSON.stringify(effective)}`);
        return;
      }
      if (blockReason === 'duplicate-default-start') {
        console.log(`CAMERA_CTX start skipped in-flight ${JSON.stringify(effective)}`);
        return;
      }
      const requestId = startRequestRef.current + 1;
      startRequestRef.current = requestId;
      // @ref LLP 0012#camera-ownership-handoff — Provider auto-start and
      // screen-level start-on-mount can fire before React commits `requesting`.
      // Coalesce duplicate default starts so a WebXR/LiDAR handoff does not
      // immediately queue two AVFoundation getUserMedia requests. The gate is
      // synchronous so stale focused-route closures cannot reopen AVFoundation
      // after WebXR has locked the camera for ARKit.
      cameraOwnershipGate.setStartInFlight(true);
      const previous = streamRef.current;
      if (previous) {
        streamRef.current = null;
        setStreamState(null);
        for (const t of previous.getTracks()) t.stop();
      }
      setError(null);
      setStatus('requesting');
      setUserStopped(false);
      console.log(`CAMERA_CTX start req=${requestId} ${JSON.stringify(effective)}`);

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

      let mediaRequest: Promise<MediaStream> | null = null;
      try {
        mediaRequest = navigator.mediaDevices.getUserMedia({ video });
        getUserMediaInFlightRef.current = mediaRequest;
        const s = await mediaRequest;
        console.log(
          `CAMERA_CTX gUM-ok req=${requestId} tracks=${s.getVideoTracks().length}`
        );
        if (!mountedRef.current || requestId !== startRequestRef.current) {
          await stopTracksAndWaitForCaptureRelease(s);
          return;
        }
        streamRef.current = s;
        setStreamState(s);
        setSettings(s.getVideoTracks()[0]?.getSettings() ?? null);
        setStatus('starting');

        // Refresh the device list off the hot-swap path so the picker rows
        // don't reflow mid-tap.
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          if (mountedRef.current) {
            setDevices(all.filter((d) => d.kind === 'videoinput'));
          }
        } catch {
          // Best-effort; ignore failures.
        }
      } catch (e) {
        const err = e as Error & { name?: string; constraint?: string };
        console.log(
          `CAMERA_CTX gUM-fail req=${requestId} ${err.name ?? 'Error'}: ${err.message}`
        );
        if (!mountedRef.current || requestId !== startRequestRef.current) return;
        const constraintHint = err.constraint ? ` (${err.constraint})` : '';
        setSettings(null);
        setError(`${err.name ?? 'Error'}${constraintHint}: ${err.message}`);
        setStatus('error');
      } finally {
        if (mediaRequest && getUserMediaInFlightRef.current === mediaRequest) {
          getUserMediaInFlightRef.current = null;
        }
        if (requestId === startRequestRef.current) {
          cameraOwnershipGate.setStartInFlight(false);
        }
      }
    },
    [cameraOwnershipGate, constraints]
  );

  const applyConstraints = React.useCallback(
    (patch: Partial<CameraConstraints>): void => {
      setConstraints((prev) => {
        const merged = mergeCameraConstraints(prev, patch);
        if (cameraConstraintsEqual(prev, merged)) return prev;
        // Re-start only if a stream is already live — picking a constraint
        // before pressing Start should update the stored value silently.
        if (streamRef.current) {
          void start(merged);
        }
        return merged;
      });
    },
    [start]
  );

  // Promote the track's `playing` state to status when the underlying video
  // element reports loadeddata. Consumers that need the element (Home) handle
  // that wiring themselves; here we just expose the track's readyState so
  // status stays meaningful even without a video element.
  /* eslint-disable react-hooks/set-state-in-effect -- Preserve the existing track-to-context status promotion. */
  React.useEffect(() => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const onEnded = (): void => {
      if (mountedRef.current && streamRef.current === stream) {
        setStatus('ended');
      }
    };
    track.addEventListener('ended', onEnded);
    setStatus('playing');
    return () => {
      track.removeEventListener('ended', onEnded);
    };
  }, [stream]);
  /* eslint-enable react-hooks/set-state-in-effect */

  React.useEffect(() => {
    const subscription = NativeStandardCamera.addListener(
      'onLiDARDepthSessionState',
      (event: NativeLiDARDepthSessionEvent) => {
        if (!mountedRef.current) return;
        // @ref LLP 0012#camera-ownership-handoff — Terminal events from a
        // previous ARKit session can arrive after a new WebXR request has
        // taken the synchronous external lock. Do not clear that lock until a
        // matching native session has established ownership and then stops.
        const decision = cameraOwnershipGate.handleExternalSessionEvent(event);
        if (!decision.accepted) {
          console.log(`CAMERA_CTX lidar event ignored ${JSON.stringify({
            activeSessionId: cameraOwnershipGate.activeExternalSessionId(),
            reason: decision.reason,
            sessionId: event.sessionId,
            state: event.state,
          })}`);
          return;
        }

        if (event.state === 'running') {
          setLiDARError(null);
          setLiDARStatus('running');
          return;
        }

        if (event.state === 'interrupted') {
          setLiDARError(event.reason ?? 'ARKit scene depth session was interrupted');
          setLiDARStatus('interrupted');
          return;
        }

        if (event.state === 'starting') {
          setLiDARError(null);
          setLiDARStatus('starting');
          return;
        }

        if (event.state === 'failed') {
          setLiDARStatus('error');
          setLiDARError(event.reason ?? 'ARKit scene depth session failed');
          if (decision.releaseLock) {
            unlockExternal();
          }
          return;
        }

        if (event.state === 'stopped') {
          setLiDARStatus('stopped');
          if (decision.releaseLock) {
            unlockExternal();
          }
        }
      }
    );
    return () => {
      subscription.remove();
    };
  }, [cameraOwnershipGate, unlockExternal]);

  const hardware: CameraHardwareState = React.useMemo(() => {
    if (lidarStatus === 'starting') return { owner: 'lidar', phase: 'starting' };
    if (lidarStatus === 'running' || lidarStatus === 'interrupted') {
      return { owner: 'lidar', phase: 'started' };
    }
    if (lidarStatus === 'stopping') return { owner: 'lidar', phase: 'stopping' };
    if (externalLocked) return { owner: 'lidar', phase: 'stopping' };
    if (status === 'requesting' || status === 'starting') {
      return { owner: 'standard', phase: 'starting' };
    }
    if (status === 'playing') return { owner: 'standard', phase: 'started' };
    if (status === 'stopping') return { owner: 'standard', phase: 'stopping' };
    return { owner: null, phase: 'stopped' };
  }, [externalLocked, lidarStatus, status]);

  const value: CameraContextValue = React.useMemo(
    () => ({
      stream,
      status,
      hardware,
      error,
      constraints,
      settings,
      devices,
      facingModeAvailability: KNOWN_FACING_AVAILABILITY,
      userStopped,
      externalLocked,
      lidarStatus,
      lidarError,
      start,
      stop,
      lockExternal,
      unlockExternal,
      applyConstraints,
    }),
    [
      stream,
      status,
      hardware,
      error,
      constraints,
      settings,
      devices,
      userStopped,
      externalLocked,
      lidarStatus,
      lidarError,
      start,
      stop,
      lockExternal,
      unlockExternal,
      applyConstraints,
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
