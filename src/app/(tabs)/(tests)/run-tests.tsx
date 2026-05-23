import { useFocusEffect } from 'expo-router';
import * as Linking from 'expo-linking';
import * as React from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { notifyTestRunStart } from '@/lib/camera-run-events';

// @ref LLP 0007 — In-app WPT-style test runner screen.
// Pre-renders the full registered test list so users can see what's about to
// run, then transitions each row from pending → running → result as the suite
// executes. Output: WPT_RESULT / WPT_DONE lines emitted to console for the CLI driver.

import { Video, type HTMLVideoElement, testing } from '../../../../modules/standard-camera';
import { installTestGlobals, resetTestGlobals } from '../../../../modules/standard-camera/src/testing/globals';
import NativeStandardCamera from '../../../../modules/standard-camera/src/native';

type Status = 'pending' | 'running' | 'pass' | 'fail' | 'timeout' | 'skip';

interface Row {
  name: string;
  source: string | null;
  group: string | null;
  status: Status;
  message?: string;
  durationMs?: number;
}

export default function RunTestsScreen(): React.JSX.Element {
  const theme = useTheme();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [rows, setRows] = React.useState<Row[]>(() => initialRows());
  const [running, setRunning] = React.useState(false);
  const [completed, setCompleted] = React.useState(0);

  const total = rows.length;

  const run = React.useCallback(async () => {
    if (!videoRef.current) return;
    notifyTestRunStart();
    setRunning(true);
    // Reset every row back to 'pending' so a re-run starts fresh.
    setRows((prev) => prev.map((r) => ({ ...r, status: 'pending', message: undefined, durationMs: undefined })));
    setCompleted(0);
    NativeStandardCamera.__systemLogForTesting?.('WPT_START');
    installTestGlobals(videoRef.current);

    await testing.runAllTests(undefined, {
      resetEnvironment: resetTestGlobals,
      onStart: (entry, i) => {
        setRows((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: 'running' };
          return next;
        });
      },
      onResult: (result, i) => {
        setRows((prev) => {
          const next = [...prev];
          next[i] = {
            name: result.name,
            source: result.source,
            group: result.group,
            status: result.status,
            message: result.message,
            durationMs: result.durationMs,
          };
          return next;
        });
        setCompleted(i + 1);
      },
    });
    setRunning(false);
  }, []);

  // Auto-run: focused route AND URL has autorun=1 (see test:ios CLI).
  const url = Linking.useLinkingURL();
  const [isFocused, setIsFocused] = React.useState(false);
  useFocusEffect(
    React.useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, [])
  );
  const ranOnceRef = React.useRef(false);
  React.useEffect(() => {
    if (!isFocused || ranOnceRef.current) return;
    if (url && /[?&]autorun=1\b/.test(url)) {
      ranOnceRef.current = true;
      void run();
    }
  }, [isFocused, url, run]);

  const groups = React.useMemo(() => groupRows(rows), [rows]);
  const counts = React.useMemo(() => countByStatus(rows), [rows]);
  const progressPct = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <ScrollView
      style={[styles.scrollView, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.contentContainer}
      contentInsetAdjustmentBehavior="automatic">
      <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
        {total} tests across {groups.length} {groups.length === 1 ? 'file' : 'files'}
      </Text>

      <View style={styles.videoSlot}>
        <Video ref={videoRef} style={styles.video} />
      </View>

      <View style={styles.controls}>
        <Button title={running ? 'Running…' : 'Run tests'} onPress={run} disabled={running} />
      </View>

      <View style={styles.progressBlock}>
        <View style={styles.progressBarOuter}>
          <View
            style={[
              styles.progressBarInner,
              { width: `${progressPct}%`, backgroundColor: theme.text },
            ]}
          />
        </View>
        <Text style={[styles.progressText, { color: theme.text }]}>
          {completed} / {total} · {counts.pass} pass · {counts.fail} fail
          {counts.timeout > 0 ? ` · ${counts.timeout} timeout` : ''}
          {counts.skip > 0 ? ` · ${counts.skip} skip` : ''}
        </Text>
      </View>

      <View style={styles.resultsList}>
        {groups.map((group) => (
          <GroupSection
            key={group.key}
            group={group}
            textColor={theme.text}
            mutedColor={theme.textSecondary}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function initialRows(): Row[] {
  return testing.getRegisteredTests().map((t) => ({
    name: t.name,
    source: t.source,
    group: t.group,
    status: 'pending' as Status,
  }));
}

interface RowGroup {
  key: string;
  label: string;
  isWpt: boolean;
  rows: Row[];
}

function groupRows(rows: Row[]): RowGroup[] {
  const map = new Map<string, RowGroup>();
  for (const r of rows) {
    const isWpt = r.source != null;
    const key = isWpt ? r.source! : (r.group ?? 'Project-local');
    let group = map.get(key);
    if (!group) {
      group = { key, label: key, isWpt, rows: [] };
      map.set(key, group);
    }
    group.rows.push(r);
  }
  return [...map.values()].sort((a, b) => {
    if (a.isWpt && !b.isWpt) return -1;
    if (!a.isWpt && b.isWpt) return 1;
    return a.label.localeCompare(b.label);
  });
}

function countByStatus(rows: Row[]): Record<Status, number> {
  const counts: Record<Status, number> = { pending: 0, running: 0, pass: 0, fail: 0, timeout: 0, skip: 0 };
  for (const r of rows) {
    counts[r.status]++;
  }
  return counts;
}

function GroupSection({
  group,
  textColor,
  mutedColor,
}: {
  group: RowGroup;
  textColor: string;
  mutedColor: string;
}): React.JSX.Element {
  const counts = countByStatus(group.rows);
  const done = group.rows.length - counts.pending - counts.running;
  return (
    <View style={styles.group}>
      <View style={styles.groupHeader}>
        {group.isWpt && (
          <View style={styles.wptBadge}>
            <Text style={styles.wptBadgeText}>WPT</Text>
          </View>
        )}
        <Text style={[styles.groupLabel, { color: textColor }]} numberOfLines={1}>
          {group.label}
        </Text>
        <Text style={[styles.groupCounts, { color: mutedColor }]}>
          {done}/{group.rows.length}
          {counts.fail ? ` · ${counts.fail} fail` : ''}
          {counts.timeout ? ` · ${counts.timeout} timeout` : ''}
          {counts.skip ? ` · ${counts.skip} skip` : ''}
        </Text>
      </View>
      {group.rows.map((r, i) => (
        <ResultRow key={`${group.key}::${i}`} row={r} textColor={textColor} mutedColor={mutedColor} />
      ))}
    </View>
  );
}

function ResultRow({
  row,
  textColor,
  mutedColor,
}: {
  row: Row;
  textColor: string;
  mutedColor: string;
}): React.JSX.Element {
  const color = STATUS_COLOR[row.status];
  const glyph = STATUS_GLYPH[row.status];
  const nameColor = row.status === 'pending' ? mutedColor : textColor;
  const messageColor = STATUS_MESSAGE_COLOR[row.status];
  return (
    <View style={styles.row}>
      <Text style={[styles.rowStatus, { color }]}>{glyph}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowName, { color: nameColor }]}>{row.name}</Text>
        {row.message ? (
          <Text style={[styles.rowMessage, { color: messageColor }]}>{row.message}</Text>
        ) : null}
      </View>
      {row.durationMs !== undefined ? (
        <Text style={[styles.rowDuration, { color: mutedColor }]}>{row.durationMs}ms</Text>
      ) : null}
    </View>
  );
}

const STATUS_COLOR: Record<Status, string> = {
  pending: '#666',
  running: '#1d4ed8',
  pass: '#0a0',
  fail: '#c00',
  timeout: '#a60',
  skip: '#888',
};

// Color for the per-row message line under failing/skipped/timing-out tests.
// Skips get a calm blue so they don't read as regressions; timeouts use the
// same amber as the glyph; fails stay red.
const STATUS_MESSAGE_COLOR: Record<Status, string> = {
  pending: '#666',
  running: '#1d4ed8',
  pass: '#0a0',
  fail: '#c00',
  timeout: '#a16207',
  skip: '#2563eb',
};

const STATUS_GLYPH: Record<Status, string> = {
  pending: '○',
  running: '▸',
  pass: '✓',
  fail: '✗',
  timeout: '⏱',
  skip: '↷',
};

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    gap: 12,
    paddingBottom: 32,
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
  progressBlock: {
    gap: 4,
  },
  progressBarOuter: {
    height: 4,
    backgroundColor: '#e5e7eb',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarInner: {
    height: '100%',
  },
  progressText: {
    fontFamily: 'Menlo',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  resultsList: {
    gap: 14,
  },
  group: {
    gap: 4,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    marginBottom: 2,
  },
  wptBadge: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  wptBadgeText: {
    color: '#fff',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  groupLabel: {
    flex: 1,
    fontFamily: 'Menlo',
    fontSize: 12,
    fontWeight: '600',
  },
  groupCounts: {
    fontFamily: 'Menlo',
    fontSize: 10,
    fontVariant: ['tabular-nums'],
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
    marginTop: 2,
  },
  rowDuration: {
    fontFamily: 'Menlo',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});
