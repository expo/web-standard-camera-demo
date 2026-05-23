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

// Module-scoped instrumentation. We separate JS-counted events (renders,
// callbacks, computations) from React Profiler data (per-region actual + base
// commit time, mount vs update breakdown) so we can attribute jank either way:
// a high `updateCount` with low `totalActualMs` means React isn't the
// bottleneck — the JS thread is busy elsewhere. A high `totalActualMs` means
// React renders are the cost.
//
// `actualDuration` is the time React spent rendering this commit, accounting
// for `memo` skips. `baseDuration` is the *estimated* time it would take to
// render every node in the tree from scratch — comparing the two shows the
// memo wins (or lack thereof) per region.

interface ProfileStats {
  mountCount: number;
  updateCount: number;
  totalActualMs: number;
  totalBaseMs: number;
  maxActualMs: number;
}

function emptyStats(): ProfileStats {
  return { mountCount: 0, updateCount: 0, totalActualMs: 0, totalBaseMs: 0, maxActualMs: 0 };
}

const perf = {
  screenRenders: 0,
  rowRenders: 0,
  groupSectionRenders: 0,
  groupRowsCalls: 0,
  groupRowsTotalMs: 0,
  countByStatusCalls: 0,
  countByStatusTotalMs: 0,
  onStartCalls: 0,
  onResultCalls: 0,
  setRowsCommits: 0,
  setCompletedCommits: 0,
  profiles: new Map<string, ProfileStats>(),
};

function perfReset(): void {
  perf.screenRenders = 0;
  perf.rowRenders = 0;
  perf.groupSectionRenders = 0;
  perf.groupRowsCalls = 0;
  perf.groupRowsTotalMs = 0;
  perf.countByStatusCalls = 0;
  perf.countByStatusTotalMs = 0;
  perf.onStartCalls = 0;
  perf.onResultCalls = 0;
  perf.setRowsCommits = 0;
  perf.setCompletedCommits = 0;
  perf.profiles.clear();
}

function onProfilerRender(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number
): void {
  let s = perf.profiles.get(id);
  if (!s) {
    s = emptyStats();
    perf.profiles.set(id, s);
  }
  if (phase === 'mount') s.mountCount++;
  else s.updateCount++;
  s.totalActualMs += actualDuration;
  s.totalBaseMs += baseDuration;
  if (actualDuration > s.maxActualMs) s.maxActualMs = actualDuration;
}

function perfDump(label: string): void {
  const profiles: Record<string, ProfileStats & { avgActualMs: number; speedup: number }> = {};
  for (const [id, s] of perf.profiles) {
    const commits = s.mountCount + s.updateCount;
    profiles[id] = {
      ...s,
      avgActualMs: commits > 0 ? +(s.totalActualMs / commits).toFixed(2) : 0,
      // baseDuration / actualDuration ≈ how much memo + React's bailouts
      // saved. >1 means memo is helping; ≈1 means every node had to re-render.
      speedup: s.totalActualMs > 0 ? +(s.totalBaseMs / s.totalActualMs).toFixed(2) : 0,
    };
    profiles[id].totalActualMs = +s.totalActualMs.toFixed(2);
    profiles[id].totalBaseMs = +s.totalBaseMs.toFixed(2);
    profiles[id].maxActualMs = +s.maxActualMs.toFixed(2);
  }
  // eslint-disable-next-line no-console
  console.log(
    `PERF ${label}: ${JSON.stringify({
      screenRenders: perf.screenRenders,
      rowRenders: perf.rowRenders,
      groupSectionRenders: perf.groupSectionRenders,
      groupRowsCalls: perf.groupRowsCalls,
      groupRowsAvgMs:
        perf.groupRowsCalls > 0 ? +(perf.groupRowsTotalMs / perf.groupRowsCalls).toFixed(2) : 0,
      countByStatusCalls: perf.countByStatusCalls,
      countByStatusAvgMs:
        perf.countByStatusCalls > 0
          ? +(perf.countByStatusTotalMs / perf.countByStatusCalls).toFixed(2)
          : 0,
      onStartCalls: perf.onStartCalls,
      onResultCalls: perf.onResultCalls,
      setRowsCommits: perf.setRowsCommits,
      setCompletedCommits: perf.setCompletedCommits,
      profiles,
    })}`
  );
}

