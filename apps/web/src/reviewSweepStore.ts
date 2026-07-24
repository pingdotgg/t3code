import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  canSettle,
  effectiveSettled,
  threadLastActivityAt,
} from "@t3tools/client-runtime/state/thread-settled";
import { toSortableTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  EnvironmentId,
  ProjectId,
  ReviewThreadSummaryResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { getClientSettings } from "./hooks/useSettings";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { readThreadShell, readThreadRefs } from "./state/entities";
import { reviewEnvironment } from "./state/review";
import { environmentServerConfigsAtom } from "./state/server";
import { threadEnvironment } from "./state/threads";

/** PR states mirrored from SidebarV2's per-row VCS subscriptions (keyed by
    scoped thread key). The sidebar auto-settles merged/closed+idle threads
    using this data; the sweep must see the same states or it will count
    those threads as unsettled. Module-level because the sidebar is mounted
    for the app's lifetime and owns the subscriptions. */
let changeRequestStateByKey: ReadonlyMap<string, "open" | "closed" | "merged"> = new Map();

export function publishSweepChangeRequestStates(
  states: ReadonlyMap<string, "open" | "closed" | "merged">,
): void {
  changeRequestStateByKey = states;
  // Bump the store version so the pre-run summary recomputes its candidate
  // count as PR states stream in from the sidebar rows.
  useReviewSweepStore.getState().bumpCandidateVersion();
}

const SWEEP_CONCURRENCY = 3;
/** Soft cap so a giant backlog doesn't spawn an unbounded number of LLM
    generations in one click. */
export const SWEEP_MAX_THREADS = 50;

export type SweepItemStatus = "pending" | "running" | "done" | "error";

export interface SweepItem {
  readonly ref: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly threadTitle: string;
  readonly status: SweepItemStatus;
  readonly result: ReviewThreadSummaryResult | null;
  readonly errorMessage: string | null;
  readonly titleApplied: boolean;
  readonly settleApplied: boolean;
  readonly dismissed: boolean;
}

export type SweepPhase = "idle" | "running" | "complete";

interface ReviewSweepState {
  phase: SweepPhase;
  runId: number;
  /** Scoped thread keys in review order. */
  order: ReadonlyArray<string>;
  items: Readonly<Record<string, SweepItem>>;
  /** Count of candidates dropped by SWEEP_MAX_THREADS (0 = full coverage). */
  truncatedCount: number;
  /** Bumped when sidebar-owned PR states change; the pre-run summary
      subscribes so its candidate count tracks the sidebar's partition. */
  candidateVersion: number;
  startRun: (input: {
    runId: number;
    items: ReadonlyArray<SweepItem>;
    truncatedCount: number;
  }) => void;
  patchItem: (key: string, patch: Partial<SweepItem>) => void;
  finishRun: (runId: number) => void;
  bumpCandidateVersion: () => void;
  reset: () => void;
}

export const useReviewSweepStore = create<ReviewSweepState>((set) => ({
  phase: "idle",
  runId: 0,
  order: [],
  items: {},
  truncatedCount: 0,
  candidateVersion: 0,
  startRun: ({ runId, items, truncatedCount }) =>
    set({
      phase: "running",
      runId,
      order: items.map((item) => scopedThreadKey(item.ref)),
      items: Object.fromEntries(items.map((item) => [scopedThreadKey(item.ref), item])),
      truncatedCount,
    }),
  patchItem: (key, patch) =>
    set((state) => {
      const existing = state.items[key];
      if (!existing) return state;
      return { items: { ...state.items, [key]: { ...existing, ...patch } } };
    }),
  finishRun: (runId) => set((state) => (state.runId === runId ? { phase: "complete" } : state)),
  bumpCandidateVersion: () => set((state) => ({ candidateVersion: state.candidateVersion + 1 })),
  reset: () => set({ phase: "idle", order: [], items: {}, truncatedCount: 0 }),
}));

function readServerCapabilities(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
    .capabilities;
}

/** The sweep-eligibility predicate, mirroring SidebarV2's active-card
    partition. Exported so the pre-run confirmation screen counts exactly
    the threads a run would review. */
export function isSweepCandidate(
  shell: EnvironmentThreadShell,
  capabilities: { threadSettlement?: boolean; reviewSweep?: boolean } | undefined,
  options: { readonly now: string; readonly autoSettleAfterDays: number | null },
): boolean {
  if (shell.archivedAt !== null) return false;
  if (capabilities?.threadSettlement !== true || capabilities.reviewSweep !== true) return false;
  // PR state comes from SidebarV2's per-row subscriptions via
  // publishSweepChangeRequestStates, so merged-PR+idle threads classify as
  // settled here exactly like they do in the sidebar. Rows that haven't
  // reported yet fall back to null (treated as unsettled) — same as a
  // freshly mounted sidebar.
  const changeRequestState =
    changeRequestStateByKey.get(scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))) ??
    null;
  return !effectiveSettled(shell, {
    now: options.now,
    autoSettleAfterDays: options.autoSettleAfterDays,
    changeRequestState,
  });
}

