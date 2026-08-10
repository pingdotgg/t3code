import {
  CommandId,
  EventId,
  RuntimeTaskUsage,
  type ThreadId,
  type ProviderRuntimeEvent,
  type RuntimeTaskUsage as RuntimeTaskUsageType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";
import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";

import * as AgentHookRunner from "../AgentHookRunner.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import * as AgentRunRepository from "./AgentRunRepository.ts";
import { decide, type AgentRun, type AgentRunEvent } from "./AgentRun.ts";

const decodeUsage = Schema.decodeUnknownOption(RuntimeTaskUsage);
const TERMINAL_EVENT_RETRY_SCHEDULE = Schedule.exponential("100 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);
const retryDurable = <A, R>(
  effect: Effect.Effect<A, AgentRunRepository.AgentRunRepositoryError, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag !== "AgentRunCommandInvariantError",
      schedule: TERMINAL_EVENT_RETRY_SCHEDULE,
    }),
  );

type AgentRunTaskStatus =
  | "started"
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export const revisionAfterAgentRunTransition = (
  run: Pick<AgentRun, "id" | "revision">,
  events: ReadonlyArray<AgentRunEvent>,
): number => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.runId === run.id) return event.revision;
  }
  return run.revision;
};

export const cancelledAgentRunRevision = (
  run: Pick<AgentRun, "id">,
  events: ReadonlyArray<AgentRunEvent>,
): number | null => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "agent-run.cancelled" && event.runId === run.id) return event.revision;
  }
  return null;
};

export const failedAgentRunRevision = (
  run: Pick<AgentRun, "id">,
  events: ReadonlyArray<AgentRunEvent>,
): number | null => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "agent-run.result-failed" && event.runId === run.id) {
      return event.revision;
    }
  }
  return null;
};

const agentRunTaskActivityDetails = (input: {
  readonly run: Pick<
    AgentRun,
    "id" | "parentThreadId" | "parentRunId" | "profile" | "modelSelection" | "revision"
  >;
  readonly status: AgentRunTaskStatus;
  readonly createdAt: string;
  readonly title?: string;
}) => {
  const terminal =
    input.status === "completed" || input.status === "failed" || input.status === "cancelled";
  const activityId = `agent-run:${input.run.id}:${input.run.revision}:${input.status}`;
  return {
    commandId: CommandId.make(activityId),
    threadId: input.run.parentThreadId,
    activity: {
      id: EventId.make(activityId),
      tone: input.status === "failed" ? ("error" as const) : ("info" as const),
      kind:
        input.status === "started"
          ? ("task.started" as const)
          : terminal
            ? ("task.completed" as const)
            : ("task.updated" as const),
      summary: `Agent run ${input.status}`,
      payload: {
        taskId: input.run.id,
        agentKind: "agent",
        ...(input.title === undefined ? {} : { title: input.title }),
        model: input.run.modelSelection.model,
        agentProfileId: input.run.profile.id,
        ...(input.run.parentRunId === null ? {} : { parentAgentId: input.run.parentRunId }),
        ...(input.status === "started" ? {} : { status: input.status }),
      },
      turnId: null,
      createdAt: input.createdAt,
    },
  };
};

export const appendAgentRunTaskActivity = Effect.fn("AgentRunReactor.appendAgentRunTaskActivity")(
  function* (input: {
    readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
    readonly run: Pick<
      AgentRun,
      "id" | "parentThreadId" | "parentRunId" | "profile" | "modelSelection" | "revision"
    >;
    readonly status: AgentRunTaskStatus;
    readonly createdAt: string;
    readonly title?: string;
  }) {
    const activity = agentRunTaskActivityDetails(input);
    yield* input.engine
      .dispatch({
        type: "thread.activity.append",
        commandId: activity.commandId,
        threadId: activity.threadId,
        activity: activity.activity,
        createdAt: input.createdAt,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not append Agent run parent task activity", {
            runId: input.run.id,
            parentThreadId: input.run.parentThreadId,
            status: input.status,
            cause,
          }),
        ),
      );
  },
);

