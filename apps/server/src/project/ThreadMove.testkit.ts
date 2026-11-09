import {
  EventId,
  MessageId,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

export function threadCreated(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly parent?: ThreadId | undefined;
  readonly kind?: "fork" | "side" | "subagent" | undefined;
  readonly branch?: string | null | undefined;
  readonly branchPullRequest?: OrchestrationV2AppThread["branchPullRequest"];
}) {
  const { threadId } = input;
  const providerInstanceId = input.providerInstanceId ?? ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: input.projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath,
    ...(input.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: input.branchPullRequest }),
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: input.parent ?? null,
      relationshipToParent: input.kind === "side" ? "fork" : (input.kind ?? null),
      rootThreadId: input.parent ?? threadId,
      ...(input.kind === "side" ? { sideChat: true } : {}),
    },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created" as const,
    threadId,
    providerInstanceId,
    occurredAt: createdAt,
    payload,
  };
}

/** An idle Claude provider thread holding the native session `nativeId`. */
export function providerThread(input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeId: string;
}): OrchestrationV2ProviderThread {
  return {
    id: ProviderThreadId.make(input.id),
    driver: claudeDriver,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: null,
    appThreadId: input.threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: claudeDriver, nativeId: input.nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export function runCreated(input: {
  readonly id: RunId;
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId?: ProviderThreadId | null | undefined;
  readonly rootNodeId?: NodeId | null | undefined;
  readonly cwd?: string | undefined;
  readonly occurredAt?: DateTime.Utc | undefined;
}) {
  const occurredAt = input.occurredAt ?? createdAt;
  return {
    id: EventId.make(`run-created:${input.id}`),
    type: "run.created" as const,
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    occurredAt,
    payload: {
      id: input.id,
      threadId: input.threadId,
      ordinal: input.ordinal,
      providerInstanceId: input.providerInstanceId,
      modelSelection: { instanceId: input.providerInstanceId, model: "gpt-5" },
      providerThreadId: input.providerThreadId ?? null,
      userMessageId: MessageId.make(`message:${input.id}`),
      rootNodeId: input.rootNodeId ?? null,
      activeAttemptId: null,
      status: "completed" as const,
      requestedAt: occurredAt,
      startedAt: occurredAt,
      completedAt: occurredAt,
      checkpointId: null,
      contextHandoffId: null,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    },
  };
}
