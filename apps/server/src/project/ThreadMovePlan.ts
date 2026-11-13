import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjectMoveCommand,
  type OrchestrationV2ThreadProjection,
  type ProviderThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { PendingOrchestrationEffectV2 } from "../orchestration-v2/EffectOutbox.ts";
import {
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "../sourceControl/threadPullRequests.ts";
import {
  moveReceiptTurnItem,
  threadMoveMemberNotice,
  threadMoveReceiptMessage,
  type ThreadMoveReceiptInput,
} from "./ThreadMoveReceipt.ts";

export interface ThreadMoveMember {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerSessions" | "providerThreads" | "runs"
  >;
  readonly previousFolder: string;
  readonly storageFolders: ReadonlyMap<ProviderThreadId, string>;
  readonly nextOrdinal: number;
}

export interface ThreadMovePlanInput {
  readonly command: OrchestrationV2ThreadProjectMoveCommand;
  /** The named thread first, then the members that move with it. */
  readonly members: ReadonlyArray<ThreadMoveMember>;
  readonly folder: string;
  readonly folderChanged: boolean;
  readonly receipt: ThreadMoveReceiptInput;
  readonly now: DateTime.Utc;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
}

const DETACH_REASON = "Workspace changed.";

export const planThreadMove = Effect.fn("ThreadMovePlan.planThreadMove")(function* (
  input: ThreadMovePlanInput,
) {
  const { command, now } = input;
  const events: Array<OrchestrationV2DomainEvent> = [];
  const effects: Array<PendingOrchestrationEffectV2> = [];
  const emit = Effect.fn("ThreadMovePlan.emit")(function* <
    Event extends OrchestrationV2DomainEvent,
  >(event: Omit<Event, "id" | "occurredAt">) {
    const id = yield* input.idAllocator.allocate.event({
      threadId: event.threadId,
      commandId: command.commandId,
    });
    events.push({ ...event, id, occurredAt: now } as Event);
  });
  const threadTitle = input.members[0]?.projection.thread.title ?? "";
  for (const [index, member] of input.members.entries()) {
    const { thread, providerSessions, providerThreads, runs } = member.projection;
    const { id: threadId, providerInstanceId } = thread;
    const effect = (suffix: string, request: PendingOrchestrationEffectV2["request"]) =>
      effects.push({
        id: `effect:${command.commandId}:${request.type}:${suffix}`,
        commandId: command.commandId,
        threadId,
        request,
      });
    const moved = {
      ...thread,
      projectId: command.projectId,
      worktreePath: command.worktreePath,
      branch: null,
      branchPullRequest: null,
      updatedAt: now,
    };
    yield* emit({ type: "thread.metadata-updated", threadId, providerInstanceId, payload: moved });
    const tracked = thread.branch === null ? null : thread.branchPullRequest;
    if (tracked != null) {
      const key = legacyThreadPullRequestKey(tracked);
      const links = threadPullRequestsOf(moved);
      const existing = links.find((link) => threadPullRequestKeysEqual(link, key));
      if (existing === undefined || existing.source === "stack-dismissed") {
        const link = existing ?? {
          ...key,
          url: tracked.url,
          linkedAt: DateTime.formatIso(now),
          snapshot: null,
          stack: null,
        };
        yield* emit({
          type: "thread.pull-request-synced",
          threadId,
          providerInstanceId,
          payload: {
            ...moved,
            pullRequests: [
              ...links.filter((other) => other !== existing),
              { ...link, source: "manual" },
            ],
          },
        });
      }
    }
    if (input.folderChanged) {
      // A run from before runs recorded their folder would otherwise take the root scope's,
      // which the next turn moves here.
      for (const run of runs) {
        if (run.cwd !== undefined) continue;
        yield* emit({
          type: "run.updated",
          threadId,
          providerInstanceId: run.providerInstanceId,
          payload: { ...run, cwd: member.previousFolder },
        });
      }
      for (const session of providerSessions) {
        if (session.status === "stopped" || session.status === "error") continue;
        yield* emit({
          type: "provider-session.detached",
          threadId,
          driver: session.driver,
          providerInstanceId: session.providerInstanceId,
          payload: { providerSessionId: session.id, detachedAt: now, reason: DETACH_REASON },
        });
        effect(session.id, {
          type: "provider-session.detach",
          providerSessionId: session.id,
          detail: DETACH_REASON,
        });
      }
      for (const providerThread of providerThreads) {
        const nativeSessionId = providerThread.nativeThreadRef?.nativeId;
        if (providerThread.driver !== "claudeAgent" || nativeSessionId == null) continue;
        effect(providerThread.id, {
          type: "provider-session.relocate-storage",
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          providerThreadId: providerThread.id,
          nativeSessionId,
          oldFolder: member.storageFolders.get(providerThread.id) ?? member.previousFolder,
          newFolder: input.folder,
        });
      }
    }
    yield* emit({
      type: "turn-item.updated",
      threadId,
      payload: moveReceiptTurnItem({
        id: TurnItemId.make(`${command.commandId}:receipt:${threadId}`),
        threadId,
        ordinal: member.nextOrdinal,
        movedAt: now,
        previousFolder: member.previousFolder,
        message:
          index === 0
            ? threadMoveReceiptMessage(input.receipt)
            : threadMoveMemberNotice(threadTitle, input.folder),
      }),
    });
    effect(threadId, {
      type: "scheduled-tasks.move",
      threadIds: [threadId],
      projectId: command.projectId,
    });
  }
  return { events, effects };
});
