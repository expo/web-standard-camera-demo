import { Stack, useFocusEffect } from 'expo-router';
import { GlassContainer, GlassView } from 'expo-glass-effect';
import * as Linking from 'expo-linking';
import * as React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button as UIButton, Host } from '@expo/ui/swift-ui';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { useTheme } from '@/hooks/use-theme';
import { notifyTestRunStart } from '@/lib/camera-run-events';

// @ref LLP 0007 — In-app WPT-style test runner screen.
// Pre-renders the full registered test list so users can see what's about to
// run, then transitions each row from pending → running → result as the suite
// executes. Output: WPT_RESULT / WPT_DONE lines emitted to console for the CLI driver.

import { Video, type HTMLVideoElement, testing } from '../../../../modules/standard-camera';
import { installTestGlobals, resetTestFile, resetTestGlobals } from '../../../../modules/standard-camera/src/testing/globals';
import NativeStandardCamera from '../../../../modules/standard-camera/src/native';
import type {
  TestEnvironment,
  TestRequirement,
} from '../../../../modules/standard-camera/src/testing/testharness';

type Status = 'pending' | 'running' | 'pass' | 'fail' | 'timeout' | 'skip';

interface Row {
  name: string;
  source: string | null;
  group: string | null;
  requirement: TestRequirement;
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
  // Detected once on focus (via `enumerateDevices`), then refreshed at the
  // start of every run. Drives the "X applicable / Y total" header so users
  // on the simulator don't see a high skip count and assume the suite is
  // broken — it just isn't relevant to a device-less host.
  const [environment, setEnvironment] = React.useState<TestEnvironment | null>(null);

  const total = rows.length;
  const applicability = React.useMemo(
    () => (environment ? computeApplicability(rows, environment) : null),
    [rows, environment]
  );

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
    // Refresh the environment detection right before running so the in-app
    // header matches what `runAllTests` will actually skip — and pass the
    // same environment into the runner so the two views stay consistent.
    const env = await testing.detectEnvironment();
    setEnvironment(env);
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
      environment: env,
      resetEnvironment: resetTestGlobals,
      resetFile: resetTestFile,
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

