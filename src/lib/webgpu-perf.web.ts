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
  let lastFrameNumber: number | null = null;
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

  const recordFrameNumber = (frameNumber: number | null | undefined): void => {
    count('cameraReads');
    if (typeof frameNumber !== 'number') return;
    if (lastFrameNumber === null || frameNumber !== lastFrameNumber) {
      count('newCameraFrames');
    } else {
      count('duplicateCameraReads');
    }
    lastFrameNumber = frameNumber;
  };

  const report = (extra: WebGpuPerfExtra = {}, force = false): void => {
    const now = nowMs();
    const elapsedMs = now - windowStartedAt;
    if (!force && elapsedMs < PROFILE_INTERVAL_MS) return;
    const seconds = Math.max(elapsedMs / 1000, 0.001);
    const timingPayload: Record<string, { avgMs: number; maxMs: number }> = {};
    for (const [name, bucket] of timings) {
      if (bucket.count === 0) continue;
      timingPayload[name] = {
        avgMs: round(bucket.total / bucket.count),
        maxMs: round(bucket.max),
      };
    }
    const countPayload: Record<string, number> = {};
    for (const [name, value] of counts) {
      countPayload[name] = value;
      countPayload[`${name}PerSec`] = round(value / seconds);
    }
    if (typeof __DEV__ === 'undefined' || __DEV__) {
      console.log(
        `WEBGPU_DEMO_PROFILE ${JSON.stringify({
          demo,
          elapsedMs: Math.round(elapsedMs),
          ...staticInfo,
          ...extra,
          counts: countPayload,
          timings: timingPayload,
        })}`
      );
    }
    counts.clear();
    timings.clear();
    windowStartedAt = now;
  };

  return {
    count,
    duration,
    recordFrameNumber,
    report,
    time,
    timeAsync,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
