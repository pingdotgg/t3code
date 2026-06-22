import {
  DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
  type GitStackedAction,
  type VcsStatusResult,
} from "@t3tools/contracts";

import type { OrchestrationShellSnapshot, OrchestrationThread, TuiClient } from "./connection.ts";
import { gitActionNeedsCommitMessage } from "./gitActions.logic.ts";
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

/** Tone of a status-line message — drives its glyph + colour, like the web toasts. */
export type StatusKind = "info" | "success" | "error" | "busy";

export interface StoreState {
  readonly shell: OrchestrationShellSnapshot | null;
  readonly expanded: ReadonlySet<string>;
  /** Projects whose full thread list has been loaded ("show more" activated). */
  readonly loadedInFull: ReadonlySet<string>;
  readonly selection: Selection | null;
  readonly detail: OrchestrationThread | null;
  readonly status: string;
  readonly statusKind: StatusKind;
  /** Sidebar filter text; empty = unfiltered. */
  readonly filter: string;
  /** Live git status for the selected thread's worktree, or null. */
  readonly vcsStatus: VcsStatusResult | null;
  /** True while a git stacked action is running. */
  readonly gitBusy: boolean;
}

export interface Store {
  readonly getState: () => StoreState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => void;
  readonly stop: () => void;
  readonly moveSelection: (delta: number) => void;
  /** Move selection to the next/prev THREAD row, skipping project headers. */
  readonly moveThreadSelection: (delta: 1 | -1) => void;
  /** Select the Nth (1-based) visible thread, like the web's thread-jump 1–9. */
  readonly selectThreadByIndex: (index: number) => void;
  readonly select: (selection: Selection) => void;
  readonly toggleProject: (id: string) => void;
  readonly loadMore: (id: string) => void;
  readonly setStatus: (status: string, kind?: StatusKind) => void;
  readonly setFilter: (filter: string) => void;
  /** Run a git stacked action on the selected thread's worktree (commitMessage for commit-bearing actions). */
  readonly runGitAction: (action: GitStackedAction, commitMessage?: string) => void;
}

export function createStore(client: TuiClient): Store {
  let state: StoreState = {
    shell: null,
    expanded: new Set<string>(),
    loadedInFull: new Set<string>(),
    selection: null,
    detail: null,
    status: "Connecting…",
    statusKind: "busy",
    filter: "",
    vcsStatus: null,
    gitBusy: false,
  };
  const listeners = new Set<() => void>();
  let unsubShell: (() => void) | null = null;
  let unsubThread: (() => void) | null = null;
  let unsubVcs: (() => void) | null = null;
  // The worktree currently subscribed for git status, so we only resubscribe on change.
  let vcsCwd: string | null = null;


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

  /** The cwd to query git status for: the thread's worktree, else its project root. */
  const currentCwd = (): string | null => {
    const detail = state.detail;
    if (!detail) return null;
    if (detail.worktreePath) return detail.worktreePath;
    const project = state.shell?.projects.find((p) => p.id === detail.projectId);
    return project?.workspaceRoot ?? null;
  };

  /** (Re)subscribe the git-status stream when the selected worktree changes. */
  const syncVcs = () => {
    const cwd = currentCwd();
    if (cwd === vcsCwd) return;
    vcsCwd = cwd;
    unsubVcs?.();
    unsubVcs = null;
    set({ vcsStatus: null });
    if (!cwd) return;
    unsubVcs = client.subscribeVcsStatus(cwd, (status) => set({ vcsStatus: status }));
  };

  const subscribeDetail = (threadId: string | null) => {
    unsubThread?.();
    unsubThread = null;
    if (!threadId) return;
    unsubThread = client.subscribeThread(threadId as never, (thread) => {
      if (state.selection?.kind === "thread" && state.selection.id === thread.id) {
        set({ detail: thread });
        syncVcs();
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
    syncVcs();
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
          statusKind: "info",
        };
        ensureValidSelection(rowsNow());
        emit();
      });
    },
    stop: () => {
      unsubShell?.();
      unsubThread?.();
      unsubVcs?.();
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
    moveThreadSelection: (delta) => {
      const threads = rowsNow().filter((row) => row.kind === "thread");
      if (threads.length === 0) return;
      const currentId = selectedThreadId();
      let index = threads.findIndex((row) => row.id === currentId);
      // Not on a thread yet: step into the first (next) or last (prev) one.
      if (index < 0) index = delta > 0 ? -1 : threads.length;
      const nextIndex = Math.min(threads.length - 1, Math.max(0, index + delta));
      const next = threads[nextIndex];
      if (next) applySelection(selectionFromRow(next));
    },
    selectThreadByIndex: (index) => {
      const target = rowsNow().filter((row) => row.kind === "thread")[index - 1];
      if (target) applySelection(selectionFromRow(target));
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
    setStatus: (status, kind = "info") => set({ status, statusKind: kind }),
    setFilter: (filter) => {
      state = { ...state, filter };
      ensureValidSelection(rowsNow());
      emit();
    },
    runGitAction: (action, commitMessage) => {
      if (state.gitBusy) return;
      const message = commitMessage?.trim();
      if (gitActionNeedsCommitMessage(action) && !message) {
        set({ status: "Commit needs a message.", statusKind: "error" });
        return;
      }
      const cwd = currentCwd();
      if (!cwd) {
        set({ status: "No worktree for git actions.", statusKind: "error" });
        return;
      }
      set({ gitBusy: true, status: `Running ${action}…`, statusKind: "busy" });
      client
        .runGitStackedAction({ cwd, action, ...(message ? { commitMessage: message } : {}) })
        .then(() => set({ gitBusy: false, status: "Git action complete.", statusKind: "success" }))
        .catch((error: unknown) =>
          set({ gitBusy: false, status: `Git failed: ${String(error)}`, statusKind: "error" }),
        );
    },
  };
}
