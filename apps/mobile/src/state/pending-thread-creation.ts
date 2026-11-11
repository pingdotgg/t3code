import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { LocalThreadMessage } from "../lib/threadActivity";
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { Atom } from "effect/reactivity";
import * as DateTime from "effect/DateTime";

import { deriveThreadTitleFromPrompt } from "../lib/projectThreadStartTurn";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";

export type PendingThreadCreationOutcome =
  | { readonly kind: "delivered"; readonly message: QueuedThreadMessage }
  | { readonly kind: "failed"; readonly message: QueuedThreadMessage; readonly reason: string };

export type PendingThreadCreation = {
  readonly message: QueuedThreadMessage;
  readonly outcome: PendingThreadCreationOutcome | null;
};

export function selectThreadCreationDetail<Ref>(input: {
  readonly threadRef: Ref | null;
  readonly threadKey: string | null;
  readonly queuedMessagesByThreadKey: Readonly<
    Record<string, ReadonlyArray<QueuedThreadMessage> | undefined>
  >;
  readonly outcomes: Readonly<Record<string, PendingThreadCreationOutcome | undefined>>;
}): { readonly pendingCreation: PendingThreadCreation | null; readonly detailRef: Ref | null } {
  const pendingCreation = ((): PendingThreadCreation | null => {
    if (input.threadKey === null) {
      return null;
    }
    const queued = input.queuedMessagesByThreadKey[input.threadKey]?.find(
      (message) => message.creation !== undefined,
    );
    const outcome = input.outcomes[input.threadKey] ?? null;
    const message = queued ?? outcome?.message ?? null;
    return message === null ? null : { message, outcome };
  })();
  // The shell can arrive before creation is acknowledged. Wait for delivery
  // before subscribing: an early not-found is cached as a deleted thread.
  // Every detail reader must use this ref, not the route id.
  const detailRef =
    pendingCreation === null || pendingCreation.outcome?.kind === "delivered"
      ? input.threadRef
      : null;
  return { pendingCreation, detailRef };
}

export function resolvePendingThreadCreation(input: {
  readonly threadKey: string | null;
  readonly pending: PendingThreadCreation | null;
  readonly previous: PendingThreadCreation | null;
  readonly detail: {
    readonly messages: ReadonlyArray<{ readonly id: string }>;
    readonly runs: ReadonlyArray<{ readonly status: string }>;
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
  const latestRun = detail?.runs.at(-1);
  const terminalStatus = latestRun?.status;
  if (
    terminalStatus === "failed" ||
    terminalStatus === "cancelled" ||
    terminalStatus === "interrupted"
  )
    return null;
  // Message delivery can precede startup; wait for turn timing before replacing the preparing pill.
  if (
    detail !== null &&
    latestRun !== undefined &&
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

/** Thread shell and empty detail precede the prompt: worktree setup runs between creation and turn start. */
function isPendingThreadCreationVisible(input: {
  readonly creationMessageId: string;
  readonly loadedMessageIds: ReadonlyArray<string> | null;
}): boolean {
  return !input.loadedMessageIds?.includes(input.creationMessageId);
}

export function pendingThreadCreationMessage(message: QueuedThreadMessage): LocalThreadMessage {
  return {
    id: message.messageId,
    role: "user",
    text: message.text,
    context: message.context,
    // Local draft ids cannot resolve server-side and would spin forever on rejected creation.
    streaming: false,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  };
}

/**
 * Threads this client is launching read as preparing from Send until their first run lands.
 * The server commits the thread before its run, so the list would otherwise place it twice.
 */
export function withLaunchingThreads(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly launches: ReadonlyArray<QueuedThreadMessage>;
  readonly hiddenThreadKeys: ReadonlySet<string>;
}): ReadonlyArray<EnvironmentThreadShell> {
  if (input.launches.length === 0) return input.threads;
  const launchByKey = new Map<string, QueuedThreadMessage>();
  for (const message of input.launches) {
    if (!message.creation || input.hiddenThreadKeys.has(threadKey(message))) continue;
    launchByKey.set(scopedThreadKey(message.environmentId, message.threadId), message);
  }
  if (launchByKey.size === 0) return input.threads;
  const threads = input.threads.map((thread) => {
    const key = scopedThreadKey(thread.environmentId, thread.id);
    const launch = launchByKey.get(key);
    if (!launch) return thread;
    launchByKey.delete(key);
    return thread.latestRun === null && thread.runtime === null
      ? { ...thread, runtime: launchingRuntime(thread) }
      : thread;
  });
  for (const launch of launchByKey.values()) {
    const shell = pendingThreadCreationShell(launch);
    if (shell) threads.push({ ...shell, runtime: launchingRuntime(shell) });
  }
  return threads;
}

function launchingRuntime(thread: EnvironmentThreadShell): EnvironmentThreadShell["runtime"] {
  return {
    status: "preparing",
    activeRunId: null,
    providerInstanceId: thread.providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: thread.updatedAt,
  };
}

export function pendingThreadCreationShell(
  message: QueuedThreadMessage,
): EnvironmentThreadShell | null {
  const creation = message.creation;
  if (!creation || !message.modelSelection) {
    return null;
  }
  const timestamp = DateTime.makeUnsafe(message.createdAt);
  return presentThreadShell(message.environmentId, {
    id: message.threadId,
    projectId: creation.projectId,
    title: deriveThreadTitleFromPrompt(message.text),
    providerInstanceId: message.modelSelection.instanceId,
    modelSelection: message.modelSelection,
    runtimeMode: message.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: message.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: creation.branch,
    pullRequests: [],
    worktreePath: creation.workspaceMode === "worktree" ? null : creation.worktreePath,
    linkedPullRequest: null,
    branchPullRequest: null,
    lineage: { rootThreadId: message.threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "mobile",
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status: "preparing",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: timestamp,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    deletedAt: null,
  });
}
