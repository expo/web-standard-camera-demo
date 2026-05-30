export type AppTabPressEvent = {
  name: string;
  ts: number;
};

const tabPressListeners = new Set<(event: AppTabPressEvent) => void>();

export function notifyAppTabPress(name: string): void {
  const event: AppTabPressEvent = {
    name,
    ts: Date.now(),
  };
  for (const listener of tabPressListeners) {
    listener(event);
  }
}

export function addAppTabPressListener(listener: (event: AppTabPressEvent) => void): () => void {
  tabPressListeners.add(listener);
  return () => {
    tabPressListeners.delete(listener);
  };
}
