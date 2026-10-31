/**
 * Microphone input level while dictating: 0 (silence) to 1 (loud), already
 * smoothed and perceptually scaled, pushed about 25 times a second. Visuals
 * subscribe and apply it to the DOM directly, so the level never re-renders
 * React. It drops to 0 when recording ends.
 */
export type DictationLevel = {
  readonly read: () => number;
  readonly subscribe: (listener: (level: number) => void) => () => void;
};

/** The writable side, owned by the capture that measures the level. */
export function createDictationLevel(): DictationLevel & { readonly set: (level: number) => void } {
  let current = 0;
  const listeners = new Set<(level: number) => void>();
  return {
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (level) => {
      if (level === current) return;
      current = level;
      for (const listener of listeners) listener(level);
    },
  };
}
