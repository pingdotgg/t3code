import { DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT } from "@t3tools/contracts";

import type { OrchestrationShellSnapshot, OrchestrationThread, TuiClient } from "./connection.ts";
import {
  buildRows,
  type Row,
  type Selection,
  selectionEquals,
} from "./components/Sidebar.logic.ts";

// The TUI's source of truth lives in this external store (read by ChatView via
// useSyncExternalStore), not in React, so it survives re-renders and the
// imperative subscription plumbing stays out of the component tree. It mirrors
// the role of the web app's state atoms (apps/web/src/state/*), at a smaller
// scale that fits a single-environment terminal client.

export interface StoreState {
  readonly shell: OrchestrationShellSnapshot | null;
  readonly expanded: ReadonlySet<string>;
  /** Projects whose full thread list has been loaded ("show more" activated). */
  readonly loadedInFull: ReadonlySet<string>;
  readonly selection: Selection | null;
  readonly detail: OrchestrationThread | null;
  readonly status: string;
  /** Sidebar filter text; empty = unfiltered. */
  readonly filter: string;
}

export interface Store {
  readonly getState: () => StoreState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly stop: () => void;
  readonly moveSelection: (delta: number) => void;
  readonly select: (selection: Selection) => void;
  readonly toggleProject: (id: string) => void;
  readonly loadMore: (id: string) => void;
  readonly setStatus: (status: string) => void;
  readonly setFilter: (filter: string) => void;
}

export function createStore(client: TuiClient): Store {
  let state: StoreState = {
    shell: null,
    expanded: new Set<string>(),
    loadedInFull: new Set<string>(),
    selection: null,
    detail: null,
    status: "Connecting…",
    filter: "",
  };
  const listeners = new Set<() => void>();
  let unsubShell: (() => void) | null = null;
  let unsubThread: (() => void) | null = null;

  const selectedThreadId = () => (state.selection?.kind === "thread" ? state.selection.id : null);
  const rowsNow = () =>
    buildRows(state.shell, state.expanded, state.loadedInFull, selectedThreadId(), state.filter);

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const set = (patch: Partial<StoreState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const subscribeDetail = (threadId: string | null) => {
    unsubThread?.();
    unsubThread = null;
    if (!threadId) return;
    unsubThread = client.subscribeThread(threadId as never, (thread) => {
      if (state.selection?.kind === "thread" && state.selection.id === thread.id) {
        set({ detail: thread });
      }
    });
  };

  const selectionFromRow = (row: Row): Selection => ({ kind: row.kind, id: row.id });

  const applySelection = (selection: Selection | null) => {
    const threadId = selection?.kind === "thread" ? selection.id : null;
    subscribeDetail(threadId);
    // Seed from the warm cache so re-selecting a thread paints instantly; the
    // live value streams in immediately after (no refetch, no blank).
    const cached = threadId ? client.peekThread(threadId as never) : null;
    set({ selection, detail: cached });
  };

  const ensureValidSelection = (rows: Row[]) => {
    if (rows.length === 0) {
      applySelection(null);
      return;
    }
    if (state.selection && rows.some((row) => selectionEquals(state.selection, row))) {
      return;
    }
    const fallback = rows.find((row) => row.kind === "thread") ?? rows[0];
    applySelection(fallback ? selectionFromRow(fallback) : null);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      unsubShell = client.subscribeShell((shell) => {
        const sortedThreads = shell.threads.toSorted((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        );
        const nextShell = { ...shell, threads: sortedThreads };
        state = {
          ...state,
          shell: nextShell,
          status: `${nextShell.projects.length} project(s) · ${sortedThreads.length} thread(s)`,
        };
        ensureValidSelection(rowsNow());
        emit();
      });
    },
    stop: () => {
      unsubShell?.();
      unsubThread?.();
    },
    moveSelection: (delta) => {
      const rows = rowsNow();
      if (rows.length === 0) return;
      let index = rows.findIndex((row) => selectionEquals(state.selection, row));
      if (index < 0) index = 0;
      const nextIndex = Math.min(rows.length - 1, Math.max(0, index + delta));
      const next = rows[nextIndex];
      if (next) applySelection(selectionFromRow(next));
    },
    select: (selection) => applySelection(selection),
    toggleProject: (id) => {
      const expanded = new Set(state.expanded);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      set({ expanded });
      applySelection({ kind: "project", id });
    },
    loadMore: (id) => {
      const loadedInFull = new Set(state.loadedInFull).add(id);
      set({ loadedInFull });
      const projectThreads = (state.shell?.threads ?? []).filter(
        (thread) => thread.projectId === id,
      );
      const firstRevealed = projectThreads[DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT];
      applySelection(
        firstRevealed ? { kind: "thread", id: firstRevealed.id } : { kind: "project", id },
      );
    },
    setStatus: (status) => set({ status }),
    setFilter: (filter) => {
      state = { ...state, filter };
      ensureValidSelection(rowsNow());
      emit();
    },
  };
}
