import {
  ORBIT_INSTANCE_STAYS_LINE,
  orbitCompletionFailure,
  orbitSetupStages,
  orbitThreadStartCanRetry,
  orbitThreadStartStep,
  readOrbitThreadStarts,
  type OrbitSetupCreateRow,
  type OrbitThreadStart,
} from "@t3tools/client-runtime/orbit-gateway";

import { writeFileAtomically } from "../../lib/atomic-file";

/**
 * Conn: the threads started in an Orbit Project on this phone (FORK.md, "Orbit"), kept in a file
 * until their first message is sent and the create's completion ended, so an app restart resumes
 * them. Every change is written in
 * order; the shared state machine saves after each step.
 */

export interface OrbitThreadStartStorage {
  readonly load: () => Promise<string | null>;
  readonly save: (text: string) => Promise<void>;
}

export interface OrbitThreadStartStore {
  /** Reads the saved starts once; starts added before it finished stay. */
  readonly load: () => Promise<void>;
  readonly loaded: () => boolean;
  readonly starts: () => readonly OrbitThreadStart[];
  readonly subscribe: (listener: () => void) => () => void;
  readonly update: (change: (starts: OrbitThreadStart[]) => OrbitThreadStart[]) => void;
  /** Saves a start after a step. A dismissed start stays gone. */
  readonly save: (start: OrbitThreadStart) => void;
  /** Resolves once every change so far is written; rejects when the last write failed. */
  readonly flush: () => Promise<void>;
}

/** Starts the file holds, saved by this build or an older one. */
export function parseOrbitThreadStarts(text: string | null): OrbitThreadStart[] {
  if (text === null) return [];
  try {
    return readOrbitThreadStarts(JSON.parse(text));
  } catch {
    return [];
  }
}

export function createOrbitThreadStartStore(
  storage: OrbitThreadStartStorage,
): OrbitThreadStartStore {
  let starts: OrbitThreadStart[] = [];
  let isLoaded = false;
  let loading: Promise<void> | null = null;
  let writing: Promise<void> = Promise.resolve();
  let writeError: unknown = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const load = () => {
    loading ??= (async () => {
      let saved: OrbitThreadStart[] = [];
      try {
        saved = parseOrbitThreadStarts(await storage.load());
      } catch {
        // An unreadable file starts empty; the next write replaces it.
      }
      const savedIds = new Set(saved.map((start) => start.id));
      starts = [...saved, ...starts.filter((start) => !savedIds.has(start.id))];
      isLoaded = true;
      emit();
    })();
    return loading;
  };
  // Writes wait for the file to load, so a start added early cannot overwrite the saved ones.
  // Each write takes the list as it is then, so the last one always holds every change.
  const persist = () => {
    writing = writing
      .then(load)
      .then(() => storage.save(JSON.stringify(starts)))
      .then(
        () => {
          writeError = null;
        },
        (error: unknown) => {
          writeError = error;
        },
      );
  };
  const update = (change: (current: OrbitThreadStart[]) => OrbitThreadStart[]) => {
    starts = change([...starts]);
    persist();
    emit();
  };

  return {
    load,
    loaded: () => isLoaded,
    starts: () => starts,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update,
    save: (start) =>
      update((current) => current.map((entry) => (entry.id === start.id ? start : entry))),
    flush: async () => {
      await writing;
      if (writeError !== null) {
        throw new Error("Conn could not save the thread start on this phone.", {
          cause: writeError,
        });
      }
    },
  };
}

const STARTS_FILE = "orbit-thread-starts.json";

async function startsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, STARTS_FILE);
}

export const orbitThreadStartStore = createOrbitThreadStartStore({
  load: async () => {
    const file = await startsFile();
    return file.exists ? await file.text() : null;
  },
  save: async (text) => writeFileAtomically(await startsFile(), text),
});

export function retryOrbitThreadStart(id: string, store = orbitThreadStartStore): void {
  store.update((starts) =>
    starts.map((start) => (start.id === id ? { ...start, error: null, errorCode: null } : start)),
  );
}

export function dismissOrbitThreadStart(id: string, store = orbitThreadStartStore): void {
  store.update((starts) => starts.filter((start) => start.id !== id));
}

/** Instances whose server a start pairs with itself; the environment sync leaves them alone. */
export function heldOrbitInstanceIds(store = orbitThreadStartStore): number[] {
  // A sent start no longer pairs; its Instance follows the sync, as on the desktop.
  return store
    .starts()
    .flatMap((start) =>
      start.instanceId === null || start.sentAt != null ? [] : [start.instanceId],
    );
}

export type OrbitThreadStartStage =
  | "creating"
  | "pairing"
  | "sending"
  | "stopped"
  /** Sent; the create's completion runs (the rows show where). */
  | "setup"
  /** Sent; the completion failed, or was cancelled outside a removal. */
  | "setupFailed";

const STAGE_LABELS: Record<"creating" | "pairing" | "sending" | "stopped", string> = {
  creating: "Creating the clone…",
  pairing: "Pairing…",
  sending: "Sending the first message…",
  stopped: "Stopped",
};

/** What a start row shows. After the send it shows the desktop card's rows and words. */
export interface OrbitThreadStartRowView {
  readonly stage: OrbitThreadStartStage;
  /** After the project: the stage, the Instance while its setup runs, or the card's title. */
  readonly label: string;
  /** The error or the first message; after a failed setup, Conn's message or Orbit's line. */
  readonly detail: string;
  /** The desktop card's rows under "Create Instance", while the completion runs or failed. */
  readonly rows: readonly OrbitSetupCreateRow[] | null;
  /** Orbit's `code · detail` under the message, and the line that the Instance stays. */
  readonly notes: readonly string[];
  readonly canRetry: boolean;
}

export function orbitThreadStartRow(start: OrbitThreadStart): OrbitThreadStartRowView {
  if (start.sentAt != null && start.error === null) {
    const rows = orbitSetupStages({ start }).find((stage) => stage.id === "create")?.rows ?? null;
    const failure = orbitCompletionFailure(start);
    if (failure !== null) {
      const notes = [
        ...(failure.message !== null && failure.detailLine !== null ? [failure.detailLine] : []),
        ...(failure.instanceStays ? [ORBIT_INSTANCE_STAYS_LINE] : []),
      ];
      return {
        stage: "setupFailed",
        label: failure.title,
        detail: failure.message ?? failure.detailLine ?? start.message,
        rows,
        notes,
        canRetry: failure.canRetry,
      };
    }
    return {
      stage: "setup",
      label: start.instanceName,
      detail: start.message,
      rows,
      notes: [],
      canRetry: false,
    };
  }
  const stage = start.error === null ? orbitThreadStartStep(start) : "stopped";
  return {
    stage,
    label: STAGE_LABELS[stage],
    detail: start.error ?? start.message,
    rows: null,
    notes: [],
    canRetry: stage === "stopped" && orbitThreadStartCanRetry(start),
  };
}
