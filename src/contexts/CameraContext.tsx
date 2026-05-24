import * as Linking from 'expo-linking';
import * as React from 'react';

// Single owner of the app's camera MediaStream. Both the Home preview and the
// Demo tab's WebGPU cube consume from this provider so they (a) don't fight
// over the AVCaptureSession and (b) reflect the same Start / Stop state.
// Home's constraint pickers live here too — picking a new device, resolution,
// or frame rate hot-swaps the stream and every consumer sees the change.
//
// The shape mirrors what Home already used: idle → requesting → playing /
// error → idle. Pickers funnel through `applyConstraints` so the merge
// semantics live in one place. The provider auto-starts the camera once on
// app launch unless the app was opened via a run-tests deep link (so the WPT
// runner gets a clean AVCaptureSession). After that, Start / Stop is driven
// by whichever tab the user is on.

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'starting'
  | 'playing'
  | 'ended'
  | 'error';

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
  error: string | null;
  constraints: CameraConstraints;
  settings: MediaTrackSettings | null;
  devices: MediaDeviceInfo[];
  /**
   * True when the user has explicitly tapped Stop. Consumers that "want the
   * camera on by default" check this before auto-starting so their intent
   * doesn't fight the user's explicit Stop.
   */
  userStopped: boolean;
  /**
   * Open the camera with the merged constraints (or the current stored
   * constraints if none provided). Hot-swaps a running stream if one exists.
   */
  start: (next?: CameraConstraints) => Promise<void>;
  stop: () => void;
  /**
   * Merge a partial constraints patch into the active constraints and
   * restart the stream so consumers immediately see the change. `deviceId`
   * and `facingMode` are mutually exclusive — setting one clears the other,
   * matching the W3C constrainable behavior.
   */
  applyConstraints: (patch: Partial<CameraConstraints>) => void;
}

const DEFAULT_CONSTRAINTS: CameraConstraints = { facingMode: 'environment' };

// Module-load trace so we can confirm fresh JS reached the phone — appears
// at the top of the JS evaluation, before any React renders.
// eslint-disable-next-line no-console
console.log(`CAMERA_CTX module-load @ ${new Date().toISOString()}`);

const initialUrlPromise = Linking.getInitialURL();

function isTestsLaunchUrl(url: string | null): boolean {
  return url != null && /(?:^|[/?:#])run-tests(?:$|[/?#&])/.test(url);
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
  const [autoStartGated, setAutoStartGated] = React.useState(false);

  const streamRef = React.useRef<MediaStream | null>(null);
  const startRequestRef = React.useRef(0);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const live = streamRef.current;
      if (live) {
        for (const t of live.getTracks()) t.stop();
        streamRef.current = null;
      }
    };
  }, []);

  const stop = React.useCallback((): void => {
    startRequestRef.current += 1;
    const live = streamRef.current;
    streamRef.current = null;
    if (live) {
      for (const t of live.getTracks()) t.stop();
    }
    if (mountedRef.current) {
      setStreamState(null);
      setSettings(null);
      setStatus('idle');
      setUserStopped(true);
    }
  }, []);

  const start = React.useCallback(
    async (next?: CameraConstraints): Promise<void> => {
      const effective = next ?? constraints;
      const requestId = startRequestRef.current + 1;
      startRequestRef.current = requestId;
      const previous = streamRef.current;
      if (previous) {
        streamRef.current = null;
        setStreamState(null);
        setSettings(null);
        for (const t of previous.getTracks()) t.stop();
      }
      setError(null);
      setStatus('requesting');
      setUserStopped(false);
      // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
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
        // eslint-disable-next-line no-console
        console.log(
          `CAMERA_CTX gUM-fail req=${requestId} ${err.name ?? 'Error'}: ${err.message}`
        );
        if (!mountedRef.current || requestId !== startRequestRef.current) return;
        const constraintHint = err.constraint ? ` (${err.constraint})` : '';
        setError(`${err.name ?? 'Error'}${constraintHint}: ${err.message}`);
        setStatus('error');
      }
    },
    [constraints]
  );

  const applyConstraints = React.useCallback(
    (patch: Partial<CameraConstraints>): void => {
      setConstraints((prev) => {
        const merged: CameraConstraints = { ...prev, ...patch };
        if (patch.deviceId) delete merged.facingMode;
        if (patch.facingMode) delete merged.deviceId;
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

  // Resolve the run-tests-deeplink gate once on first mount. Until it's
  // resolved we hold off on auto-starting so a tests deeplink reliably skips
  // the camera. Subsequent JS reloads keep the resolved value.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const initialUrl = await initialUrlPromise;
      if (cancelled) return;
      const gated = isTestsLaunchUrl(initialUrl);
      // eslint-disable-next-line no-console
      console.log(`CAMERA_CTX gate resolved isTestsLaunch=${gated} initialUrl=${initialUrl}`);
      setAutoStartGated(gated);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-start whenever there's no live stream and the user hasn't explicitly
  // stopped. Driven by state (not a ref) so HMR can't strand the launch
  // intent. Idempotent thanks to the `status === 'requesting'` guard.
  React.useEffect(() => {
    if (autoStartGated || userStopped) return;
    if (stream || status === 'requesting') return;
    // eslint-disable-next-line no-console
    console.log(`CAMERA_CTX auto-start firing (status=${status})`);
    void start();
  }, [autoStartGated, userStopped, stream, status, start]);

  const value: CameraContextValue = React.useMemo(
    () => ({ stream, status, error, constraints, settings, devices, userStopped, start, stop, applyConstraints }),
    [stream, status, error, constraints, settings, devices, userStopped, start, stop, applyConstraints]
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
