type TracePayload = Record<string, boolean | number | string | null | undefined>;

export type NeuralLensTraceEvent = TracePayload & {
  event: string;
  t: number;
  ts: number;
};

const MAX_TRACE_EVENTS = 240;
const TRACE_PREFIX = 'NEURAL_LENS_TRACE';

declare global {
  var __NEURAL_LENS_TRACE__: NeuralLensTraceEvent[] | undefined;
  var __NEURAL_LENS_TRACE_ENABLED__: boolean | undefined;
}

function envFlagEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'TRUE';
}

export function isNeuralLensTraceEnabled(): boolean {
  if (typeof __DEV__ !== 'undefined' && !__DEV__) return false;
  if (globalThis.__NEURAL_LENS_TRACE_ENABLED__ === true) return true;
  return envFlagEnabled(process.env.EXPO_PUBLIC_NEURAL_LENS_TRACE)
    || envFlagEnabled(process.env.NEURAL_LENS_TRACE);
}

export function traceNeuralLens(event: string, payload: TracePayload = {}): void {
  if (!isNeuralLensTraceEnabled()) return;
  const entry: NeuralLensTraceEvent = {
    event,
    t: round(nowMs()),
    ts: Date.now(),
    ...payload,
  };
  const history = globalThis.__NEURAL_LENS_TRACE__ ?? [];
  history.push(entry);
  if (history.length > MAX_TRACE_EVENTS) {
    history.splice(0, history.length - MAX_TRACE_EVENTS);
  }
  globalThis.__NEURAL_LENS_TRACE__ = history;
  console.log(`${TRACE_PREFIX} ${JSON.stringify(entry)}`);
}

export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}
