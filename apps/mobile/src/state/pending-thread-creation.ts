import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationThread } from "@t3tools/contracts";
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";

/**
 * A new task navigates to its thread screen the moment it is queued, before the
 * server has created the thread. Until the shell arrives the screen renders a
 * stand-in built from the queued creation. The outcome recorded by the outbox
 * drain covers the two windows that stand-in cannot: the gap between delivery
 * and the first turn (keep showing setup) and a rejected creation
 * (the drain restored the content into the project draft; offer to reopen it).
 */
export type PendingThreadCreationOutcome =
  | { readonly kind: "delivered"; readonly message: QueuedThreadMessage }
  | { readonly kind: "failed"; readonly message: QueuedThreadMessage; readonly reason: string };

export type PendingThreadCreation = {
  readonly message: QueuedThreadMessage;
  readonly outcome: PendingThreadCreationOutcome | null;
};

/** Keep the screen's creation state until its detail can take over the pill. */
export function resolvePendingThreadCreation(input: {
  readonly threadKey: string | null;
  readonly pending: PendingThreadCreation | null;
  readonly previous: PendingThreadCreation | null;
  readonly detail: {
    readonly messages: ReadonlyArray<{ readonly id: string }>;
    readonly latestTurn: { readonly turnId: string } | null;
    readonly session: { readonly status: string } | null;
  } | null;
}): PendingThreadCreation | null {
  const creation = input.pending ?? input.previous;
  if (
    creation === null ||
    scopedThreadKey(creation.message.environmentId, creation.message.threadId) !== input.threadKey
  ) {
    return null;
  }
  if (creation.outcome?.kind === "failed") return creation;
  const detail = input.detail;
  if (
    detail?.session?.status === "error" ||
    detail?.session?.status === "stopped" ||
    detail?.session?.status === "interrupted"
  )
    return null;
  // Message delivery and turn startup are separate events. The prompt alone
  // cannot replace the preparing pill; wait for the turn's timing too. Retain
  // the local creation if the outbox has already collected its shell outcome.
  if (
    detail !== null &&
    detail.latestTurn !== null &&
    !isPendingThreadCreationVisible({
      creationMessageId: creation.message.messageId,
      loadedMessageIds: detail.messages.map((message) => message.id),
    })
  ) {
    return null;
  }
  return creation;
}

export const pendingThreadCreationOutcomesAtom = Atom.make<
  Readonly<Record<string, PendingThreadCreationOutcome>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:pending-thread-creation:outcomes"));

export function recordPendingThreadCreationOutcome(outcome: PendingThreadCreationOutcome): void {
  const key = scopedThreadKey(outcome.message.environmentId, outcome.message.threadId);
  appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {
    ...appAtomRegistry.get(pendingThreadCreationOutcomesAtom),
    [key]: outcome,
  });
}

export function clearPendingThreadCreationOutcome(threadKey: string): void {
  const current = appAtomRegistry.get(pendingThreadCreationOutcomesAtom);
  if (!current[threadKey]) {
    return;
  }
  const next = { ...current };
  delete next[threadKey];
  appAtomRegistry.set(pendingThreadCreationOutcomesAtom, next);
}

/**
 * Whether the queued prompt still has to stand in for the real message.
 *
 * The server creates the thread, then builds the worktree, and only then
 * starts the turn, so the thread shell and an empty detail arrive seconds
 * ahead of the prompt. Keying this on the shell's arrival left the thread
 * showing "No conversation yet" for that whole window. The queued message id
 * is reused as the delivered message id, so its presence is the exact signal.
 */
export function isPendingThreadCreationVisible(input: {
  readonly creationMessageId: string;
  /** Null while no detail has loaded; empty during a worktree checkout. */
  readonly loadedMessageIds: ReadonlyArray<string> | null;
}): boolean {
  return !input.loadedMessageIds?.includes(input.creationMessageId);
}

export function pendingThreadCreationMessage(
  message: QueuedThreadMessage,
): OrchestrationThread["messages"][number] {
  return {
    id: message.messageId,
    role: "user",
    text: message.text,
    // Deliberately no attachments. Their ids are local draft ids the server
    // cannot resolve, so the feed's attachment rows would sit on a spinner
    // that only ends when the real message arrives — and never, if the
    // creation is rejected. The delivered message renders them moments later.
    turnId: null,
    streaming: false,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  };
}

/**
 * Thread shell shaped from a queued creation. `modelSelection` is required on
 * the shell; a creation is only sendable with one, so the fallback never sends.
 */
export function pendingThreadCreationShell(
  message: QueuedThreadMessage,
): EnvironmentThreadShell | null {
  const creation = message.creation;
  if (!creation || !message.modelSelection) {
    return null;
  }
  return {
    environmentId: message.environmentId,
    id: message.threadId,
    projectId: creation.projectId,
    title: deriveThreadTitleFromPrompt(message.text),
    modelSelection: message.modelSelection,
    runtimeMode: message.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: message.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: creation.branch,
    worktreePath: creation.workspaceMode === "worktree" ? null : creation.worktreePath,
    linkedPullRequest: null,
    latestTurn: null,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    latestUserMessageAt: message.createdAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}
