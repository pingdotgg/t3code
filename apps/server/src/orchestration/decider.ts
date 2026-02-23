import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<Omit<OrchestrationEvent, "sequence">, OrchestrationCommandInvariantError> {
  const eventId = crypto.randomUUID();

  switch (command.type) {
    case "thread.create":
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        eventId,
        type: "thread.created",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          id: command.threadId,
          projectId: command.projectId,
          title: command.title,
          model: command.model,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    case "thread.delete":
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        eventId,
        type: "thread.deleted",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          id: command.threadId,
          deletedAt: command.createdAt,
        },
      };
    case "thread.meta.update":
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        eventId,
        type: "thread.meta-updated",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          updatedAt: command.createdAt,
        },
      };
    case "message.send":
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        eventId,
        type: "message.sent",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          id: command.messageId,
          role: command.role,
          text: command.text,
          threadId: command.threadId,
          createdAt: command.createdAt,
          streaming: command.streaming === true,
        },
      };
    case "thread.session":
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        eventId,
        type: "thread.session-set",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    case "git.readModel.upsert":
      return {
        eventId,
        type: "git.read-model-upsert",
        aggregateType: "project",
        aggregateId: command.projectId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          projectId: command.projectId,
          branch: command.branch,
          hasWorkingTreeChanges: command.hasWorkingTreeChanges,
          aheadCount: command.aheadCount,
          behindCount: command.behindCount,
          updatedAt: command.createdAt,
        },
      };
    case "thread.turnDiff.complete":
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        eventId,
        type: "thread.turn-diff-completed",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          completedAt: command.completedAt,
          ...(command.status !== undefined ? { status: command.status } : {}),
          files: command.files,
          ...(command.assistantMessageId !== undefined
            ? { assistantMessageId: command.assistantMessageId }
            : {}),
          ...(command.checkpointTurnCount !== undefined
            ? { checkpointTurnCount: command.checkpointTurnCount }
            : {}),
        },
      };
    case "thread.activity.append":
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        eventId,
        type: "thread.activity-appended",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    case "thread.revert":
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* requireNonNegativeInteger({
        commandType: command.type,
        field: "turnCount",
        value: command.turnCount,
      });
      yield* requireNonNegativeInteger({
        commandType: command.type,
        field: "messageCount",
        value: command.messageCount,
      });
      return {
        eventId,
        type: "thread.reverted",
        aggregateType: "thread",
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          messageCount: command.messageCount,
        },
      };
    default: {
      command satisfies never;
      const fallback = command as any;
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
