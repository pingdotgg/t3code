import type { DraftId } from "./composerDraftStore";

const DEFAULT_MAX_PENDING_HANDOVERS = 8;

export interface PendingHandover {
  readonly handover: string;
  readonly draftId?: DraftId;
}

export interface PendingHandoverStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getVersion: () => number;
  readonly isGenerating: (sourceThreadKey: string) => boolean;
  readonly setGenerating: (sourceThreadKey: string, generating: boolean) => void;
  readonly get: (sourceThreadKey: string) => PendingHandover | undefined;
  readonly has: (sourceThreadKey: string) => boolean;
  readonly save: (sourceThreadKey: string, handover: PendingHandover) => void;
  readonly delete: (sourceThreadKey: string) => void;
  readonly size: () => number;
}

export function createPendingHandoverStore(
  maxEntries = DEFAULT_MAX_PENDING_HANDOVERS,
): PendingHandoverStore {
  const entries = new Map<string, PendingHandover>();

  const generating = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
    isGenerating: (key) => generating.has(key),
    setGenerating: (key, value) => {
      if (generating.has(key) === value) return;
      if (value) generating.add(key);
      else generating.delete(key);
      notify();
    },
    get: (sourceThreadKey) => entries.get(sourceThreadKey),
    has: (sourceThreadKey) => entries.has(sourceThreadKey),
    save: (sourceThreadKey, handover) => {
      entries.delete(sourceThreadKey);
      entries.set(sourceThreadKey, handover);
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
      notify();
    },
    delete: (sourceThreadKey) => {
      if (entries.delete(sourceThreadKey)) notify();
    },
    size: () => entries.size,
  };
}
