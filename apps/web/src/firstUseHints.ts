import type { ReactNode } from "react";

const FIRST_USE_HINTS_STORAGE_KEY = "t3code:first-use-hints:v1";

type FirstUseHintStorage = Pick<Storage, "getItem" | "setItem">;

export type FirstUseHintAction = {
  readonly label: string;
  readonly onSelect: () => void;
};

export type FirstUseHint = {
  /** Stable across releases. Changing this id intentionally presents the hint again. */
  readonly id: string;
  readonly title: string;
  readonly description: ReactNode;
  readonly primaryAction?: FirstUseHintAction;
  readonly secondaryAction?: FirstUseHintAction;
  /** Runs after any close path, including an action selection. */
  readonly onDismiss?: () => void;
};

export type FirstUseHintSnapshot = {
  readonly current: FirstUseHint | null;
};

type FirstUseHintManagerOptions = {
  readonly storage: () => FirstUseHintStorage | null;
  readonly reportError?: (error: unknown) => void;
};

export type FirstUseHintManager = {
  /** Claims and queues a hint exactly once for this browser profile. */
  readonly show: (hint: FirstUseHint) => boolean;
  readonly dismiss: (id: string) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => FirstUseHintSnapshot;
};

type StoredFirstUseHints = {
  readonly seen: ReadonlyArray<string>;
};

const EMPTY_SNAPSHOT: FirstUseHintSnapshot = { current: null };

function decodeSeenIds(raw: string | null): Set<string> {
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("seen" in parsed)) return new Set();
    const seen = (parsed as { readonly seen?: unknown }).seen;
    if (!Array.isArray(seen)) return new Set();
    return new Set(seen.filter((id): id is string => typeof id === "string" && id.length > 0));
  } catch {
    return new Set();
  }
}

/**
 * The manager is the first-use seam: callers provide content once, while it
 * owns durable claims, same-session races, and serialization of overlapping hints.
 */
export function createFirstUseHintManager({
  storage,
  reportError = (error) => console.error("Could not persist first-use hint state.", error),
}: FirstUseHintManagerOptions): FirstUseHintManager {
  const listeners = new Set<() => void>();
  const claimedIds = new Set<string>();
  const queue: FirstUseHint[] = [];
  let snapshot = EMPTY_SNAPSHOT;

  const publish = () => {
    snapshot = { current: queue[0] ?? null };
    for (const listener of listeners) listener();
  };

  const readSeenIds = () => {
    try {
      return decodeSeenIds(storage()?.getItem(FIRST_USE_HINTS_STORAGE_KEY) ?? null);
    } catch (error) {
      reportError(error);
      return new Set<string>();
    }
  };

  const persistSeenIds = (seen: ReadonlySet<string>) => {
    try {
      const target = storage();
      if (target === null) return;
      const value: StoredFirstUseHints = { seen: [...seen] };
      target.setItem(FIRST_USE_HINTS_STORAGE_KEY, JSON.stringify(value));
    } catch (error) {
      reportError(error);
    }
  };

  return {
    show: (hint) => {
      const id = hint.id.trim();
      if (id.length === 0 || claimedIds.has(id)) return false;

      const seenIds = readSeenIds();
      if (seenIds.has(id)) {
        claimedIds.add(id);
        return false;
      }

      // Claim before publishing so two callers in the same tick cannot queue
      // the same education. Persistence happens before rendering for the same
      // reason across reloads.
      claimedIds.add(id);
      seenIds.add(id);
      persistSeenIds(seenIds);
      queue.push(id === hint.id ? hint : { ...hint, id });
      publish();
      return true;
    },
    dismiss: (id) => {
      if (queue[0]?.id !== id) return false;
      queue.shift();
      publish();
      return true;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

export const firstUseHints = createFirstUseHintManager({
  storage: () => (typeof window === "undefined" ? null : window.localStorage),
});
