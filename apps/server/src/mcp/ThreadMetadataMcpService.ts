import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type ThreadMetadataMcpAction,
  type ThreadMetadataMcpUpdateInput,
  type ThreadMetadataMcpUpdateResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { assertTargetWithinLimits } from "./threadAccess.ts";

export class ThreadMetadataMcpService extends Context.Service<
  ThreadMetadataMcpService,
  {
    readonly update: (
      scope: McpInvocationScope,
      input: ThreadMetadataMcpUpdateInput,
    ) => Effect.Effect<ThreadMetadataMcpUpdateResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadMetadataMcpService") {}

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function threadLookupFailure(
  error: ThreadManagementService.ThreadManagementError,
): OrchestratorMcpFailure {
  return error._tag === "ThreadManagementThreadNotFoundError"
    ? failure("thread_not_found", error.message)
    : failure("orchestration_error", error.message);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function commandId(input: {
  readonly scope: McpInvocationScope;
  readonly threadId: ThreadId;
  readonly action: ThreadMetadataMcpAction;
  readonly requestKey: string;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.requestNamespace),
      "thread-update",
      stablePart(input.threadId),
      stablePart(input.action),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function metadataCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: OrchestrationV2AppThread["projectId"];
  readonly update: ThreadMetadataMcpUpdateInput;
}): Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }> {
  switch (input.update.action) {
    case "rename":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        title: input.update.title!,
      };
    case "regenerate_title":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        regenerateTitle: true,
      };
    case "link_pull_request":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        linkedPullRequest: {
          projectId: input.projectId,
          ...input.update.pullRequest!,
        },
      };
    case "unlink_pull_request":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        linkedPullRequest: null,
      };
  }
}

export function resultFromThread(input: {
  readonly action: ThreadMetadataMcpAction;
  readonly commandId: CommandId;
  readonly sequence: number;
  readonly thread: OrchestrationV2AppThread;
}): ThreadMetadataMcpUpdateResult {
  return {
    threadId: input.thread.id,
    action: input.action,
    commandId: input.commandId,
    sequence: input.sequence,
    title: input.thread.title,
    titleRegeneration:
      input.thread.titleRegeneration === undefined || input.thread.titleRegeneration === null
        ? null
        : {
            requestId: input.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(input.thread.titleRegeneration.startedAt),
          },
    linkedPullRequest: input.thread.linkedPullRequest ?? null,
    updatedAt: DateTime.formatIso(input.thread.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const update = Effect.fn("ThreadMetadataMcpService.update")(function* (
    scope: McpInvocationScope,
    input: ThreadMetadataMcpUpdateInput,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant orchestration capabilities.",
      );
    }

    const threadId = input.threadId ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* failure(
        "target_required",
        "Pass threadId: this MCP client is not running inside a T3 thread.",
      );
    }
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to locate thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* failure("thread_not_found", `Thread ${threadId} was not found.`);
    }
    // Another thread may only be changed if it runs within the caller's own modes.
    if (threadId !== scope.thread?.threadId) {
      const limits =
        scope.thread === undefined
          ? {
              runtimeMode: scope.client?.runtimeModeCeiling ?? ("approval-required" as const),
              interactionMode: "default" as const,
            }
          : yield* threadManagement.getThreadShell(scope.thread.threadId).pipe(
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Unable to locate calling thread: ${errorMessage(error)}`,
                ),
              ),
              Effect.flatMap((caller) =>
                caller === null
                  ? Effect.fail(failure("thread_not_found", "The calling thread was not found."))
                  : // Like every other cross-thread write, a thread caller needs its live run.
                    caller.archivedAt !== null ||
                      caller.activeRunId === null ||
                      caller.providerInstanceId !== scope.thread?.providerInstanceId
                    ? Effect.fail(
                        failure(
                          "parent_not_active",
                          "The calling provider no longer owns an active thread run.",
                        ),
                      )
                    : Effect.succeed({
                        runtimeMode: caller.runtimeMode,
                        interactionMode: caller.interactionMode,
                      }),
              ),
            );
      yield* assertTargetWithinLimits(limits, shell);
    }
    const target = yield* threadManagement
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [])
      .pipe(Effect.mapError(threadLookupFailure));
    const requestKey =
      input.clientRequestId === undefined
        ? yield* crypto.randomUUIDv4.pipe(Effect.orDie)
        : input.clientRequestId;
    const updateCommandId = commandId({
      scope,
      threadId,
      action: input.action,
      requestKey,
    });
    const dispatched = yield* threadManagement
      .dispatch(
        metadataCommand({
          commandId: updateCommandId,
          threadId,
          projectId: target.thread.projectId,
          update: input,
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to ${input.action} for thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    const metadataEvent = dispatched.storedEvents.find(
      (stored) => stored.event.type === "thread.metadata-updated",
    );
    if (metadataEvent === undefined || metadataEvent.event.type !== "thread.metadata-updated") {
      return yield* failure(
        "orchestration_error",
        `Thread ${threadId} metadata update completed without a resultant state.`,
      );
    }
    return resultFromThread({
      action: input.action,
      commandId: updateCommandId,
      sequence: dispatched.sequence,
      thread: metadataEvent.event.payload,
    });
  });

  return ThreadMetadataMcpService.of({ update });
});

export const layer: Layer.Layer<
  ThreadMetadataMcpService,
  never,
  Crypto.Crypto | ThreadManagementService.ThreadManagementService
> = Layer.effect(ThreadMetadataMcpService, make);
