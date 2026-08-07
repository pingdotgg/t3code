import {
  RuntimeTaskUsage,
  type ProviderRuntimeEvent,
  type RuntimeTaskUsage as RuntimeTaskUsageType,
} from "@t3tools/contracts";
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
import { decide, type AgentRun } from "./AgentRun.ts";

const decodeUsage = Schema.decodeUnknownOption(RuntimeTaskUsage);

export class AgentTerminalHookPrerequisiteError extends Schema.TaggedErrorClass<AgentTerminalHookPrerequisiteError>()(
  "AgentTerminalHookPrerequisiteError",
  {
    stage: Schema.Literals(["afterResult", "onError"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Agent terminal hook prerequisites failed during ${this.stage}: ${this.detail}`;
  }
}

export const completeSuccessfulRun = Effect.fn("AgentRunReactor.completeSuccessfulRun")(
  function* (input: {
    readonly run: AgentRun;
    readonly usage: RuntimeTaskUsageType | undefined;
    readonly occurredAt: string;
    readonly repository: AgentRunRepository.AgentRunRepository["Service"];
    readonly afterResult: Effect.Effect<
      void,
      AgentHookRunner.AgentHookBlockedError | AgentTerminalHookPrerequisiteError
    >;
  }) {
    const command = {
      type: "agent-run.succeed" as const,
      runId: input.run.id,
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      occurredAt: input.occurredAt,
    };
    // Provider completion events are consumed sequentially and their timestamp
    // is fixed, so this preflight cannot drift while the hook is evaluated.
    const lineage = yield* input.repository.listByLineage(input.run.rootRunId);
    const preflight = yield* decide(
      { runs: new Map(lineage.map((run) => [run.id, run])) },
      command,
    ).pipe(Effect.result);
    if (Result.isFailure(preflight)) {
      if (
        preflight.failure._tag === "AgentRunCommandInvariantError" &&
        preflight.failure.reason === "budget-exhausted"
      ) {
        yield* input.repository.dispatch({
          type: "agent-run.fail",
          runId: input.run.id,
          failure: preflight.failure.detail,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
          occurredAt: input.occurredAt,
        });
        return;
      }
      return yield* preflight.failure;
    }

    const hook = yield* input.afterResult.pipe(Effect.result);
    if (Result.isFailure(hook)) {
      yield* input.repository.dispatch({
        type: "agent-run.fail",
        runId: input.run.id,
        failure: hook.failure.detail,
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        occurredAt: input.occurredAt,
      });
      return;
    }

    const completion = yield* input.repository.dispatch(command).pipe(Effect.result);
    if (
      Result.isFailure(completion) &&
      completion.failure._tag === "AgentRunCommandInvariantError" &&
      completion.failure.reason === "budget-exhausted"
    ) {
      yield* input.repository.dispatch({
        type: "agent-run.fail",
        runId: input.run.id,
        failure: completion.failure.detail,
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        occurredAt: input.occurredAt,
      });
      return;
    }
    if (Result.isFailure(completion)) return yield* completion.failure;
  },
);

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
      const child = yield* projection
        .getThreadShellById(run.childThreadId)
        .pipe(Effect.map(Option.getOrNull));
      if (child?.worktreePath) return child.worktreePath;
    }
    return yield* projection.getProjectShellById(run.projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.map((project) => project?.workspaceRoot ?? null),
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
      Effect.mapError(
        (cause) =>
          new AgentTerminalHookPrerequisiteError({
            stage,
            detail: "Could not load the pinned Agent profile snapshot.",
            cause,
          }),
      ),
    );
    const workspaceRoot = yield* hookWorkspace(run).pipe(
      Effect.mapError(
        (cause) =>
          new AgentTerminalHookPrerequisiteError({
            stage,
            detail: "Could not resolve the Agent hook workspace.",
            cause,
          }),
      ),
    );
    if (profile === null || workspaceRoot === null) {
      const missing =
        profile === null
          ? workspaceRoot === null
            ? "profile snapshot and workspace root"
            : "profile snapshot"
          : "workspace root";
      return yield* new AgentTerminalHookPrerequisiteError({
        stage,
        detail: `The ${missing} is unavailable.`,
      });
    }
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
          yield* completeSuccessfulRun({
            run,
            usage: Option.getOrUndefined(usage),
            occurredAt: event.createdAt,
            repository,
            afterResult: runTerminalHook(run, "afterResult"),
          });
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