/** All unsettled, unarchived threads across every connected environment that
    supports the sweep, most recently active first — the exact order the
    SWEEP_MAX_THREADS cap is applied in. */
export function collectSweepCandidates(): EnvironmentThreadShell[] {
  const now = new Date().toISOString();
  const autoSettleAfterDays = getClientSettings().sidebarAutoSettleAfterDays;
  const candidates: EnvironmentThreadShell[] = [];
  for (const ref of readThreadRefs()) {
    const shell = readThreadShell(ref);
    if (!shell) continue;
    const capabilities = readServerCapabilities(shell.environmentId);
    if (!isSweepCandidate(shell, capabilities, { now, autoSettleAfterDays })) continue;
    candidates.push(shell);
  }
  return sortSweepCandidates(candidates);
}

/** Most recently active first, so the SWEEP_MAX_THREADS cap drops the
    longest-idle threads rather than the oldest-created ones. Exported so
    the pre-run summary previews the exact capped selection. */
export function sortSweepCandidates(
  candidates: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell[] {
  const activityMs = (shell: EnvironmentThreadShell): number =>
    toSortableTimestamp(threadLastActivityAt(shell) ?? undefined) ??
    toSortableTimestamp(shell.createdAt) ??
    0;
  return [...candidates].sort((a, b) => activityMs(b) - activityMs(a));
}

async function reviewOne(runId: number, item: SweepItem): Promise<void> {
  const store = useReviewSweepStore.getState();
  if (store.runId !== runId) return;
  const key = scopedThreadKey(item.ref);
  store.patchItem(key, { status: "running" });

  const shell = readThreadShell(item.ref);
  const canSettleNow = shell !== null && canSettle(shell, { now: new Date().toISOString() });
  const result = await runAtomCommand(
    appAtomRegistry,
    reviewEnvironment.summarizeThread,
    {
      environmentId: item.ref.environmentId,
      input: { threadId: item.ref.threadId, canSettleNow },
    },
    { reportFailure: false, reportDefect: false },
  );

  const current = useReviewSweepStore.getState();
  if (current.runId !== runId) return;
  if (result._tag === "Success") {
    current.patchItem(key, { status: "done", result: result.value, errorMessage: null });
  } else {
    const error = squashAtomCommandFailure(result);
    current.patchItem(key, {
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Review failed.",
    });
  }
}

async function runPool(runId: number, items: ReadonlyArray<SweepItem>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(SWEEP_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      if (useReviewSweepStore.getState().runId !== runId) return;
      const item = items[next];
      next += 1;
      if (item) await reviewOne(runId, item);
    }
  });
  await Promise.all(workers);
  useReviewSweepStore.getState().finishRun(runId);
}

/** Kick off a sweep over every unsettled thread. Runs outside React so it
    survives navigation; results land in the store as they arrive. */
