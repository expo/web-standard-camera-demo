import * as React from 'react';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';
import { useFocusEffect } from 'expo-router';
import { Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useCamera, type CameraConstraints } from '@/contexts/CameraContext';
import { useTheme } from '@/hooks/use-theme';
import { displayFacingMode } from '@/lib/camera-facing';
import { addTestRunStartListener } from '@/lib/camera-run-events';
import { nowMs, round, traceNeuralLens } from '@/lib/neural-lens-trace';
import { Video, type HTMLVideoElement } from '../../../../modules/standard-camera';

// @ref LLP 0000 — Demo screen: the entire surface a developer interacts with
// is the spec-shaped navigator.mediaDevices.getUserMedia + <Video srcObject>.
//
// The control rows below the preview each map 1:1 to a W3C constrainable
// property on `MediaTrackConstraints` — front/back facing → `facingMode`,
// camera picker → `deviceId`, resolution picker → `width` + `height`,
// frame-rate picker → `frameRate`. The picker state lives in CameraContext
// so the Demo tab's WebGPU cube reflects the same constraints; picking any
// value on either tab updates both surfaces.

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
  const { width } = useWindowDimensions();
  const {
    stream,
    status,
    error,
    constraints,
    settings,
    devices,
    facingModeAvailability,
    userStopped,
    externalLocked,
    start,
    stop,
    applyConstraints,
  } = useCamera();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const statusRef = React.useRef(status);
  const streamRef = React.useRef(stream);
  const [screenFocused, setScreenFocused] = React.useState(false);
  const [previewFocusSerial, setPreviewFocusSerial] = React.useState(0);
  const activePreviewStream = screenFocused ? stream : null;
  const previewKey = activePreviewStream
    ? `home-preview-${previewFocusSerial}-${activePreviewStream.id}`
    : `home-preview-${previewFocusSerial}-detached`;

  React.useEffect(() => {
    statusRef.current = status;
    streamRef.current = stream;
  }, [status, stream]);

  // Mirror the context stream onto the local Video element. The element only
  // exists on this screen, so keeping the wiring here avoids the provider
  // needing to know about a DOM-like element.
  //
  // @ref LLP 0012#global-camera-controls — Native tabs can keep inactive
  // routes mounted. Detach the preview while Home is unfocused so another
  // focused route's native preview layer is the only attached <Video>.
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const attachStartedAt = nowMs();
    traceNeuralLens('home-preview-srcobject-start', {
      attaching: activePreviewStream !== null,
      cameraStatus: status,
      focusSerial: previewFocusSerial,
      screenFocused,
    });
    v.srcObject = activePreviewStream;
    if (activePreviewStream) {
      void v.play();
    }
    traceNeuralLens('home-preview-srcobject-done', {
      attaching: activePreviewStream !== null,
      durationMs: round(nowMs() - attachStartedAt),
      focusSerial: previewFocusSerial,
    });
  }, [activePreviewStream, previewFocusSerial, screenFocused, status]);

  // Run-tests deeplink stops the camera so the WPT runner gets a clean slate.
  React.useEffect(() => addTestRunStartListener(() => stop('test-run-start')), [stop]);

  useFocusEffect(
    React.useCallback(() => {
      traceNeuralLens('home-screen-focus', {
        cameraStatus: statusRef.current,
        hasStream: streamRef.current !== null,
      });
      setScreenFocused(true);
      setPreviewFocusSerial((value) => value + 1);
      return () => {
        traceNeuralLens('home-screen-blur', {
          cameraStatus: statusRef.current,
          hasStream: streamRef.current !== null,
        });
        setScreenFocused(false);
      };
    }, [])
  );

  // Focus-scoped auto-start. Native tabs can keep offscreen routes mounted;
  // tying this to focus avoids reopening AVFoundation behind WebXR/ARKit demos.
  useFocusEffect(
    React.useCallback(() => {
      if (userStopped || externalLocked) return undefined;
      if (
        !stream &&
        status !== 'requesting' &&
        status !== 'starting' &&
        status !== 'stopping' &&
        status !== 'error'
      ) {
        void start();
      }
      return undefined;
    }, [externalLocked, start, status, stream, userStopped])
  );

  // @ref LLP 0009#decision — Web browsers can omit `settings.facingMode` for
  // desktop cameras; this demo treats that missing signal as front/self-view.
  // Native iOS still uses the exact AVFoundation direction.
  const activeFacing = displayFacingMode({ constraints, settings });
  const selectedDeviceId = (settings?.deviceId as string | undefined) ?? constraints.deviceId;

  const { frontDevices, backDevices } = React.useMemo(() => {
    const front: MediaDeviceInfo[] = [];
    const back: MediaDeviceInfo[] = [];
    for (const d of devices) {
      const f = facingOfDevice(d.label);
      if (f === 'user') front.push(d);
      else if (f === 'environment') back.push(d);
      else (activeFacing === 'user' ? front : back).push(d);
    }
    return { frontDevices: front, backDevices: back };
  }, [devices, activeFacing]);

  const onPickFacing = React.useCallback(
    (m: 'user' | 'environment') => {
      if (m === activeFacing) return;
      applyConstraints({ facingMode: m });
    },
    [activeFacing, applyConstraints]
  );
  const onPickDevice = React.useCallback(
    (id: string) => {
      if (id === selectedDeviceId) return;
      applyConstraints({ deviceId: id });
    },
    [applyConstraints, selectedDeviceId]
  );
  const onPickResolution = React.useCallback(
    (w: number | undefined, h: number | undefined) => {
      if (constraints.width === w && constraints.height === h) return;
      applyConstraints({ width: w, height: h });
    },
    [applyConstraints, constraints.height, constraints.width]
  );
  const onPickFrameRate = React.useCallback(
    (fr: number | undefined) => {
      if (constraints.frameRate === fr) return;
      applyConstraints({ frameRate: fr });
    },
    [applyConstraints, constraints.frameRate]
  );
  const cameraRunning = status === 'playing';
  const cameraTransitioning =
    status === 'requesting' || status === 'starting' || status === 'stopping';
  const inlineStartStopDisabled = externalLocked || cameraTransitioning;
  const inlineStartStopLabel = externalLocked
    ? 'Camera in use'
    : status === 'requesting' || status === 'starting'
      ? 'Starting...'
      : status === 'stopping'
        ? 'Stopping...'
        : cameraRunning
          ? 'Stop camera'
          : 'Start camera';
  const onToggleCamera = React.useCallback((): void => {
    if (inlineStartStopDisabled) return;
    if (cameraRunning) {
      stop('home-inline');
    } else {
      void start();
    }
  }, [cameraRunning, inlineStartStopDisabled, start, stop]);

  const isFront = activeFacing === 'user';
  const backFacingDisabled = facingModeAvailability.environment === 'unavailable';
  const isDesktop = width >= 1040;
  // Web getUserMedia returns frames in the device's natural orientation, so
  // even at a narrow viewport the typical landscape webcam fits a landscape
  // stage. The portrait stage exists for native iOS where the AV sensor is
  // always landscape and the layout rotates the preview to portrait.
  const isWebNarrow = Platform.OS === 'web' && !isDesktop;
  const contentStyle = [
    styles.contentContainer,
    isDesktop ? styles.desktopContentContainer : null,
  ];

  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: theme.background }]}
      contentContainerStyle={contentStyle}
      contentInsetAdjustmentBehavior="automatic">
      <View style={[styles.shell, isDesktop ? styles.desktopShell : null]}>
        <View style={[styles.previewPane, isDesktop ? styles.desktopPreviewPane : null]}>
          <View style={styles.previewHeader}>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              navigator.mediaDevices.getUserMedia → &lt;Video srcObject&gt;
            </Text>
            {Platform.OS === 'web' ? (
              <CameraStartStopButton
                disabled={inlineStartStopDisabled}
                label={inlineStartStopLabel}
                running={cameraRunning}
                theme={theme}
                onPress={onToggleCamera}
              />
            ) : null}
          </View>

          <View
            style={[
              styles.videoContainer,
              isDesktop ? styles.desktopVideoContainer : null,
              isWebNarrow ? styles.webNarrowVideoContainer : null,
            ]}>
            <Video
              key={previewKey}
              ref={videoRef}
              autoplay
              srcObject={activePreviewStream}
              style={[styles.video, isFront ? styles.mirroredVideo : null]}
            />
          </View>
        </View>

        <View style={[styles.settingsPane, isDesktop ? styles.desktopSettingsPane : null]}>
          <ControlRow label="Facing" theme={theme} desktop={isDesktop}>
            <FacingPill mode="user" selected={isFront} theme={theme} onPick={onPickFacing} label="Front" />
            <FacingPill
              disabled={backFacingDisabled}
              mode="environment"
              selected={!isFront}
              theme={theme}
              onPick={onPickFacing}
              label="Back"
            />
          </ControlRow>

          {frontDevices.length > 0 ? (
            <ControlRow label="Front camera" theme={theme} desktop={isDesktop}>
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
            <ControlRow label="Back camera" theme={theme} desktop={isDesktop}>
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

          <ControlRow label="Resolution" theme={theme} desktop={isDesktop}>
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

          <ControlRow label="Frame rate" theme={theme} desktop={isDesktop}>
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

          <View
            style={[
              styles.statusBlock,
              isDesktop ? [styles.desktopStatusBlock, { backgroundColor: theme.backgroundElement }] : null,
            ]}>
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
        </View>
      </View>
    </ScrollView>
  );
}

