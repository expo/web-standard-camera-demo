import { useIsFocused } from 'expo-router';
import * as Linking from 'expo-linking';
import * as React from 'react';
import { Button, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { addTestRunStartListener } from '@/lib/camera-run-events';
import { Video, type HTMLVideoElement } from '../../../../modules/standard-camera';

// @ref LLP 0000 — Demo screen: the entire surface a developer interacts with
// is the spec-shaped navigator.mediaDevices.getUserMedia + <Video srcObject>.
//
// The control rows below the preview each map 1:1 to a W3C constrainable
// property on `MediaTrackConstraints` — camera picker → `deviceId`, facing
// toggle → `facingMode`, resolution picker → `width` + `height`, frame-rate
// picker → `frameRate`. Picking any value tears down the current stream and
// starts a new one with the merged constraints, so the resulting
// `track.getSettings()` shown at the bottom always reflects what gUM actually
// resolved to.

const initialUrlPromise = Linking.getInitialURL();

interface Constraints {
  deviceId?: string;
  facingMode?: 'user' | 'environment';
  width?: number;
  height?: number;
  frameRate?: number;
}

interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
}

const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { label: '640×480', width: 640, height: 480 },
  { label: '1280×720', width: 1280, height: 720 },
  { label: '1920×1080', width: 1920, height: 1080 },
  { label: '3840×2160', width: 3840, height: 2160 },
];

const FRAME_RATE_PRESETS: number[] = [30, 60];

export default function HomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const isFocused = useIsFocused();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const mountedRef = React.useRef(false);
  const startRequestRef = React.useRef(0);
  const launchAutoStartCheckedRef = React.useRef(false);
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [status, setStatus] = React.useState<string>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [constraints, setConstraints] = React.useState<Constraints>({ facingMode: 'environment' });
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [settings, setSettings] = React.useState<MediaTrackSettings | null>(null);

  const stop = React.useCallback((nextStatus = 'stopped'): void => {
    const activeStream = streamRef.current;
    if (!activeStream) return;
    for (const track of activeStream.getTracks()) {
      track.stop();
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    streamRef.current = null;
    if (mountedRef.current) {
      setStream(null);
      setSettings(null);
      setStatus(nextStatus);
    }
  }, []);

  const stopForTestRun = React.useCallback((): void => {
    startRequestRef.current += 1;
    if (!streamRef.current && mountedRef.current) {
      setStatus('stopped');
    }
    stop();
  }, [stop]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [stop]);

  React.useEffect(() => addTestRunStartListener(stopForTestRun), [stopForTestRun]);

  const start = React.useCallback(
    async (next: Constraints): Promise<void> => {
      const requestId = startRequestRef.current + 1;
      startRequestRef.current = requestId;
      // Tear down any prior stream so the AVCaptureSession can be reused.
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) track.stop();
        if (videoRef.current) videoRef.current.srcObject = null;
        streamRef.current = null;
      }
      setError(null);
      setSettings(null);
      setStatus('requesting');
      const video: MediaTrackConstraints = {};
      if (next.deviceId) {
        video.deviceId = { exact: next.deviceId };
      } else if (next.facingMode) {
        video.facingMode = next.facingMode;
      }
      if (next.width && next.height) {
        video.width = { exact: next.width };
        video.height = { exact: next.height };
      }
      if (next.frameRate) {
        video.frameRate = { ideal: next.frameRate };
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video });
        if (!mountedRef.current || requestId !== startRequestRef.current) {
          for (const track of s.getTracks()) track.stop();
          return;
        }
        streamRef.current = s;
        setStream(s);
        setSettings(s.getVideoTracks()[0]?.getSettings() ?? null);
        setStatus('starting');

        // Refresh the device list — post-grant, enumerateDevices() exposes
        // the full set with labels.
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          if (mountedRef.current) {
            setDevices(all.filter((d) => d.kind === 'videoinput'));
          }
        } catch {
          // ignore — device list is best-effort.
        }

        const v = videoRef.current;
        if (v) {
          v.srcObject = s;
          v.onloadeddata = () => {
            if (mountedRef.current && streamRef.current === s) setStatus('playing');
          };
          v.onended = () => {
            if (mountedRef.current && streamRef.current === s) setStatus('ended');
          };
          await v.play();
        }
      } catch (e) {
        if (!mountedRef.current || requestId !== startRequestRef.current) return;
        const err = e as Error & { name?: string; constraint?: string };
        const constraintHint = err.constraint ? ` (${err.constraint})` : '';
        setError(`${err.name ?? 'Error'}${constraintHint}: ${err.message}`);
        setStatus('idle');
      }
    },
    []
  );

  // Apply a partial change to the constraints state and restart the stream.
  const applyConstraints = React.useCallback(
    (patch: Partial<Constraints>): void => {
      const next: Constraints = { ...constraints, ...patch };
      // Picking a deviceId means we no longer want facingMode to override it.
      if (patch.deviceId) delete next.facingMode;
      // Picking a facingMode means we no longer want a sticky deviceId.
      if (patch.facingMode) delete next.deviceId;
      setConstraints(next);
      void start(next);
    },
    [constraints, start]
  );

  // Auto-start only for the initial Home launch. A run-tests deeplink mounts
  // native tabs eagerly, so checking the original launch URL prevents the Home
  // screen from opening the camera behind the Tests tab.
  React.useEffect(() => {
    if (!isFocused || launchAutoStartCheckedRef.current) return;
    launchAutoStartCheckedRef.current = true;

    let cancelled = false;
    void (async () => {
      const initialUrl = await initialUrlPromise;
      if (cancelled || isTestsLaunchUrl(initialUrl)) return;
      await start(constraints);
    })();

    return () => {
      cancelled = true;
    };
  }, [isFocused, start, constraints]);

  const isFront = settings?.facingMode === 'user' || constraints.facingMode === 'user';

  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.contentContainer}
      contentInsetAdjustmentBehavior="automatic">
      <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
        navigator.mediaDevices.getUserMedia → &lt;Video srcObject&gt;
      </Text>

      <View style={styles.videoContainer}>
        <Video ref={videoRef} style={styles.video} />
      </View>

      <View style={styles.controls}>
        {!stream ? (
          <Button title="Start camera" onPress={() => start(constraints)} />
        ) : (
          <Button title="Stop camera" onPress={() => stop()} />
        )}
      </View>

      <ControlRow label="Facing" theme={theme}>
        <Pill
          label="Front"
          selected={isFront}
          theme={theme}
          onPress={() => applyConstraints({ facingMode: 'user' })}
        />
        <Pill
          label="Back"
          selected={!isFront}
          theme={theme}
          onPress={() => applyConstraints({ facingMode: 'environment' })}
        />
      </ControlRow>

      {devices.length > 0 ? (
        <ControlRow label="Camera" theme={theme}>
          {devices.map((d) => (
            <Pill
              key={d.deviceId}
              label={d.label || '(unlabeled)'}
              selected={settings?.deviceId === d.deviceId}
              theme={theme}
              onPress={() => applyConstraints({ deviceId: d.deviceId })}
            />
          ))}
        </ControlRow>
      ) : null}

      <ControlRow label="Resolution" theme={theme}>
        <Pill
          label="Auto"
          selected={!constraints.width}
          theme={theme}
          onPress={() => applyConstraints({ width: undefined, height: undefined })}
        />
        {RESOLUTION_PRESETS.map((p) => (
          <Pill
            key={p.label}
            label={p.label}
            selected={constraints.width === p.width && constraints.height === p.height}
            theme={theme}
            onPress={() => applyConstraints({ width: p.width, height: p.height })}
          />
        ))}
      </ControlRow>

      <ControlRow label="Frame rate" theme={theme}>
        <Pill
          label="Auto"
          selected={!constraints.frameRate}
          theme={theme}
          onPress={() => applyConstraints({ frameRate: undefined })}
        />
        {FRAME_RATE_PRESETS.map((fr) => (
          <Pill
            key={fr}
            label={`${fr} fps`}
            selected={constraints.frameRate === fr}
            theme={theme}
            onPress={() => applyConstraints({ frameRate: fr })}
          />
        ))}
      </ControlRow>

      <View style={styles.statusBlock}>
        <Text style={[styles.statusLine, { color: theme.text }]}>status: {status}</Text>
        <Text style={[styles.statusLine, { color: theme.text }]}>
          active: {stream?.active ? 'true' : 'false'}
        </Text>
        <Text style={[styles.statusLine, { color: theme.text }]}>
          tracks: {stream?.getTracks().length ?? 0}
        </Text>
        {settings ? (
          <>
            <Text style={[styles.statusLine, { color: theme.textSecondary }]}>
              settings.deviceId: {String(settings.deviceId ?? '—')}
            </Text>
            <Text style={[styles.statusLine, { color: theme.textSecondary }]}>
              settings.facingMode: {String(settings.facingMode ?? '—')}
            </Text>
            <Text style={[styles.statusLine, { color: theme.textSecondary }]}>
              settings.width × height: {String(settings.width ?? '—')} ×{' '}
              {String(settings.height ?? '—')}
            </Text>
            <Text style={[styles.statusLine, { color: theme.textSecondary }]}>
              settings.frameRate: {String(settings.frameRate ?? '—')}
            </Text>
          </>
        ) : null}
        {error && <Text style={styles.errorLine}>{error}</Text>}
      </View>
    </ScrollView>
  );
}

