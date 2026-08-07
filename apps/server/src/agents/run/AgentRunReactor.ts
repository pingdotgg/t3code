import { RuntimeTaskUsage, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";

import * as AgentHookRunner from "../AgentHookRunner.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import * as AgentRunRepository from "./AgentRunRepository.ts";

const decodeUsage = Schema.decodeUnknownOption(RuntimeTaskUsage);

const make = Effect.gen(function* () {
  const repository = yield* AgentRunRepository.AgentRunRepository;
  const provider = yield* ProviderService.ProviderService;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const hooks = yield* AgentHookRunner.AgentHookRunner;

  const hookWorkspace = Effect.fn("AgentRunReactor.hookWorkspace")(function* (
    run: NonNullable<
      Effect.Success<ReturnType<typeof repository.get>> extends Option.Option<infer A> ? A : never
    >,
  ) {
    if (run.childThreadId !== null) {
      const child = yield* projection.getThreadShellById(run.childThreadId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (child?.worktreePath) return child.worktreePath;
    }
    return yield* projection.getProjectShellById(run.projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.map((project) => project?.workspaceRoot ?? null),
      Effect.orElseSucceed(() => null),
    );
  });

  const runTerminalHook = Effect.fn("AgentRunReactor.runTerminalHook")(function* (
    run: NonNullable<
      Effect.Success<ReturnType<typeof repository.get>> extends Option.Option<infer A> ? A : never
    >,
    stage: "afterResult" | "onError",
  ) {
    const profile = yield* repository.getProfileSnapshot(run.profile.revision).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    const workspaceRoot = yield* hookWorkspace(run);
    if (profile === null || workspaceRoot === null) return;
    yield* hooks.run({ profile, stage, workspaceRoot });
  });

  const handle = Effect.fn("AgentRunReactor.handle")(function* (event: ProviderRuntimeEvent) {
    const run = yield* repository.getByChildThread(event.threadId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    if (run === null) return;

    switch (event.type) {
      case "turn.completed": {
        if (run.status !== "running" && run.status !== "waiting-for-input") return;
        const usage = decodeUsage(event.payload.usage);
        if (event.payload.state === "completed") {
          const hook = yield* runTerminalHook(run, "afterResult").pipe(Effect.result);
          if (hook._tag === "Failure") {
            yield* repository.dispatch({
              type: "agent-run.fail",
              runId: run.id,
              failure: hook.failure.detail,
              ...(Option.isSome(usage) ? { usage: usage.value } : {}),
              occurredAt: event.createdAt,
            });
            return;
          }
          const completion = yield* repository
            .dispatch({
              type: "agent-run.succeed",
              runId: run.id,
              ...(Option.isSome(usage) ? { usage: usage.value } : {}),
              occurredAt: event.createdAt,
            })
            .pipe(Effect.result);
          if (
            Result.isFailure(completion) &&
            completion.failure._tag === "AgentRunCommandInvariantError" &&
            completion.failure.detail.includes("budget is exhausted")
          ) {
            yield* repository.dispatch({
              type: "agent-run.fail",
              runId: run.id,
              failure: completion.failure.detail,
              ...(Option.isSome(usage) ? { usage: usage.value } : {}),
              occurredAt: event.createdAt,
            });
            return;
          }
          if (Result.isFailure(completion)) return yield* completion.failure;
          return;
        }
        yield* runTerminalHook(run, "onError").pipe(Effect.ignore);
        yield* repository.dispatch({
          type: "agent-run.fail",
          runId: run.id,
          failure:
            event.payload.errorMessage ??
            event.payload.stopReason ??
            `Provider turn ${event.payload.state}.`,
          ...(Option.isSome(usage) ? { usage: usage.value } : {}),
          occurredAt: event.createdAt,
        });
        return;
      }
      case "turn.aborted":
        if (run.status === "running" || run.status === "waiting-for-input") {
          yield* runTerminalHook(run, "onError").pipe(Effect.ignore);
          yield* repository.dispatch({
            type: "agent-run.fail",
            runId: run.id,
            failure: event.payload.reason,
            occurredAt: event.createdAt,
          });
        }
        return;
      case "runtime.error":
        if (run.status === "running" || run.status === "waiting-for-input") {
          yield* runTerminalHook(run, "onError").pipe(Effect.ignore);
          yield* repository.dispatch({
            type: "agent-run.fail",
            runId: run.id,
            failure: event.payload.message,
            occurredAt: event.createdAt,
          });
        }
        return;
      case "user-input.requested":
        if (run.status === "running") {
          yield* repository.dispatch({
            type: "agent-run.wait",
            runId: run.id,
            occurredAt: event.createdAt,
          });
        }
        return;
      case "user-input.resolved":
        if (run.status === "waiting-for-input") {
          yield* repository.dispatch({
            type: "agent-run.resume",
            runId: run.id,
            occurredAt: event.createdAt,
          });
        }
        return;
      default:
        return;
    }
  });

  yield* provider.streamEvents.pipe(
    Stream.runForEach((event) =>
      handle(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Agent run reactor could not process provider event", {
            threadId: event.threadId,
            eventType: event.type,
            cause,
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
