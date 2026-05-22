import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';

// @ref LLP 0007 — In-app WPT-style test runner screen.
// Renders one shared <Video> element. Tests reset its srcObject between runs.
// Output: WPT_RESULT / WPT_DONE lines emitted to console for the CLI driver.

import { Video, type HTMLVideoElement, testing } from '../../modules/standard-camera';

type Result = testing.TestResult;

export default function RunTestsScreen(): React.JSX.Element {
  const theme = useTheme();
  const params = useLocalSearchParams<{ autorun?: string }>();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [results, setResults] = React.useState<Result[]>([]);
  const [running, setRunning] = React.useState(false);
  const [summary, setSummary] = React.useState<string>('');

  const run = React.useCallback(async () => {
    if (!videoRef.current) return;
    setRunning(true);
    setResults([]);
    setSummary('');
    const out = await testing.runAllTests({ video: videoRef.current });
    setResults(out);
    const passed = out.filter((r) => r.status === 'pass').length;
    const failed = out.filter((r) => r.status === 'fail').length;
    const timeout = out.filter((r) => r.status === 'timeout').length;
    setSummary(`${passed} passed, ${failed} failed, ${timeout} timeout`);
    setRunning(false);
  }, []);

  // @ref LLP 0007#triggering — Deep-link query param triggers auto-run.
  React.useEffect(() => {
    if (params.autorun === '1' && !running && results.length === 0) {
      void run();
    }
  }, [params.autorun, run, running, results.length]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]} edges={['top', 'left', 'right']}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
        contentInsetAdjustmentBehavior="automatic">
        <Text style={[styles.title, { color: theme.text }]}>WPT runner</Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          {testing.getRegisteredTestCount()} tests registered
        </Text>

        <View style={styles.videoSlot}>
          <Video ref={videoRef} style={styles.video} />
        </View>

        <View style={styles.controls}>
          <Button title={running ? 'Running…' : 'Run tests'} onPress={run} disabled={running} />
        </View>

        {summary ? <Text style={[styles.summary, { color: theme.text }]}>{summary}</Text> : null}

        <View style={styles.resultsList}>
          {results.map((r) => (
            <ResultRow key={r.name} result={r} textColor={theme.text} mutedColor={theme.textSecondary} />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function ResultRow({
  result,
  textColor,
  mutedColor,
}: {
  result: Result;
  textColor: string;
  mutedColor: string;
}): React.JSX.Element {
  const color =
    result.status === 'pass'
      ? '#0a0'
      : result.status === 'fail'
      ? '#c00'
      : '#a60';
  const glyph = result.status === 'pass' ? '✓' : result.status === 'fail' ? '✗' : '⏱';
  return (
    <View style={styles.row}>
      <Text style={[styles.rowStatus, { color }]}>{glyph}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowName, { color: textColor }]}>{result.name}</Text>
        {result.message ? <Text style={styles.rowMessage}>{result.message}</Text> : null}
      </View>
      <Text style={[styles.rowDuration, { color: mutedColor }]}>{result.durationMs}ms</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    gap: 12,
    paddingBottom: 32,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    fontFamily: 'Menlo',
  },
  videoSlot: {
    width: 120,
    height: 160,
    backgroundColor: '#111',
    borderRadius: 8,
    overflow: 'hidden',
  },
  video: {
    flex: 1,
  },
  controls: {
    flexDirection: 'row',
  },
  summary: {
    fontFamily: 'Menlo',
    fontSize: 14,
    fontWeight: '600',
  },
  resultsList: {
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  rowStatus: {
    fontFamily: 'Menlo',
    fontSize: 14,
    width: 16,
  },
  rowName: {
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  rowMessage: {
    fontFamily: 'Menlo',
    fontSize: 11,
    color: '#c00',
    marginTop: 2,
  },
  rowDuration: {
    fontFamily: 'Menlo',
    fontSize: 11,
  },
});