const now = (): number => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export default function RunTestsScreen(): React.JSX.Element {
  perf.screenRenders++;
  const theme = useTheme();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [rows, setRows] = React.useState<Row[]>(() => initialRows());
  const [running, setRunning] = React.useState(false);
  const [completed, setCompleted] = React.useState(0);

  const total = rows.length;

  // Buffered update path. `onStart` / `onResult` write the row patch into a
  // ref-backed Map (very cheap — no setState, no render). A timer drains the
  // Map into a single `setRows` every 100ms, so a 60s suite that previously
  // produced 520+ commits collapses into ~600 / 6 ≈ ~100 commits, and the
  // env-skip burst at t=0–4s (which used to spike 15 commits/sec) collapses
  // into one commit per flush interval.
  const pendingUpdatesRef = React.useRef<Map<number, Partial<Row>>>(new Map());
  const pendingMaxCompletedRef = React.useRef(0);
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const FLUSH_INTERVAL_MS = 100;

  const flushPending = React.useCallback(() => {
    flushTimerRef.current = null;
    const updates = pendingUpdatesRef.current;
    if (updates.size === 0) return;
    pendingUpdatesRef.current = new Map();
    const maxCompleted = pendingMaxCompletedRef.current;
    React.startTransition(() => {
      setRows((prev) => {
        const next = [...prev];
        for (const [i, patch] of updates) {
          next[i] = { ...next[i], ...patch };
        }
        return next;
      });
      perf.setRowsCommits++;
      setCompleted((c) => (maxCompleted > c ? maxCompleted : c));
      perf.setCompletedCommits++;
    });
  }, []);

  const scheduleFlush = React.useCallback(() => {
    if (flushTimerRef.current != null) return;
    flushTimerRef.current = setTimeout(flushPending, FLUSH_INTERVAL_MS);
  }, [flushPending]);

  const run = React.useCallback(async () => {
    if (!videoRef.current) return;
    perfReset();
    const t0 = now();
    notifyTestRunStart();
    setRunning(true);
    // Reset every row back to 'pending' so a re-run starts fresh.
    setRows((prev) => prev.map((r) => ({ ...r, status: 'pending', message: undefined, durationMs: undefined })));
    perf.setRowsCommits++;
    setCompleted(0);
    perf.setCompletedCommits++;
    pendingUpdatesRef.current.clear();
    pendingMaxCompletedRef.current = 0;
    NativeStandardCamera.__systemLogForTesting?.('WPT_START');
    installTestGlobals(videoRef.current);

    // Periodic mid-run dump so we can see the rate of renders without waiting
    // for the suite to finish.
    const periodicId = setInterval(() => perfDump(`tick t=${Math.round(now() - t0)}ms`), 1000);

    await testing.runAllTests(undefined, {
      resetEnvironment: resetTestGlobals,
      onStart: (entry, i) => {
        perf.onStartCalls++;
        const prev = pendingUpdatesRef.current.get(i);
        pendingUpdatesRef.current.set(i, { ...prev, status: 'running' });
        scheduleFlush();
      },
      onResult: (result, i) => {
        perf.onResultCalls++;
        pendingUpdatesRef.current.set(i, {
          name: result.name,
          source: result.source,
          group: result.group,
          status: result.status,
          message: result.message,
          durationMs: result.durationMs,
        });
        if (i + 1 > pendingMaxCompletedRef.current) {
          pendingMaxCompletedRef.current = i + 1;
        }
        scheduleFlush();
      },
    });
    clearInterval(periodicId);
    // Drain any pending updates before declaring the suite done so the final
    // row state matches WPT_DONE.
    if (flushTimerRef.current != null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    flushPending();
    setRunning(false);
    perfDump(`done t=${Math.round(now() - t0)}ms`);
  }, [flushPending, scheduleFlush]);

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

  const groups = React.useMemo(() => {
    const t0 = now();
    const out = groupRows(rows);
    perf.groupRowsCalls++;
    perf.groupRowsTotalMs += now() - t0;
    return out;
  }, [rows]);
  const counts = React.useMemo(() => {
    const t0 = now();
    const out = countByStatus(rows);
    perf.countByStatusCalls++;
    perf.countByStatusTotalMs += now() - t0;
    return out;
  }, [rows]);
  const progressPct = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <React.Profiler id="screen" onRender={onProfilerRender}>
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

        <React.Profiler id="results" onRender={onProfilerRender}>
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
        </React.Profiler>
      </ScrollView>
    </React.Profiler>
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

// Cache the previous result so groups whose contained rows are referentially
// identical reuse the same `RowGroup` object (and the same inner `rows`
// array). `React.memo` on `GroupSection` then short-circuits on every commit
// except for the one or two groups that actually changed. Without this, every
// commit reconstructs ~50 fresh `RowGroup` objects and memo always misses.
let prevRowsInput: Row[] | null = null;
let prevGroupsByKey: Map<string, RowGroup> | null = null;
let prevSortedGroups: RowGroup[] = [];

function groupRows(rows: Row[]): RowGroup[] {
  if (rows === prevRowsInput && prevGroupsByKey) return prevSortedGroups;

  // Bucket the rows by source / group.
  const nextRowsByKey = new Map<string, Row[]>();
  const nextIsWptByKey = new Map<string, boolean>();
  for (const r of rows) {
    const isWpt = r.source != null;
    const key = isWpt ? r.source! : (r.group ?? 'Project-local');
    let arr = nextRowsByKey.get(key);
    if (!arr) {
      arr = [];
      nextRowsByKey.set(key, arr);
      nextIsWptByKey.set(key, isWpt);
    }
    arr.push(r);
  }

  // For each bucket, reuse the previous RowGroup (and its `rows` array) if
  // every row reference matches; otherwise build a fresh one. The reused path
  // is what lets React.memo skip unchanged sections.
  const nextGroupsByKey = new Map<string, RowGroup>();
  for (const [key, nextRowList] of nextRowsByKey) {
    const isWpt = nextIsWptByKey.get(key) ?? false;
    const prev = prevGroupsByKey?.get(key);
    if (
      prev &&
      prev.rows.length === nextRowList.length &&
      prev.isWpt === isWpt &&
      rowArraysIdentical(prev.rows, nextRowList)
    ) {
      nextGroupsByKey.set(key, prev);
    } else {
      nextGroupsByKey.set(key, { key, label: key, isWpt, rows: nextRowList });
    }
  }

  const sorted = [...nextGroupsByKey.values()].sort((a, b) => {
    if (a.isWpt && !b.isWpt) return -1;
    if (!a.isWpt && b.isWpt) return 1;
    return a.label.localeCompare(b.label);
  });

  prevRowsInput = rows;
  prevGroupsByKey = nextGroupsByKey;
  prevSortedGroups = sorted;
  return sorted;
}

function rowArraysIdentical(a: Row[], b: Row[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function countByStatus(rows: Row[]): Record<Status, number> {
  const counts: Record<Status, number> = { pending: 0, running: 0, pass: 0, fail: 0, timeout: 0, skip: 0 };
  for (const r of rows) {
    counts[r.status]++;
  }
  return counts;
}

// Memoized so an unrelated section's row flip doesn't re-render every other
// section header. `group.rows` is a stable reference when none of the rows
// in that group changed (the run-loop's setRows updater shallow-clones the
// top-level array but reuses each unchanged group's row references), so
// memo's shallow equality short-circuits cleanly.
const GroupSection = React.memo(function GroupSection({
  group,
  textColor,
  mutedColor,
}: {
  group: RowGroup;
  textColor: string;
  mutedColor: string;
}): React.JSX.Element {
  perf.groupSectionRenders++;
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
});

// Memoized so the 250+ rows that *didn't* change on a given setState don't
// re-render. The `setRows` updaters in `run` build a new `rows` array but
// keep the unchanged row objects by reference, so `React.memo`'s shallow
// equality short-circuits everything except the row whose status flipped.
const ResultRow = React.memo(function ResultRow({
  row,
  textColor,
  mutedColor,
}: {
  row: Row;
  textColor: string;
  mutedColor: string;
}): React.JSX.Element {
  perf.rowRenders++;
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
});

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