type Theme = { text: string; textSecondary: string; backgroundElement: string };

const START_STOP_ICON: Record<
  'play' | 'stop',
  { android: AndroidSymbol; ios: SFSymbol; web: AndroidSymbol }
> = {
  play: { android: 'play_arrow', ios: 'play.fill', web: 'play_arrow' },
  stop: { android: 'stop', ios: 'stop.fill', web: 'stop' },
};

const STOP_TINT = '#ff453a';
const START_STOP_BUTTON_WIDTH = 146;

function CameraStartStopButton({
  disabled,
  label,
  running,
  theme,
  onPress,
}: {
  disabled: boolean;
  label: string;
  running: boolean;
  theme: Theme;
  onPress: () => void;
}): React.JSX.Element {
  const tintColor = running ? STOP_TINT : theme.text;
  const icon = START_STOP_ICON[running ? 'stop' : 'play'];
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID="standard-camera-start-stop"
      style={({ pressed }) => [
        styles.startStopButton,
        { backgroundColor: theme.backgroundElement },
        disabled ? styles.startStopButtonDisabled : null,
        pressed && !disabled ? styles.startStopButtonPressed : null,
      ]}>
      <View style={styles.startStopIconSlot}>
        <SymbolView
          fallback={<Text style={[styles.startStopFallback, { color: tintColor }]}>{running ? 'S' : 'P'}</Text>}
          name={icon}
          size={18}
          tintColor={tintColor}
        />
      </View>
      <Text numberOfLines={1} style={[styles.startStopText, { color: tintColor }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const ControlRow = React.memo(function ControlRow({
  label,
  theme,
  desktop,
  children,
}: {
  label: string;
  theme: Theme;
  desktop?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.controlRow}>
      <Text style={[styles.controlLabel, { color: theme.textSecondary }]}>{label}</Text>
      {desktop ? (
        <View style={styles.pillWrap}>{children}</View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pillRow}>
          {children}
        </ScrollView>
      )}
    </View>
  );
});

const FacingPill = React.memo(function FacingPill({
  disabled,
  mode,
  label,
  selected,
  theme,
  onPick,
}: {
  disabled?: boolean;
  mode: 'user' | 'environment';
  label: string;
  selected: boolean;
  theme: Theme;
  onPick: (m: 'user' | 'environment') => void;
}): React.JSX.Element {
  return (
    <PillBase
      disabled={disabled}
      label={label}
      selected={selected}
      theme={theme}
      onPress={() => onPick(mode)}
    />
  );
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
  disabled,
  label,
  selected,
  theme,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  selected: boolean;
  theme: Theme;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: selected ? theme.text : theme.backgroundElement,
          opacity: disabled ? 0.42 : pressed ? 0.7 : 1,
        },
      ]}>
      <Text style={[styles.pillText, { color: selected ? theme.backgroundElement : theme.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

// Re-export the constraints type so consumers (e.g. test harness) can keep
// referring to the same shape without reaching into contexts directly.
export type { CameraConstraints };

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    gap: 14,
    paddingBottom: 32,
  },
  desktopContentContainer: {
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
    padding: 32,
    paddingBottom: 48,
  },
  shell: {
    gap: 14,
  },
  desktopShell: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 28,
  },
  previewPane: {
    gap: 14,
  },
  desktopPreviewPane: {
    flex: 1.7,
    minWidth: 0,
  },
  settingsPane: {
    gap: 14,
  },
  desktopSettingsPane: {
    flex: 1,
    minWidth: 280,
  },
  subtitle: {
    flexShrink: 1,
    fontSize: 13,
    fontFamily: 'Menlo',
  },
  previewHeader: {
    minHeight: 36,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  startStopButton: {
    width: START_STOP_BUTTON_WIDTH,
    minHeight: 36,
    borderRadius: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  startStopIconSlot: {
    alignItems: 'center',
    flexShrink: 0,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  startStopButtonDisabled: {
    opacity: 0.55,
  },
  startStopButtonPressed: {
    opacity: 0.72,
  },
  startStopFallback: {
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 13,
  },
  startStopText: {
    flex: 1,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 15,
    textAlign: 'left',
  },
  videoContainer: {
    aspectRatio: 3 / 4,
    backgroundColor: '#111',
    borderRadius: 12,
    overflow: 'hidden',
  },
  desktopVideoContainer: {
    width: '100%',
    maxWidth: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 10,
  },
  webNarrowVideoContainer: {
    aspectRatio: 4 / 3,
  },
  video: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
  // Spec idiom for mirroring a preview: `transform: scaleX(-1)` on the video
  // element itself. The Video component honours this on both platforms — web
  // renders it as a CSS transform on the underlying <video> and iOS forwards
  // it onto the AVCaptureVideoPreviewLayer.
  mirroredVideo: {
    transform: [{ scaleX: -1 }],
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
  pillWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
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
  desktopStatusBlock: {
    borderRadius: 10,
    padding: 12,
    marginTop: 2,
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
