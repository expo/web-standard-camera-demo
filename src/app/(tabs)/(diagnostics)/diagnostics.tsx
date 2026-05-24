import { useFocusEffect } from 'expo-router';
import * as React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import {
  JS_LOAD_TIME,
  NativeStandardCamera,
  type AuthorizationStatus,
  type NativeDiagnostics,
} from '../../../../modules/standard-camera';

// Read-only diagnostics. Answers two questions that came up while debugging
// the demo on a physical device:
//   1. What code is the device actually running? Native and JS revisions are
//      surfaced separately so we can tell a stale embedded JS bundle running
//      on a fresh binary apart from a Metro-served bundle running on a stale
//      binary.
//   2. Can the camera/microphone be opened without a permission prompt? The
//      permission lookups intentionally do NOT trigger iOS's authorization
//      dialog — they just read AVCaptureDevice.authorizationStatus.

export default function DiagnosticsScreen(): React.JSX.Element {
  const theme = useTheme();
  const [diag, setDiag] = React.useState<NativeDiagnostics | null>(null);
  const [refreshedAt, setRefreshedAt] = React.useState<number>(() => Date.now());

  const refresh = React.useCallback((): void => {
    setDiag(NativeStandardCamera.getDiagnostics());
    setRefreshedAt(Date.now());
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-poll on focus so permissions that the user toggled in Settings are
  // picked up without needing a manual reload.
  useFocusEffect(
    React.useCallback(() => {
      refresh();
    }, [refresh])
  );

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.scrollContent}
      contentInsetAdjustmentBehavior="automatic">
      <Section title="Build">
        <Row label="Native built" value={formatNativeBuild(diag)} />
        <Row label="JS loaded" value={formatTimestamp(JS_LOAD_TIME)} />
        <Row label="Diagnostics read" value={formatTimestamp(refreshedAt)} />
      </Section>

      <Section title="App">
        <Row label="Bundle ID" value={diag?.bundleIdentifier} />
        <Row label="Version" value={formatAppVersion(diag)} />
      </Section>

      <Section title="Device">
        <Row label="Name" value={diag?.deviceName} />
        <Row label="Model" value={diag?.model} />
        <Row
          label="OS"
          value={diag ? `${diag.systemName} ${diag.systemVersion}` : null}
        />
        <Row label="Simulator?" value={diag?.isSimulator == null ? null : diag.isSimulator ? 'yes' : 'no'} />
      </Section>

      <Section title="Permissions (read without prompting)">
        <Row
          label="Camera"
          value={diag?.cameraAuthorization}
          tone={toneForAuth(diag?.cameraAuthorization)}
        />
        <Row
          label="Microphone"
          value={diag?.microphoneAuthorization}
          tone={toneForAuth(diag?.microphoneAuthorization)}
        />
      </Section>

      <View style={styles.note}>
        <Text style={[styles.noteText, { color: theme.textSecondary }]}>
          Native "built" is the executable file's modification time — it changes on every native
          rebuild. JS "loaded" is the time the bundle was last evaluated — it changes on every
          Metro reload (and matches the embedded bundle's baseline when there is no Metro
          connection).
        </Text>
      </View>
    </ScrollView>
  );
}

function toneForAuth(status?: AuthorizationStatus): 'ok' | 'warn' | 'bad' | undefined {
  if (!status) return undefined;
  if (status === 'authorized') return 'ok';
  if (status === 'denied' || status === 'restricted') return 'bad';
  if (status === 'not-determined') return 'warn';
  return undefined;
}

function formatNativeBuild(d: NativeDiagnostics | null): string | null {
  if (!d) return null;
  if (d.executableMtime == null) {
    return 'unknown';
  }
  return formatTimestamp(d.executableMtime * 1000);
}

function formatAppVersion(d: NativeDiagnostics | null): string | null {
  if (!d) return null;
  return d.bundleShortVersion
    ? `${d.bundleShortVersion} (build ${d.bundleVersion || '?'})`
    : `(build ${d.bundleVersion || '?'})`;
}

// Format an instant as e.g. "7:11:27 PM PDT · May 23" — local clock time with
// the user's time-zone abbreviation. The date drops the year when it matches
// the current year so the line stays short.
function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
  const isThisYear = date.getFullYear() === new Date().getFullYear();
  const datePart = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(isThisYear ? {} : { year: 'numeric' }),
  });
  return `${time} · ${datePart}`;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null | undefined;
  tone?: 'ok' | 'warn' | 'bad';
}): React.JSX.Element {
  const theme = useTheme();
  const valueColor =
    tone === 'ok' ? '#16a34a' : tone === 'warn' ? '#ca8a04' : tone === 'bad' ? '#dc2626' : theme.text;
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: valueColor }]} numberOfLines={2}>
        {value ?? '—'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
    gap: 16,
  },
  section: {
    gap: 6,
  },
  sectionTitle: {
    fontFamily: 'Menlo',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionBody: {
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  rowLabel: {
    fontFamily: 'Menlo',
    fontSize: 12,
    width: 120,
  },
  rowValue: {
    flex: 1,
    fontFamily: 'Menlo',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  note: {
    marginTop: 8,
  },
  noteText: {
    fontFamily: 'Menlo',
    fontSize: 11,
    lineHeight: 15,
  },
});
