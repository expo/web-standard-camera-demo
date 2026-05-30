type TimingBucket = {
  count: number;
  max: number;
  total: number;
};

const PROFILE_INTERVAL_MS = 2000;

export type WebGpuPerfExtra = Record<string, boolean | number | string | null | undefined>;

export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function createWebGpuPerfProbe(demo: string, staticInfo: WebGpuPerfExtra = {}) {
  let windowStartedAt = nowMs();
  const counts = new Map<string, number>();
  const timings = new Map<string, TimingBucket>();

  const count = (name: string, amount = 1): void => {
    counts.set(name, (counts.get(name) ?? 0) + amount);
  };

  const duration = (name: string, ms: number): void => {
    const bucket = timings.get(name) ?? { count: 0, max: 0, total: 0 };
    bucket.count += 1;
    bucket.total += ms;
    bucket.max = Math.max(bucket.max, ms);
    timings.set(name, bucket);
  };

  const time = <T>(name: string, fn: () => T): T => {
    const start = nowMs();
    try {
      return fn();
    } finally {
      duration(name, nowMs() - start);
    }
  };

  const timeAsync = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = nowMs();
    try {
      return await fn();
    } finally {
      duration(name, nowMs() - start);
    }
  };

  const report = (_extra: WebGpuPerfExtra = {}, force = false): void => {
    const now = nowMs();
    const elapsedMs = now - windowStartedAt;
    if (!force && elapsedMs < PROFILE_INTERVAL_MS) return;
    counts.clear();
    timings.clear();
    windowStartedAt = now;
  };

  return {
    count,
    duration,
    report,
    time,
    timeAsync,
  };
}
