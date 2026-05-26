import * as React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { JS_BUILD_TIME } from '../../../../modules/standard-camera';

export default function DiagnosticsScreen(): React.JSX.Element {
  const theme = useTheme();
  const [cameraPermission, setCameraPermission] = React.useState<string>('unknown');
  const [microphonePermission, setMicrophonePermission] = React.useState<string>('unknown');

  React.useEffect(() => {
    const permissions = globalThis.navigator?.permissions;
    if (!permissions?.query) return;
    void permissions.query({ name: 'camera' as PermissionName }).then(
      (status) => setCameraPermission(status.state),
      () => setCameraPermission('unknown')
    );
    void permissions.query({ name: 'microphone' as PermissionName }).then(
      (status) => setMicrophonePermission(status.state),
      () => setMicrophonePermission('unknown')
    );
  }, []);

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.scrollContent}>
      <Section title="Build">
        <Row label="JS built" value={formatTimestamp(JS_BUILD_TIME)} />
      </Section>

      <Section title="Browser">
        <Row label="Platform" value={globalThis.navigator?.platform} />
        <Row label="User agent" value={globalThis.navigator?.userAgent} />
      </Section>

      <Section title="Permissions (read without prompting)">
        <Row label="Camera" value={cameraPermission} />
        <Row label="Microphone" value={microphonePermission} />
      </Section>
    </ScrollView>
  );
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={3}>
        {value ?? '-'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: 16,
    padding: 16,
    paddingBottom: 32,
  },
  section: {
    gap: 6,
  },
  sectionTitle: {
    fontFamily: 'Menlo',
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  sectionBody: {
    gap: 4,
  },
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
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
  },
});