export const hookWorkspaceForRun = (
  run: Pick<AgentRun, "workspaceMode" | "childThreadId">,
  childWorktreePath: string | null,
  projectWorkspaceRoot: string | null,
) =>
  run.workspaceMode === "isolated-worktree"
    ? run.childThreadId === null
      ? null
      : childWorktreePath
    : (childWorktreePath ?? projectWorkspaceRoot);

/** Keep repository failures in the error channel so the stream retry retains the event. */
export const loadAgentRunForProviderEvent = Effect.fn(
  "AgentRunReactor.loadAgentRunForProviderEvent",
)(function* (
  repository: Pick<AgentRunRepository.AgentRunRepository["Service"], "getByChildThread">,
  threadId: ThreadId,
) {
  return yield* repository.getByChildThread(threadId).pipe(Effect.map(Option.getOrNull));
});

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
    const lineage = yield* retryDurable(input.repository.listByLineage(input.run.rootRunId));
    const preflight = yield* decide(
      { runs: new Map(lineage.map((run) => [run.id, run])) },
      command,
    ).pipe(Effect.result);
    if (Result.isFailure(preflight)) {
      if (
        preflight.failure._tag === "AgentRunCommandInvariantError" &&
        preflight.failure.reason === "budget-exhausted"
      ) {
        const failed = yield* retryDurable(
          input.repository.dispatch({
            type: "agent-run.fail",
            runId: input.run.id,
            failure: preflight.failure.detail,
            ...(input.usage === undefined ? {} : { usage: input.usage }),
            occurredAt: input.occurredAt,
          }),
        );
        return {
          status: "failed" as const,
          revision: revisionAfterAgentRunTransition(input.run, failed),
        };
      }
      return yield* preflight.failure;
    }

    const hook = yield* input.afterResult.pipe(Effect.result);
    if (Result.isFailure(hook)) {
      const failed = yield* retryDurable(
        input.repository.dispatch({
          type: "agent-run.fail",
          runId: input.run.id,
          failure: hook.failure.detail,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
          occurredAt: input.occurredAt,
        }),
      );
      return {
        status: "failed" as const,
        revision: revisionAfterAgentRunTransition(input.run, failed),
      };
    }

    const completion = yield* retryDurable(input.repository.dispatch(command)).pipe(Effect.result);
    if (
      Result.isFailure(completion) &&
      completion.failure._tag === "AgentRunCommandInvariantError" &&
      completion.failure.reason === "budget-exhausted"
    ) {
      const failed = yield* retryDurable(
        input.repository.dispatch({
          type: "agent-run.fail",
          runId: input.run.id,
          failure: completion.failure.detail,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
          occurredAt: input.occurredAt,
        }),
      );
      return {
        status: "failed" as const,
        revision: revisionAfterAgentRunTransition(input.run, failed),
      };
    }
    if (Result.isFailure(completion)) return yield* completion.failure;
    return {
      status: "completed" as const,
      revision: revisionAfterAgentRunTransition(input.run, completion.success),
    };
  },
);

