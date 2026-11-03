import {
  CommandId,
  IDLE_COMPACTION_TEXT,
  MessageId,
  isCompactionCommandMessage,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Below this a cold re-read of a finished step is cheap, so compacting would mostly lose context.
 * Separate from the 200K idle-compaction threshold, which also waits for the cache to run low.
 */
export const PIPELINE_COMPACTION_MIN_TOKENS = 50_000;

export type PipelineCompactionRecords = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "messages"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
  | "contextTransfers"
>;

/**
 * The run a pipeline step's `/compact` would follow, or null when the thread should be left alone.
 * Unlike idle compaction there is no cache window and no settled or lineage rule: the step's toggle
 * is the only switch.
 */
export function pipelineCompactionTarget(
  {
    thread,
    runs,
    messages,
    providerThreads,
    providerTurns,
    runtimeRequests,
    turnItems,
    contextTransfers,
  }: PipelineCompactionRecords,
  environment: { readonly providerCanCompact: boolean; readonly instanceEnabled: boolean },
): { readonly runId: (typeof runs)[number]["id"] } | null {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (!environment.providerCanCompact || !environment.instanceEnabled) return null;
  const latestRun = runs.reduce<(typeof runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  if (latestRun?.status !== "completed") return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  // Never compact a compaction.
  if (message === undefined || isCompactionCommandMessage(message)) return null;
  if (
    runtimeRequests.some((request) => request.status === "pending") ||
    // A pending merge-back belongs to the next real message; compaction would swallow it.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    // Background work reports into the next turn; compaction would swallow it.
    derivePendingBackgroundWork({
      latestRun,
      runs,
      providerThreads,
      turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  )
    return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  // The thread's current selection receives the /compact, so it must still be this run's session.
  if (
    providerThread === undefined ||
    providerThread.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId
  )
    return null;
  const latestUsage = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  // Unknown usage compacts: the provider never reported it, so the thread may well be large.
  if (latestUsage !== undefined && latestUsage.usedTokens < PIPELINE_COMPACTION_MIN_TOKENS) {
    return null;
  }
  return { runId: latestRun.id };
}

export interface PipelineStepCompactionDeps {
  readonly threads: Pick<
    ThreadManagementService.ThreadManagementServiceShape,
    "getProjectThreadRecords" | "isProviderInstanceEnabledForProject" | "dispatch"
  >;
  readonly providerCanCompact: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;
}

/**
 * Whether the thread's latest run is a `/compact`, whose result is a summary, not the step's answer.
 */
export const latestRunIsCompaction = Effect.fn("PipelineStepCompaction.latestRunIsCompaction")(
  function* (
    threads: Pick<ThreadManagementService.ThreadManagementServiceShape, "getProjectThreadRecords">,
    target: { readonly projectId: ProjectId; readonly threadId: ThreadId },
  ) {
    const { runs } = yield* threads.getProjectThreadRecords(target, ["runs"], {
      runStatuses: [],
      includeLatestRun: true,
    });
    const latestRun = runs.reduce<(typeof runs)[number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
    if (latestRun === null) return false;
    const { messages } = yield* threads.getProjectThreadRecords(target, ["messages"], {
      messageIds: [latestRun.userMessageId],
    });
    return messages.some(isCompactionCommandMessage);
  },
);

/**
 * Sends a server `/compact` into a finished step's thread without waiting for it. One id per
 * `key`, so a replayed driver sends nothing twice while a later relaunch may compact again. Never
 * fails: the pipeline must not notice a compaction that was refused.
 */
export const compactStepThread = Effect.fn("PipelineStepCompaction.compact")(
  function* (
    deps: PipelineStepCompactionDeps,
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId; readonly key: string },
  ) {
    const target = { projectId: input.projectId, threadId: input.threadId };
    const { thread } = yield* deps.threads.getProjectThreadRecords(target, [], {});
    const activeProviderThreadId = thread.activeProviderThreadId;
    // Without an active provider thread there is no session to compact.
    if (activeProviderThreadId === null) return;
    const records = yield* deps.threads.getProjectThreadRecords(
      target,
      [
        "runs",
        "providerThreads",
        "providerTurns",
        "runtimeRequests",
        "turnItems",
        "contextTransfers",
      ],
      {
        turnItemStatuses: ["pending", "running", "waiting"],
        runStatuses: ["preparing", "starting", "running", "rolled_back"],
        includeLatestRun: true,
        providerThreadIds: [activeProviderThreadId],
        providerTurnThreadIds: [activeProviderThreadId],
        latestProviderTurnUsageOnly: true,
        runtimeRequestStatuses: ["pending"],
        contextTransferStatuses: ["pending"],
      },
    );
    const latestRun = records.runs.reduce<(typeof records.runs)[number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
    if (latestRun === null) return;
    const { messages } = yield* deps.threads.getProjectThreadRecords(target, ["messages"], {
      messageIds: [latestRun.userMessageId],
    });
    const decision = pipelineCompactionTarget(
      { ...records, messages },
      {
        providerCanCompact: yield* deps.providerCanCompact(records.thread.providerInstanceId),
        instanceEnabled: yield* deps.threads.isProviderInstanceEnabledForProject({
          projectId: input.projectId,
          instanceId: records.thread.providerInstanceId,
        }),
      },
    );
    if (decision === null) return;
    yield* deps.threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:pipeline-compact:${input.key}`),
      messageId: MessageId.make(`pipeline-compact:${input.key}`),
      threadId: input.threadId,
      text: IDLE_COMPACTION_TEXT,
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      // The marker keeps notifications, unread state and labels quiet, and skips the turn's
      // checkpoint so it cannot claim the next step's edits in a shared worktree.
      idleCompaction: "beforeCacheExpires",
      dispatchMode: { type: "start_immediately" },
    });
  },
  (effect, _deps, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("pipeline step compaction skipped", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
);