  // One-shot environment detection so the header shows the right applicable
  // count before the user taps "Run tests". A second probe runs inside `run`
  // to refresh state right before the suite executes.
  React.useEffect(() => {
    let cancelled = false;
    void testing.detectEnvironment().then((env) => {
      if (!cancelled) setEnvironment(env);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = React.useMemo(() => {
    const t0 = now();
    const out = groupRows(rows);
    perf.groupRowsCalls++;
    perf.groupRowsTotalMs += now() - t0;
    return out;
  }, [rows]);
  // Counts derived only from applicable rows so the displayed pass/fail/skip
  // numbers reflect the suite the user actually intended to run. Pre-skipped
  // out-of-scope / device-missing tests are surfaced in the header instead.
  const counts = React.useMemo(() => {
    const t0 = now();
    const out = countApplicable(rows, environment);
    perf.countByStatusCalls++;
    perf.countByStatusTotalMs += now() - t0;
    return out;
  }, [rows, environment]);
  const applicableTotal = applicability?.applicable ?? total;
  const applicableCompleted = counts.completed;
  const progressPct = applicableTotal === 0 ? 0 : applicableCompleted / applicableTotal;
  // Reanimated SharedValue for the progress bar fill. Eased on each
  // progress update so the fill flows rather than jumps.
  const progressShared = useSharedValue(0);
  React.useEffect(() => {
    progressShared.value = withTiming(progressPct, { duration: 250 });
  }, [progressPct, progressShared]);
  const progressBarStyle = useAnimatedStyle(() => ({
    width: `${progressShared.value * 100}%`,
  }));


  return (
    <React.Profiler id="screen" onRender={onProfilerRender}>
      {/* Large "Tests" title that shrinks to compact on scroll — standard
          iOS large-title behavior. The floating pill is positioned
          absolutely below the (initial expanded) nav so it doesn't try
          to track the nav transition; instead it stays put. */}
      <Stack.Screen
        options={{
          title: 'Tests',
          headerLargeTitle: true,
          headerShadowVisible: false,
        }}
      />
      <ScrollView
        style={[styles.scrollView, { backgroundColor: theme.background }]}
        contentContainerStyle={styles.contentContainer}
        contentInsetAdjustmentBehavior="automatic">
        <View style={styles.pillSlot}>
          <GlassContainer spacing={32} style={styles.glassContainer}>
            <View style={styles.pillFrame}>
              <GlassView
                style={styles.pill}
                glassEffectStyle="clear"
                pointerEvents="box-none">
                <View style={styles.runButtonHost}>
                  <Host matchContents>
                    <UIButton
                      onPress={running ? undefined : run}
                      label={running ? 'Running…' : 'Run tests'}
                    />
                  </Host>
                </View>
                <View style={styles.pillDivider} />
                <View style={styles.pillProgressColumn}>
                  <View style={styles.progressBarOuter}>
                    <Animated.View
                      style={[
                        styles.progressBarInner,
                        { backgroundColor: theme.text },
                        progressBarStyle,
                      ]}
                    />
                  </View>
                  <Text
                    style={[styles.pillCounter, { color: theme.text }]}
                    numberOfLines={1}>
                    {applicableCompleted} / {applicableTotal}
                  </Text>
                  <Text
                    style={[styles.pillBreakdown, { color: theme.textSecondary }]}
                    numberOfLines={2}
                    ellipsizeMode="tail">
                    {counts.pass} pass · {counts.fail} fail
                    {counts.timeout > 0 ? ` · ${counts.timeout} timeout` : ''}
                    {counts.skip > 0 ? ` · ${counts.skip} skip` : ''}
                  </Text>
                </View>
              </GlassView>
            </View>
          </GlassContainer>
        </View>
        <View style={styles.headerBlock}>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            {applicability != null
              ? `${applicability.applicable} applicable on ${describeEnvironment(environment!)} / ${total} total across ${groups.length} ${groups.length === 1 ? 'file' : 'files'}`
              : `${total} tests across ${groups.length} ${groups.length === 1 ? 'file' : 'files'}`}
          </Text>
          {applicability != null && (applicability.outOfScope > 0 || applicability.deviceMissing > 0) ? (
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
              {applicability.outOfScope > 0 ? `${applicability.outOfScope} out of scope` : ''}
              {applicability.outOfScope > 0 && applicability.deviceMissing > 0 ? ' · ' : ''}
              {applicability.deviceMissing > 0
                ? `${applicability.deviceMissing} need ${describeMissingDevices(environment!)}`
                : ''}
            </Text>
          ) : null}

          <View style={styles.videoSlot}>
            <Video ref={videoRef} style={styles.video} />
          </View>
        </View>

        <React.Profiler id="results" onRender={onProfilerRender}>
          <View style={styles.resultsList}>
            {groups.map((group) => (
              <GroupSection
                key={group.key}
                group={group}
                env={environment}
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
    requirement: t.requirement,
    status: 'pending' as Status,
  }));
}

// Per-row applicability: out-of-scope rows are never applicable; device-
// requirement rows depend on the detected environment.
function isRowApplicable(row: Row, env: TestEnvironment | null): boolean {
  if (env == null) return row.requirement !== 'out-of-scope';
  return testing.isApplicable(row.requirement, env);
}

interface ApplicabilityCounts {
  applicable: number;
  outOfScope: number;
  deviceMissing: number;
}

function computeApplicability(rows: Row[], env: TestEnvironment): ApplicabilityCounts {
  let applicable = 0;
  let outOfScope = 0;
  let deviceMissing = 0;
  for (const r of rows) {
    if (r.requirement === 'out-of-scope') {
      outOfScope++;
    } else if (testing.isApplicable(r.requirement, env)) {
      applicable++;
    } else {
      deviceMissing++;
    }
  }
  return { applicable, outOfScope, deviceMissing };
}

interface ApplicableCounts {
  completed: number;
  pass: number;
  fail: number;
  timeout: number;
  skip: number;
}

// Counts pass/fail/timeout over applicable rows only. Pre-skipped (out-of-
// scope, device-missing) rows are excluded so the visible totals match what
// the user actually asked to run. `skip` here means a *runtime* skip — e.g.
// a test we couldn't classify upfront that still hit `NotFoundError`.
function countApplicable(rows: Row[], env: TestEnvironment | null): ApplicableCounts {
  const out: ApplicableCounts = { completed: 0, pass: 0, fail: 0, timeout: 0, skip: 0 };
  for (const r of rows) {
    if (!isRowApplicable(r, env)) continue;
    if (r.status === 'pending' || r.status === 'running') continue;
    out.completed++;
    if (r.status === 'pass') out.pass++;
    else if (r.status === 'fail') out.fail++;
    else if (r.status === 'timeout') out.timeout++;
    else if (r.status === 'skip') out.skip++;
  }
  return out;
}

function describeEnvironment(env: TestEnvironment): string {
  if (env.hasCamera && env.hasMicrophone) return 'this device';
  if (env.hasCamera) return 'this device (no microphone)';
  if (env.hasMicrophone) return 'simulator (microphone only)';
  return 'simulator';
}

function describeMissingDevices(env: TestEnvironment): string {
  if (!env.hasCamera && !env.hasMicrophone) return 'a camera or microphone';
  if (!env.hasCamera) return 'a camera';
  return 'a microphone';
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
// memo's shallow equality short-circuits cleanly. `env` is referentially
// stable post-detection (set once on focus, refreshed once per run), so
// memo doesn't bust on it.
const GroupSection = React.memo(function GroupSection({
  group,
  env,
  textColor,
  mutedColor,
}: {
  group: RowGroup;
  env: TestEnvironment | null;
  textColor: string;
  mutedColor: string;
}): React.JSX.Element {
  perf.groupSectionRenders++;
  // Split rows into "applicable" (counts toward the run) and "pre-skipped"
  // (out-of-scope or device-missing — known at registration time, not a
  // result). The header surfaces pre-skips up front as "needs camera" or
  // similar so the user doesn't see them tallied as "X skip" after the run.
  let applicableTotal = 0;
  let applicableDone = 0;
  let applicablePass = 0;
  let applicableFail = 0;
  let applicableTimeout = 0;
  let applicableRuntimeSkip = 0;
  let preSkipOutOfScope = 0;
  let preSkipDeviceMissing = 0;
  for (const r of group.rows) {
    if (r.requirement === 'out-of-scope') {
      preSkipOutOfScope++;
      continue;
    }
    if (env && !testing.isApplicable(r.requirement, env)) {
      preSkipDeviceMissing++;
      continue;
    }
    applicableTotal++;
    if (r.status === 'pending' || r.status === 'running') continue;
    applicableDone++;
    if (r.status === 'pass') applicablePass++;
    else if (r.status === 'fail') applicableFail++;
    else if (r.status === 'timeout') applicableTimeout++;
    else if (r.status === 'skip') applicableRuntimeSkip++;
  }
  const preSkipTag =
    preSkipDeviceMissing > 0 && env
      ? `needs ${describeMissingDevices(env)}`
      : preSkipOutOfScope > 0
        ? 'out of scope'
        : null;
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
        {preSkipTag != null && applicableTotal === 0 ? (
          <Text style={[styles.groupCounts, { color: mutedColor }]}>{preSkipTag}</Text>
        ) : (
          <Text style={[styles.groupCounts, { color: mutedColor }]}>
            {applicableDone}/{applicableTotal}
            {applicableFail ? ` · ${applicableFail} fail` : ''}
            {applicableTimeout ? ` · ${applicableTimeout} timeout` : ''}
            {applicableRuntimeSkip ? ` · ${applicableRuntimeSkip} skip` : ''}
            {preSkipTag != null ? ` · ${preSkipDeviceMissing + preSkipOutOfScope} ${preSkipTag}` : ''}
          </Text>
        )}
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
  screen: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    // No outer padding — children manage their own horizontal padding so a
    // sticky child can extend its background (the theme color) edge-to-edge
    // without leaving a visible 16px gutter when scrolled.
    paddingBottom: 32,
  },
  headerBlock: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
  },
  pillSlot: {
    // In-flow slot at the top of the ScrollView's contentContainer. The
    // pill scrolls with the page (so the iOS large-title transition is
    // unaffected) but sits prominently below the nav at rest. Side
    // margins so the pill floats rather than spanning edge-to-edge.
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    alignItems: 'stretch',
  },
  glassContainer: {
    // GlassContainer is a plain View; flex 1 ensures it stretches across
    // pillSlot's width so the pill inside can size to a stable width.
    alignSelf: 'stretch',
  },
  pillFrame: {
    // Stretches to the GlassContainer's full width so the pill's geometry
    // doesn't depend on its text content — `Run tests` ↔ `Running…` and
    // counter swaps no longer cause the whole capsule to resize.
    alignSelf: 'stretch',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    // Capsule corners (any value >= half the height clamps to a full pill).
    borderRadius: 999,
    overflow: 'hidden',
  },
  pillDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  pillProgressColumn: {
    flex: 1,
    gap: 4,
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
  runButtonHost: {
    // Stable width so swapping the label text between "Run tests" and
    // "Running…" doesn't shift the rest of the pill's layout.
    minWidth: 96,
  },
  pillCounter: {
    fontFamily: 'Menlo',
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  pillBreakdown: {
    fontFamily: 'Menlo',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    // Reserve room for two lines so the pill's height is stable whether
    // the breakdown is short ("0 pass · 0 fail") or grows past one line
    // ("12 pass · 1 fail · 1 timeout · 1 skip").
    minHeight: 28,
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
    paddingHorizontal: 16,
    paddingTop: 8,
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