const make = Effect.gen(function* () {
  const repository = yield* AgentRunRepository.AgentRunRepository;
  const provider = yield* ProviderService.ProviderService;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const hooks = yield* AgentHookRunner.AgentHookRunner;

  const hookWorkspace = Effect.fn("AgentRunReactor.hookWorkspace")(function* (
    run: NonNullable<
      Effect.Success<ReturnType<typeof repository.get>> extends Option.Option<infer A> ? A : never
    >,
  ) {
    const childWorktreePath =
      run.childThreadId === null
        ? null
        : yield* projection.getThreadShellById(run.childThreadId).pipe(
            Effect.map(Option.getOrNull),
            Effect.map((child) => child?.worktreePath ?? null),
          );
    if (run.workspaceMode === "isolated-worktree") {
      return hookWorkspaceForRun(run, childWorktreePath, null);
    }
    if (childWorktreePath !== null) return childWorktreePath;
    const projectWorkspaceRoot = yield* projection.getProjectShellById(run.projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.map((project) => project?.workspaceRoot ?? null),
    );
    return hookWorkspaceForRun(run, childWorktreePath, projectWorkspaceRoot);
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
    const run = yield* retryDurable(loadAgentRunForProviderEvent(repository, event.threadId));
    if (run === null) return;

    switch (event.type) {
      case "turn.completed": {
        if (run.status !== "running" && run.status !== "waiting-for-input") return;
        const usage = decodeUsage(event.payload.usage);
        if (event.payload.state === "completed") {
          const status = yield* completeSuccessfulRun({
            run,
            usage: Option.getOrUndefined(usage),
            occurredAt: event.createdAt,
            repository,
            afterResult: runTerminalHook(run, "afterResult"),
          });
          yield* appendAgentRunTaskActivity({
            engine,
            run: { ...run, revision: status.revision },
            status: status.status,
            createdAt: event.createdAt,
          });
          return;
        }
        yield* runTerminalHook(run, "onError").pipe(Effect.ignore);
        const failed = yield* retryDurable(
          repository.dispatch({
            type: "agent-run.fail",
            runId: run.id,
            failure:
              event.payload.errorMessage ??
              event.payload.stopReason ??
              `Provider turn ${event.payload.state}.`,
            ...(Option.isSome(usage) ? { usage: usage.value } : {}),
            occurredAt: event.createdAt,
          }),
        );
        yield* appendAgentRunTaskActivity({
          engine,
          run: { ...run, revision: revisionAfterAgentRunTransition(run, failed) },
          status: "failed",
          createdAt: event.createdAt,
        });
        return;
      }
      case "turn.aborted":
        if (run.status === "running" || run.status === "waiting-for-input") {
          yield* runTerminalHook(run, "onError").pipe(Effect.ignore);
          const failed = yield* retryDurable(
            repository.dispatch({
              type: "agent-run.fail",
              runId: run.id,
              failure: event.payload.reason,
              occurredAt: event.createdAt,
            }),
          );
          yield* appendAgentRunTaskActivity({
            engine,
            run: { ...run, revision: revisionAfterAgentRunTransition(run, failed) },
            status: "failed",
            createdAt: event.createdAt,
          });
        }
        return;
      case "runtime.error":
        if (run.status === "running" || run.status === "waiting-for-input") {
          yield* runTerminalHook(run, "onError").pipe(Effect.ignore);
          const failed = yield* retryDurable(
            repository.dispatch({
              type: "agent-run.fail",
              runId: run.id,
              failure: event.payload.message,
              occurredAt: event.createdAt,
            }),
          );
          yield* appendAgentRunTaskActivity({
            engine,
            run: { ...run, revision: revisionAfterAgentRunTransition(run, failed) },
            status: "failed",
            createdAt: event.createdAt,
          });
        }
        return;
      case "user-input.requested":
        if (run.status === "running") {
          const waiting = yield* retryDurable(
            repository.dispatch({
              type: "agent-run.wait",
              runId: run.id,
              occurredAt: event.createdAt,
            }),
          );
          yield* appendAgentRunTaskActivity({
            engine,
            run: { ...run, revision: revisionAfterAgentRunTransition(run, waiting) },
            status: "waiting",
            createdAt: event.createdAt,
          });
        }
        return;
      case "user-input.resolved":
        if (run.status === "waiting-for-input") {
          const resumed = yield* retryDurable(
            repository.dispatch({
              type: "agent-run.resume",
              runId: run.id,
              occurredAt: event.createdAt,
            }),
          );
          yield* appendAgentRunTaskActivity({
            engine,
            run: { ...run, revision: revisionAfterAgentRunTransition(run, resumed) },
            status: "running",
            createdAt: event.createdAt,
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