function ControlRow({
  label,
  theme,
  children,
}: {
  label: string;
  theme: { text: string; textSecondary: string; backgroundElement: string };
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.controlRow}>
      <Text style={[styles.controlLabel, { color: theme.textSecondary }]}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.pillRow}>
        {children}
      </ScrollView>
    </View>
  );
}

function Pill({
  label,
  selected,
  theme,
  onPress,
}: {
  label: string;
  selected: boolean;
  theme: { text: string; textSecondary: string; backgroundElement: string };
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: selected ? theme.text : theme.backgroundElement,
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <Text
        style={[
          styles.pillText,
          { color: selected ? theme.backgroundElement : theme.text },
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

function isTestsLaunchUrl(url: string | null): boolean {
  return url != null && /(?:^|[/?:#])run-tests(?:$|[/?#&])/.test(url);
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    gap: 14,
    paddingBottom: 32,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'Menlo',
  },
  videoContainer: {
    aspectRatio: 3 / 4,
    backgroundColor: '#111',
    borderRadius: 12,
    overflow: 'hidden',
  },
  video: {
    flex: 1,
  },
  controls: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  controlRow: {
    gap: 4,
  },
  controlLabel: {
    fontFamily: 'Menlo',
    fontSize: 11,
  },
  pillRow: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  pillText: {
    fontFamily: 'Menlo',
    fontSize: 12,
    fontWeight: '600',
  },
  statusBlock: {
    gap: 4,
    marginTop: 4,
  },
  statusLine: {
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  errorLine: {
    fontFamily: 'Menlo',
    fontSize: 12,
    color: '#c00',
  },
});
