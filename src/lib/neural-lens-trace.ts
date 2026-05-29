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
}

export function traceNeuralLens(event: string, payload: TracePayload = {}): void {
  if (typeof __DEV__ !== 'undefined' && !__DEV__) return;
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
