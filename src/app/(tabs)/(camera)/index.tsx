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
// property on `MediaTrackConstraints` — front/back facing → `facingMode`,
// camera picker → `deviceId`, resolution picker → `width` + `height`,
// frame-rate picker → `frameRate`. Picking any value re-runs `gUM` with the
// merged constraints; the resulting `track.getSettings()` shown at the
// bottom always reflects what the device actually resolved to.

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

// `label` shortener — `device.localizedName` returns strings like "Back Triple
// Camera" or "Front TrueDepth Camera". Trim the redundant "Camera" suffix and
// the leading position word (which we already convey via the group header).
function shortDeviceLabel(label: string, facing: 'user' | 'environment'): string {
  if (!label) return '(unlabeled)';
  let s = label.replace(/\s*Camera$/i, '').trim();
  const prefix = facing === 'user' ? /^Front\s+/i : /^Back\s+/i;
  s = s.replace(prefix, '').trim();
  return s || (facing === 'user' ? 'Front' : 'Back');
}

function facingOfDevice(label: string): 'user' | 'environment' | null {
  if (/^Front\b/i.test(label)) return 'user';
  if (/^Back\b/i.test(label)) return 'environment';
  return null;
}

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
      setError(null);
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
        // Hot-swap the previous stream's tracks only AFTER the new one has
        // resolved, so the preview never blanks and the on-screen settings
        // never un-render. The brief overlap (~one frame) is invisible.
        const previous = streamRef.current;
        streamRef.current = s;
        setStream(s);
        setSettings(s.getVideoTracks()[0]?.getSettings() ?? null);
        setStatus('starting');
        if (previous) {
          for (const track of previous.getTracks()) track.stop();
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

        // Refresh the device list off the hot-swap path so the pill rows
        // don't reflow while the user is mid-tap.
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          if (mountedRef.current) {
            setDevices(all.filter((d) => d.kind === 'videoinput'));
          }
        } catch {
          // ignore — device list is best-effort.
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

  const applyConstraints = React.useCallback(
    (patch: Partial<Constraints>): void => {
      setConstraints((prev) => {
        const next: Constraints = { ...prev, ...patch };
        if (patch.deviceId) delete next.facingMode;
        if (patch.facingMode) delete next.deviceId;
        void start(next);
        return next;
      });
    },
    [start]
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

  // Resolve the user's current facing intent from explicit state or the
  // resolved track settings. `deviceId` selection can imply either side.
  const explicitFacing: 'user' | 'environment' | null =
    constraints.facingMode ?? (settings?.facingMode as 'user' | 'environment' | undefined) ?? null;

  // Group devices by position so the picker shows two short rows rather than
  // one long mixed list. Devices we can't classify (rare) fall into the side
  // matching the current facing intent.
  const { frontDevices, backDevices } = React.useMemo(() => {
    const front: MediaDeviceInfo[] = [];
    const back: MediaDeviceInfo[] = [];
    for (const d of devices) {
      const f = facingOfDevice(d.label);
      if (f === 'user') front.push(d);
      else if (f === 'environment') back.push(d);
      else (explicitFacing === 'user' ? front : back).push(d);
    }
    return { frontDevices: front, backDevices: back };
  }, [devices, explicitFacing]);

  // Stable callbacks per setting type, so memoized Pills don't re-render when
  // an unrelated row's selection changes.
  const onPickFacing = React.useCallback(
    (m: 'user' | 'environment') => applyConstraints({ facingMode: m }),
    [applyConstraints]
  );
  const onPickDevice = React.useCallback(
    (id: string) => applyConstraints({ deviceId: id }),
    [applyConstraints]
  );
  const onPickResolution = React.useCallback(
    (w: number | undefined, h: number | undefined) => applyConstraints({ width: w, height: h }),
    [applyConstraints]
  );
  const onPickFrameRate = React.useCallback(
    (fr: number | undefined) => applyConstraints({ frameRate: fr }),
    [applyConstraints]
  );

  const isFront = explicitFacing === 'user';
  const selectedDeviceId = (settings?.deviceId as string | undefined) ?? constraints.deviceId;

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
        <FacingPill mode="user" selected={isFront} theme={theme} onPick={onPickFacing} label="Front" />
        <FacingPill mode="environment" selected={!isFront} theme={theme} onPick={onPickFacing} label="Back" />
      </ControlRow>

      {frontDevices.length > 0 ? (
        <ControlRow label="Front camera" theme={theme}>
          {frontDevices.map((d) => (
            <DevicePill
              key={d.deviceId}
              deviceId={d.deviceId}
              label={shortDeviceLabel(d.label, 'user')}
              selected={selectedDeviceId === d.deviceId}
              theme={theme}
              onPick={onPickDevice}
            />
          ))}
        </ControlRow>
      ) : null}

      {backDevices.length > 0 ? (
        <ControlRow label="Back camera" theme={theme}>
          {backDevices.map((d) => (
            <DevicePill
              key={d.deviceId}
              deviceId={d.deviceId}
              label={shortDeviceLabel(d.label, 'environment')}
              selected={selectedDeviceId === d.deviceId}
              theme={theme}
              onPick={onPickDevice}
            />
          ))}
        </ControlRow>
      ) : null}

      <ControlRow label="Resolution" theme={theme}>
        <ResolutionPill
          label="Auto"
          width={undefined}
          height={undefined}
          selected={!constraints.width}
          theme={theme}
          onPick={onPickResolution}
        />
        {RESOLUTION_PRESETS.map((p) => (
          <ResolutionPill
            key={p.label}
            label={p.label}
            width={p.width}
            height={p.height}
            selected={constraints.width === p.width && constraints.height === p.height}
            theme={theme}
            onPick={onPickResolution}
          />
        ))}
      </ControlRow>

      <ControlRow label="Frame rate" theme={theme}>
        <FrameRatePill
          label="Auto"
          rate={undefined}
          selected={!constraints.frameRate}
          theme={theme}
          onPick={onPickFrameRate}
        />
        {FRAME_RATE_PRESETS.map((fr) => (
          <FrameRatePill
            key={fr}
            label={`${fr} fps`}
            rate={fr}
            selected={constraints.frameRate === fr}
            theme={theme}
            onPick={onPickFrameRate}
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

type Theme = { text: string; textSecondary: string; backgroundElement: string };

const ControlRow = React.memo(function ControlRow({
  label,
  theme,
  children,
}: {
  label: string;
  theme: Theme;
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
});

// Pill variants take callback + value rather than an inline onPress, so the
// memoized children don't re-render when an unrelated row updates.
const FacingPill = React.memo(function FacingPill({
  mode,
  label,
  selected,
  theme,
  onPick,
}: {
  mode: 'user' | 'environment';
  label: string;
  selected: boolean;
  theme: Theme;
  onPick: (m: 'user' | 'environment') => void;
}): React.JSX.Element {
  return <PillBase label={label} selected={selected} theme={theme} onPress={() => onPick(mode)} />;
});

const DevicePill = React.memo(function DevicePill({
  deviceId,
  label,
  selected,
  theme,
  onPick,
}: {
  deviceId: string;
  label: string;
  selected: boolean;
  theme: Theme;
  onPick: (id: string) => void;
}): React.JSX.Element {
  return <PillBase label={label} selected={selected} theme={theme} onPress={() => onPick(deviceId)} />;
});

const ResolutionPill = React.memo(function ResolutionPill({
  label,
  width,
  height,
  selected,
  theme,
  onPick,
}: {
  label: string;
  width: number | undefined;
  height: number | undefined;
  selected: boolean;
  theme: Theme;
  onPick: (w: number | undefined, h: number | undefined) => void;
}): React.JSX.Element {
  return <PillBase label={label} selected={selected} theme={theme} onPress={() => onPick(width, height)} />;
});

const FrameRatePill = React.memo(function FrameRatePill({
  label,
  rate,
  selected,
  theme,
  onPick,
}: {
  label: string;
  rate: number | undefined;
  selected: boolean;
  theme: Theme;
  onPick: (r: number | undefined) => void;
}): React.JSX.Element {
  return <PillBase label={label} selected={selected} theme={theme} onPress={() => onPick(rate)} />;
});

function PillBase({
  label,
  selected,
  theme,
  onPress,
}: {
  label: string;
  selected: boolean;
  theme: Theme;
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
      <Text style={[styles.pillText, { color: selected ? theme.backgroundElement : theme.text }]}>
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