export function startReviewSweep(): void {
  const runId = useReviewSweepStore.getState().runId + 1;
  const candidates = collectSweepCandidates();
  const reviewed = candidates.slice(0, SWEEP_MAX_THREADS);
  const items = reviewed.map(
    (shell): SweepItem => ({
      ref: scopeThreadRef(shell.environmentId, shell.id),
      projectId: shell.projectId,
      threadTitle: shell.title,
      status: "pending",
      result: null,
      errorMessage: null,
      titleApplied: false,
      settleApplied: false,
      dismissed: false,
    }),
  );
  useReviewSweepStore.getState().startRun({
    runId,
    items,
    truncatedCount: candidates.length - reviewed.length,
  });
  if (items.length === 0) {
    useReviewSweepStore.getState().finishRun(runId);
    return;
  }
  void runPool(runId, items);
}

export function retrySweepItem(key: string): void {
  const store = useReviewSweepStore.getState();
  const item = store.items[key];
  if (!item || item.status === "running") return;
  void reviewOne(store.runId, item);
}

export async function applySweepTitle(key: string): Promise<boolean> {
  const store = useReviewSweepStore.getState();
  const runId = store.runId;
  const item = store.items[key];
  const suggestedTitle = item?.result?.suggestedTitle;
  if (!item || !suggestedTitle || item.titleApplied) return false;
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.updateMetadata,
    {
      environmentId: item.ref.environmentId,
      input: { threadId: item.ref.threadId, title: suggestedTitle },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to rename thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return false;
  }
  // The rename itself succeeded either way, but a Re-run mid-flight replaces
  // the item set with fresh reviews — don't stamp stale applied-state onto
  // the new run's card.
  const current = useReviewSweepStore.getState();
  if (current.runId === runId) {
    current.patchItem(key, { titleApplied: true, threadTitle: suggestedTitle });
  }
  return true;
}

export async function applySweepSettle(key: string): Promise<boolean> {
  const store = useReviewSweepStore.getState();
  const runId = store.runId;
  const item = store.items[key];
  if (!item || !item.result?.recommendSettle || item.settleApplied) return false;
  // Re-check against the live shell: the thread may have gone active since
  // the review ran, and settling live work would hide it.
  const shell = readThreadShell(item.ref);
  if (!shell || !canSettle(shell, { now: new Date().toISOString() })) {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Thread is active again",
        description: "This thread picked up new activity since the review, so it stays active.",
      }),
    );
    // The recommendation is now known-stale — withdraw it so the card stops
    // advertising a settle the live guard just refused.
    store.patchItem(key, {
      result: { ...item.result, recommendSettle: false, settleReason: null },
    });
    return false;
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.settle,
    {
      environmentId: item.ref.environmentId,
      input: { threadId: item.ref.threadId },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to settle thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return false;
  }
  // Same staleness guard as applySweepTitle: never patch a newer run's item.
  const current = useReviewSweepStore.getState();
  if (current.runId === runId) {
    current.patchItem(key, { settleApplied: true });
  }
  return true;
}

/** Sequentially apply every un-dismissed recommendation: titles first, then
    settles, tolerating per-item failures (each failure already toasts).
    Items are re-read from the store on every step so dismissals (and
    re-runs) mid-apply are respected. */
export async function applyAllSweepRecommendations(): Promise<void> {
  const { order, runId } = useReviewSweepStore.getState();
  for (const key of order) {
    const current = useReviewSweepStore.getState();
    if (current.runId !== runId) return;
    const item = current.items[key];
    if (!item || item.dismissed) continue;
    if (item.result?.suggestedTitle && !item.titleApplied) {
      await applySweepTitle(key);
    }
  }
  for (const key of order) {
    const current = useReviewSweepStore.getState();
    if (current.runId !== runId) return;
    const item = current.items[key];
    if (!item || item.dismissed) continue;
    if (item.result?.recommendSettle && !item.settleApplied) {
      await applySweepSettle(key);
    }
  }
}

export function dismissSweepItem(key: string): void {
  useReviewSweepStore.getState().patchItem(key, { dismissed: true });
}
