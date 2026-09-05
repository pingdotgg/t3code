import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type ThreadAttentionState = "ready" | "input" | "approval" | "failed";

export interface ThreadAttentionItem {
  readonly thread: EnvironmentThreadShell;
  readonly threadKey: string;
  readonly state: ThreadAttentionState;
  readonly occurredAt: string;
  readonly attentionKey: string;
}

type AttentionInput = {
  readonly thread: EnvironmentThreadShell;
  readonly threadKey: string;
  readonly lastVisitedAt: string | undefined;
  readonly acknowledgedAttentionKey: string | undefined;
};

function isNewerTimestamp(candidate: string, reference: string | undefined): boolean {
  if (!reference) return true;
  const candidateMs = Date.parse(candidate);
  const referenceMs = Date.parse(reference);
  return Number.isNaN(referenceMs) || candidateMs > referenceMs;
}

function resolveAttentionState(thread: EnvironmentThreadShell): ThreadAttentionState | null {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failed";
  }
  if (thread.hasActionableProposedPlan || thread.latestTurn?.state === "completed") {
    return "ready";
  }
  return null;
}

function resolveOccurredAt(thread: EnvironmentThreadShell, state: ThreadAttentionState): string {
  if (state === "ready" && thread.latestTurn?.completedAt) {
    return thread.latestTurn.completedAt;
  }
  return thread.updatedAt;
}

export function resolveThreadAttention(input: AttentionInput): ThreadAttentionItem | null {
  const { thread, threadKey, lastVisitedAt, acknowledgedAttentionKey } = input;
  if (thread.archivedAt !== null) return null;

  const state = resolveAttentionState(thread);
  if (!state) return null;

  const occurredAt = resolveOccurredAt(thread, state);
  const attentionKey = `${state}:${occurredAt}`;
  if (attentionKey === acknowledgedAttentionKey) return null;

  if (state === "ready" && !isNewerTimestamp(occurredAt, lastVisitedAt)) {
    return null;
  }

  return { thread, threadKey, state, occurredAt, attentionKey };
}

export function sortAttentionItems(items: readonly ThreadAttentionItem[]): ThreadAttentionItem[] {
  return [...items].toSorted(
    (left, right) =>
      Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
      left.threadKey.localeCompare(right.threadKey),
  );
}

export function resolveNextAttentionThreadKey(input: {
  readonly items: readonly ThreadAttentionItem[];
  readonly currentThreadKey: string | null;
}): string | null {
  if (input.items.length === 0) return null;
  if (input.currentThreadKey === null) return input.items[0]?.threadKey ?? null;

  const currentIndex = input.items.findIndex((item) => item.threadKey === input.currentThreadKey);
  if (currentIndex === -1) return input.items[0]?.threadKey ?? null;
  return input.items[(currentIndex + 1) % input.items.length]?.threadKey ?? null;
}

export function attentionNotificationTitle(item: ThreadAttentionItem): string {
  return `${item.state}: ${item.thread.title}`;
}
