import * as React from 'react';
import { Button, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

import { Video, type HTMLVideoElement } from '../../../../modules/standard-camera/src/HTMLVideoElement.web';
import * as testing from '../../../../modules/standard-camera/src/testing/index.web';
import {
  installTestGlobals,
  resetTestFile,
  resetTestGlobals,
} from '../../../../modules/standard-camera/src/testing/globals.web';
import type {
  TestEnvironment,
  TestRequirement,
  TestResult,
  TestStatus,
} from '../../../../modules/standard-camera/src/testing/testharness';

type Status = 'pending' | 'running' | TestStatus;

interface Row {
  name: string;
  source: string | null;
  group: string | null;
  requirement: TestRequirement;
  status: Status;
  message?: string;
  durationMs?: number;
}

function initialRows(): Row[] {
  return testing.getRegisteredTests().map((test) => ({
    name: test.name,
    source: test.source,
    group: test.group,
    requirement: test.requirement,
    status: 'pending',
  }));
}

export default function RunTestsScreen(): React.JSX.Element {
  const theme = useTheme();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const [rows, setRows] = React.useState<Row[]>(() => initialRows());
  const [environment, setEnvironment] = React.useState<TestEnvironment | null>(null);
  const [running, setRunning] = React.useState(false);
  const [completed, setCompleted] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    void testing.detectEnvironment().then((env) => {
      if (!cancelled) setEnvironment(env);
    });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, []);

  const total = rows.length;
  const counts = React.useMemo(() => countRows(rows), [rows]);

  const run = React.useCallback(async () => {
    const video = videoRef.current;
    if (!video || running) return;

    const ac = new AbortController();
    abortRef.current = ac;
    installTestGlobals(video);
    setRunning(true);
    setCompleted(0);
    setRows((previous) =>
      previous.map((row) => ({
        ...row,
        status: 'pending',
        message: undefined,
        durationMs: undefined,
      }))
    );

    try {
      await testing.runAllTests(undefined, {
        forceRunAll: true,
        signal: ac.signal,
        resetEnvironment: resetTestGlobals,
        resetFile: resetTestFile,
        onEnvironment: setEnvironment,
        onStart: (_entry, index) => {
          setRows((previous) => patchRow(previous, index, { status: 'running' }));
        },
        onResult: (result, index) => {
          setRows((previous) => patchRow(previous, index, rowFromResult(result)));
          setCompleted(Math.min(index + 1, total));
        },
      });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running]);

  const stop = React.useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: theme.background }]}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic">
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: theme.text }]}>Tests</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            {environment
              ? `${total} tests running in ${describeEnvironment(environment)}`
              : `${total} registered tests`}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button title={running ? 'Stop' : 'Run tests'} onPress={running ? stop : run} />
        </View>
      </View>

      <View style={[styles.summary, { backgroundColor: theme.backgroundElement }]}>
        <Text style={[styles.summaryText, { color: theme.text }]}>
          {completed} / {total}
        </Text>
        <Text style={[styles.summaryBreakdown, { color: theme.textSecondary }]}>
          {counts.pass} pass · {counts.fail} fail · {counts.timeout} timeout · {counts.skip} skip
        </Text>
      </View>

      <View style={styles.videoSlot}>
        <Video ref={videoRef} style={styles.video} autoplay />
      </View>

      <View style={styles.results}>
        {groupRows(rows).map((group) => (
          <View key={group.key} style={styles.group}>
            <View style={styles.groupHeader}>
              {group.isWpt ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>WPT</Text>
                </View>
              ) : null}
              <Text style={[styles.groupLabel, { color: theme.text }]} numberOfLines={1}>
                {group.label}
              </Text>
            </View>
            {group.rows.map((row, index) => (
              <ResultRow
                key={`${group.key}:${index}`}
                row={row}
                textColor={theme.text}
                mutedColor={theme.textSecondary}
              />
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function patchRow(rows: Row[], index: number, patch: Partial<Row>): Row[] {
  const next = [...rows];
  next[index] = { ...next[index], ...patch };
  return next;
}

function rowFromResult(result: TestResult): Partial<Row> {
  return {
    name: result.name,
    source: result.source,
    group: result.group,
    status: result.status,
    message: result.message,
    durationMs: result.durationMs,
  };
}

function countRows(rows: Row[]): Record<TestStatus, number> {
  const counts: Record<TestStatus, number> = { pass: 0, fail: 0, timeout: 0, skip: 0 };
  for (const row of rows) {
    if (row.status === 'pass' || row.status === 'fail' || row.status === 'timeout' || row.status === 'skip') {
      counts[row.status]++;
    }
  }
  return counts;
}

interface RowGroup {
  key: string;
  label: string;
  isWpt: boolean;
  rows: Row[];
}

function groupRows(rows: Row[]): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const isWpt = row.source != null;
    const key = isWpt ? row.source! : (row.group ?? 'Project-local');
    const group = groups.get(key) ?? { key, label: key, isWpt, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.isWpt && !b.isWpt) return -1;
    if (!a.isWpt && b.isWpt) return 1;
    return a.label.localeCompare(b.label);
  });
}

function describeEnvironment(env: TestEnvironment): string {
  if (env.hasCamera && env.hasMicrophone) return 'this browser';
  if (env.hasCamera) return 'this browser (no microphone)';
  if (env.hasMicrophone) return 'this browser (no camera)';
  return 'this browser (no camera or microphone)';
}

const STATUS_COLOR: Record<Status, string> = {
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

const ResultRow = React.memo(function ResultRow({
  row,
  textColor,
  mutedColor,
}: {
  row: Row;
  textColor: string;
  mutedColor: string;
}): React.JSX.Element {
  const color = STATUS_COLOR[row.status];
  return (
    <View style={styles.row}>
      <Text style={[styles.rowStatus, { color }]}>{STATUS_GLYPH[row.status]}</Text>
      <View style={styles.rowBody}>
        <Text style={[styles.rowName, { color: row.status === 'pending' ? mutedColor : textColor }]}>
          {row.name}
        </Text>
        {row.message ? <Text style={styles.rowMessage}>{row.message}</Text> : null}
      </View>
      {row.durationMs !== undefined ? (
        <Text style={[styles.rowDuration, { color: mutedColor }]}>{row.durationMs}ms</Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    gap: 16,
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  headerText: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  actions: {
    minWidth: 104,
  },
  summary: {
    borderRadius: 8,
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  summaryText: {
    fontFamily: 'Menlo',
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  summaryBreakdown: {
    fontFamily: 'Menlo',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  videoSlot: {
    width: 120,
    height: 90,
    backgroundColor: '#111',
    borderRadius: 8,
    overflow: 'hidden',
  },
  video: {
    height: '100%',
    width: '100%',
  },
  results: {
    gap: 16,
  },
  group: {
    gap: 4,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badge: {
    backgroundColor: '#2563eb',
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  badgeText: {
    color: '#fff',
    fontFamily: 'Menlo',
    fontSize: 9,
    fontWeight: '700',
  },
  groupLabel: {
    flex: 1,
    fontFamily: 'Menlo',
    fontSize: 12,
    fontWeight: '600',
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
  rowBody: {
    flex: 1,
  },
  rowName: {
    fontFamily: 'Menlo',
    fontSize: 12,
  },
  rowMessage: {
    color: '#c00',
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
