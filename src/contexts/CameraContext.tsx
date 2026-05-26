import * as Linking from 'expo-linking';
import * as React from 'react';

import { cameraConstraintsEqual, mergeCameraConstraints } from '@/lib/camera-constraints';
import { KNOWN_FACING_AVAILABILITY, type CameraFacingAvailability } from '@/lib/camera-facing';

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
// place. The provider auto-starts the camera once on app launch unless the app
// was opened via a run-tests deep link (so the WPT runner gets a clean
// AVCaptureSession). After that, Start / Stop is driven by whichever tab the
// user is on.

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
type AutoStartGate = 'pending' | 'allowed' | 'blocked-by-tests';

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
   * AVCaptureDevice (ARKit), and gate the auto-start effect off until
   * `unlockExternal()` runs. Does not touch `userStopped`, so when the lock
   * lifts the camera resumes for users who hadn't explicitly stopped.
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

const initialUrlPromise = Linking.getInitialURL();

function isTestsLaunchUrl(url: string | null): boolean {
  return url != null && /(?:^|[/?:#])run-tests(?:$|[/?#&])/.test(url);
}

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
  const [autoStartGate, setAutoStartGate] = React.useState<AutoStartGate>('pending');

  const streamRef = React.useRef<MediaStream | null>(null);
  const startRequestRef = React.useRef(0);
  const activeLiDARSessionIdRef = React.useRef<number | null>(null);
  const standardStopTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = React.useRef(true);

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
  }, []);

  const lockExternal = React.useCallback(async (): Promise<void> => {
    // Invalidate any in-flight start() so its post-await setState calls bail.
    startRequestRef.current += 1;
    if (standardStopTimerRef.current) {
      clearTimeout(standardStopTimerRef.current);
      standardStopTimerRef.current = null;
    }
    const live = streamRef.current;
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
  }, []);

  const unlockExternal = React.useCallback((): void => {
    if (mountedRef.current) {
      setExternalLocked(false);
    }
  }, []);

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
      if (externalLocked) return;
      if (standardStopTimerRef.current) {
        clearTimeout(standardStopTimerRef.current);
        standardStopTimerRef.current = null;
      }
      const effective = next ?? constraints;
      const requestId = startRequestRef.current + 1;
      startRequestRef.current = requestId;
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

      try {
        const s = await navigator.mediaDevices.getUserMedia({ video });
        console.log(
          `CAMERA_CTX gUM-ok req=${requestId} tracks=${s.getVideoTracks().length}`
        );
        if (!mountedRef.current || requestId !== startRequestRef.current) {
          for (const t of s.getTracks()) t.stop();
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
      }
    },
    [constraints, externalLocked]
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
        const activeSessionId = activeLiDARSessionIdRef.current;
        if (activeSessionId !== null && event.sessionId !== activeSessionId) return;

        if (event.state === 'running') {
          activeLiDARSessionIdRef.current = event.sessionId;
          setLiDARError(null);
          setLiDARStatus('running');
          return;
        }

        if (event.state === 'interrupted') {
          activeLiDARSessionIdRef.current = event.sessionId;
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
          activeLiDARSessionIdRef.current = null;
          setLiDARStatus('error');
          setLiDARError(event.reason ?? 'ARKit scene depth session failed');
          unlockExternal();
          return;
        }

        if (event.state === 'stopped') {
          activeLiDARSessionIdRef.current = null;
          setLiDARStatus('stopped');
          unlockExternal();
        }
      }
    );
    return () => {
      subscription.remove();
    };
  }, [unlockExternal]);

  // Resolve the run-tests-deeplink gate once on first mount. Until it's
  // resolved we hold off on auto-starting so a tests deeplink reliably skips
  // the camera. Subsequent JS reloads keep the resolved value.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const initialUrl = await initialUrlPromise;
        if (cancelled) return;
        const gated = isTestsLaunchUrl(initialUrl);
        console.log(`CAMERA_CTX gate resolved isTestsLaunch=${gated} initialUrl=${initialUrl}`);
        setAutoStartGate(gated ? 'blocked-by-tests' : 'allowed');
      } catch (e) {
        if (cancelled) return;
        console.log(`CAMERA_CTX gate failed; allowing auto-start ${String(e)}`);
        setAutoStartGate('allowed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-start whenever there's no live stream and the user hasn't explicitly
  // stopped. Driven by state (not a ref) so HMR can't strand the launch
  // intent. Idempotent thanks to the transition-state guard.
  // Suppressed while `externalLocked` so we don't fight ARKit/LiDAR for the
  // AVCaptureDevice during their session.
  /* eslint-disable react-hooks/set-state-in-effect -- Preserve current auto-start scheduling. */
  React.useEffect(() => {
    if (autoStartGate !== 'allowed' || userStopped || externalLocked) return;
    if (stream || status === 'requesting' || status === 'starting' || status === 'stopping') return;
    console.log(`CAMERA_CTX auto-start firing (status=${status})`);
    void start();
  }, [autoStartGate, userStopped, externalLocked, stream, status, start]);
  /* eslint-enable react-hooks/set-state-in-effect */

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
