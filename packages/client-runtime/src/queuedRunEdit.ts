/**
 * A queued-message edit ends on save, cancel, or when its run leaves the queue.
 * The store owns one watcher per edit, so "run left the queue" is handled exactly
 * once, when the projection reports it, wherever the user is in the app. It also
 * owns the edit's save, because a save outlives the view that started it.
 */
import type { RunId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

export interface QueuedRunStatus {
  readonly id: RunId;
  readonly status: string;
}

/** The thread's runs, or null while they are unknown (detail not loaded yet). */
export type QueuedRunsAtom = Atom.Atom<ReadonlyArray<QueuedRunStatus> | null>;

interface ShellThreadPresence {
  readonly id: string;
  readonly deletedAt: unknown;
}

/**
 * The edited thread's runs. A deleted thread (shell `deletedAt` or detail status
 * `deleted`) reads as no runs, so its edit ends. Absence from the shell is not
 * deletion: archived threads are dropped there but keep an editable queue, so
 * everything else reads the detail's runs, unknown until it loads.
 */
export function makeQueuedRunsAtom(input: {
  readonly threadId: string;
  readonly snapshot: Atom.Atom<{ readonly threads: ReadonlyArray<ShellThreadPresence> } | null>;
  readonly detailStatus: Atom.Atom<string>;
  readonly runs: Atom.Atom<ReadonlyArray<QueuedRunStatus> | null>;
}): QueuedRunsAtom {
  return Atom.make((get) => {
    const shellThread = get(input.snapshot)?.threads.find(
      (candidate) => candidate.id === input.threadId,
    );
    if (shellThread !== undefined && shellThread.deletedAt !== null) return [];
    if (get(input.detailStatus) === "deleted") return [];
    return get(input.runs);
  });
}

function runLeftQueue(runs: ReadonlyArray<QueuedRunStatus> | null, runId: RunId): boolean {
  if (runs === null) return false;
  return !runs.some((run) => run.id === runId && run.status === "queued");
}

/**
 * What happens to an open edit when its run leaves the queue: an unchanged
 * edit just closes; a changed one moves into the thread's own draft when that
 * draft is empty, and is dropped otherwise so it never overwrites the user's
 * other work.
 */
export function resolveQueuedEditExit(input: {
  readonly editChanged: boolean;
  readonly threadDraftEmpty: boolean;
}): "kept" | "discarded" | "clean" {
  if (!input.editChanged) return "clean";
  return input.threadDraftEmpty ? "kept" : "discarded";
}

interface ExitWatch<E> {
  readonly runs: QueuedRunsAtom;
  readonly runId: RunId;
  readonly onRunLeftQueue: (threadKey: string, edit: E) => void;
  cancel: (() => void) | null;
}

/**
 * Settles a save from `startSave`. False, changing nothing, when the edit was
 * ended or begun again meanwhile. Success ends the edit; failure resumes its
 * exit watch and returns whether the edit survived it.
 */
export type FinishQueuedRunEditSave = (succeeded: boolean) => boolean;

export function makeQueuedRunEditStore<E extends { readonly runId: RunId }>(options: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly label: string;
}) {
  const { registry } = options;
  const atom = Atom.make<Readonly<Record<string, E>>>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel(options.label),
  );
  const savingAtom = Atom.make<Readonly<Record<string, true>>>({}).pipe(
    Atom.keepAlive,
    Atom.withLabel(`${options.label}-saving`),
  );
  // Each begin creates a new watch, so the watch is the edit's identity.
  const watches = new Map<string, ExitWatch<E>>();

  const setSaving = (threadKey: string, saving: boolean) => {
    const current = registry.get(savingAtom);
    if (threadKey in current === saving) return;
    const next = { ...current };
    if (saving) next[threadKey] = true;
    else delete next[threadKey];
    registry.set(savingAtom, next);
  };

  const get = (threadKey: string | null): E | null =>
    threadKey === null ? null : (registry.get(atom)[threadKey] ?? null);

  const write = (threadKey: string, edit: E | null) => {
    const current = registry.get(atom);
    if (edit === null) {
      if (!(threadKey in current)) return;
      const next = { ...current };
      delete next[threadKey];
      registry.set(atom, next);
      return;
    }
    registry.set(atom, { ...current, [threadKey]: edit });
  };

  const unsubscribe = (watch: ExitWatch<E>) => {
    watch.cancel?.();
    watch.cancel = null;
  };

  const subscribe = (threadKey: string, watch: ExitWatch<E>) => {
    const check = (runs: ReadonlyArray<QueuedRunStatus> | null) => {
      if (watches.get(threadKey) !== watch || watch.cancel === null) return;
      if (!runLeftQueue(runs, watch.runId)) return;
      unsubscribe(watch);
      watches.delete(threadKey);
      const edit = get(threadKey);
      if (edit === null || edit.runId !== watch.runId) return;
      write(threadKey, null);
      watch.onRunLeftQueue(threadKey, edit);
    };
    watch.cancel = registry.subscribe(watch.runs, check);
    check(registry.get(watch.runs));
  };

  const stopWatch = (threadKey: string) => {
    const watch = watches.get(threadKey);
    if (watch === undefined) return;
    unsubscribe(watch);
    watches.delete(threadKey);
  };

  return {
    atom,
    /** Thread keys whose edit has a save in flight. */
    savingAtom,
    get,
    /**
     * Starts an edit, replacing any edit already open on the thread. When the
     * run leaves the queue the edit is removed and `onRunLeftQueue` receives
     * it; if the run already left, that happens immediately.
     */
    begin(
      threadKey: string,
      edit: E,
      watch: {
        readonly runs: QueuedRunsAtom;
        readonly onRunLeftQueue: (threadKey: string, edit: E) => void;
      },
    ) {
      stopWatch(threadKey);
      write(threadKey, edit);
      const next: ExitWatch<E> = { ...watch, runId: edit.runId, cancel: null };
      watches.set(threadKey, next);
      subscribe(threadKey, next);
    },
    update(threadKey: string, f: (edit: E) => E) {
      const edit = get(threadKey);
      if (edit !== null) write(threadKey, f(edit));
    },
    end(threadKey: string) {
      stopWatch(threadKey);
      write(threadKey, null);
    },
    /**
     * Claims the open edit for a save, or returns null when there is no edit
     * or a save is in flight. The exit watch pauses so the save's result decides
     * the edit's fate. The claim outlives the edit: the server orders saves by
     * arrival, so an overlapping older save could overwrite a newer one.
     */
    startSave(threadKey: string): FinishQueuedRunEditSave | null {
      const watch = watches.get(threadKey);
      if (watch === undefined || threadKey in registry.get(savingAtom)) return null;
      setSaving(threadKey, true);
      unsubscribe(watch);
      let settled = false;
      return (succeeded) => {
        if (!settled) {
          settled = true;
          setSaving(threadKey, false);
        }
        if (watches.get(threadKey) !== watch) return false;
        if (succeeded) {
          stopWatch(threadKey);
          write(threadKey, null);
          return true;
        }
        subscribe(threadKey, watch);
        return watches.get(threadKey) === watch;
      };
    },
  };
}
