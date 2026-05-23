const cameraRunEvents = new EventTarget();
const TEST_RUN_START = 'test-run-start';

export function notifyTestRunStart(): void {
  cameraRunEvents.dispatchEvent(new Event(TEST_RUN_START));
}

export function addTestRunStartListener(listener: () => void): () => void {
  cameraRunEvents.addEventListener(TEST_RUN_START, listener);
  return () => {
    cameraRunEvents.removeEventListener(TEST_RUN_START, listener);
  };
}
