import {
  BranchThreadError,
  type BranchThreadInput,
  type BranchThreadResult,
  CommandId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { selectThreadBranchContext } from "../../../orchestration/ThreadBranching.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

export interface ThreadBranchCoordinatorShape {
  readonly branch: (
    scope: McpInvocationScope,
    input: BranchThreadInput,
  ) => Effect.Effect<BranchThreadResult, BranchThreadError>;
}

export class ThreadBranchCoordinator extends Context.Service<
  ThreadBranchCoordinator,
  ThreadBranchCoordinatorShape
>()("t3/mcp/toolkits/agents/ThreadBranchCoordinator") {}

const makeThreadBranchCoordinator = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;

  const branch: ThreadBranchCoordinatorShape["branch"] = Effect.fn(
    "ThreadBranchCoordinator.branch",
  )(function* (scope, input) {
    const source = yield* snapshots.getThreadDetailById(scope.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new BranchThreadError({
            reason: "dispatch-failed",
            description: `Failed to read the current thread: ${String(cause)}`,
          }),
      ),
    );
    if (Option.isNone(source)) {
      return yield* new BranchThreadError({
        reason: "caller-thread-not-found",
        description: "The calling session's thread no longer exists; it cannot be branched.",
      });
    }

    const threadUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const commandUuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const title = input.title ?? `Branch of ${source.value.title}`;
    const context = selectThreadBranchContext(source.value.messages);
    const threadId = ThreadId.make(threadUuid);

    yield* engine
      .dispatch({
        type: "thread.branch",
        commandId: CommandId.make(`server:thread-branch:${commandUuid}`),
        sourceThreadId: scope.threadId,
        threadId,
        title,
        createdAt,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new BranchThreadError({
              reason: "dispatch-failed",
              description: `Failed to branch the current thread: ${String(cause)}`,
            }),
        ),
      );

    return {
      threadId,
      sourceThreadId: scope.threadId,
      title,
      copiedMessageCount: context.messages.length,
      omittedMessageCount: context.omittedMessageCount,
    };
  });

  return ThreadBranchCoordinator.of({ branch });
});

export const ThreadBranchCoordinatorLive = Layer.effect(
  ThreadBranchCoordinator,
  makeThreadBranchCoordinator,
);
