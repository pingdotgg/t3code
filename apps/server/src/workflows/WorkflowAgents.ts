import type {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { isWindowsDrivePath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { IssueAddress } from "./WorkflowForge.ts";

export class WorkflowAgentError extends Schema.TaggedError<WorkflowAgentError>()(
  "WorkflowAgentError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface AgentModel {
  readonly instanceId: string;
  readonly model: string;
  /** The model's own options, such as reasoning effort, as `{ id, value }` pairs. */
  readonly options?: ModelSelection["options"];
}

/** How a new thread starts, as `t3_thread_launch` takes it. Unset fields follow the project. */
export interface AgentLaunch {
  /** Where its files are: the project's checkout by default, or a worktree of its own. */
  readonly workspace?: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
}

export const AgentTurn = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  /** The linked environment the thread is in. Absent for this one. */
  environment: Schema.optional(Schema.String),
  /** When the step's first turn started, which its time limit counts from. */
  startedAt: Schema.optional(Schema.Number),
  /** Why no turn was started, for a step that takes that as an answer. The ids are then empty. */
  failed: Schema.optional(Schema.String),
});
export type AgentTurn = typeof AgentTurn.Type;

export const AgentResult = Schema.Struct({
  /**
   * How the turn ended. `stopped` is someone ending it on purpose, which is not a reason to try
   * again; `failed` is the turn dying underneath the agent.
   */
  ending: Schema.Literals(["completed", "failed", "stopped"]),
  detail: Schema.String,
  reply: Schema.String,
  /** What the agent submitted against the output schema, when it did. */
  output: Schema.optional(Schema.Json),
});
export type AgentResult = typeof AgentResult.Type;

/** What a continued thread says to options that only shape a new one. */
export const launchOnContinue = new WorkflowAgentError({
  reason:
    "`workspace`, `runtimeMode` and `interactionMode` shape a new thread. A continued `thread` keeps how it started.",
});

/** A project named by its folder instead of its id. */
export const isProjectPath = (project: string) =>
  project.startsWith("/") || isWindowsDrivePath(project);

/** Where agent steps run. The server implements it with threads; tests stand in for it. */
export class WorkflowAgents extends Context.Service<
  WorkflowAgents,
  {
    /** Start a turn. The same `key` is the same turn, however often it is asked for. */
    readonly start: (input: {
      readonly key: string;
      /** The run and step this turn is for, which a new thread is marked with. */
      readonly origin: { readonly runId: string; readonly workflow: string; readonly step: string };
      readonly title: string;
      readonly prompt: string;
      readonly outputSchema: Readonly<Record<string, Schema.Json>> | undefined;
      readonly model: AgentModel | undefined;
      /** The project a new thread is made in: its id, or its folder. Not needed to continue `thread`. */
      readonly project: string | undefined;
      /** The linked environment to run in. Absent for this one. */
      readonly environment: string | undefined;
      /** Continue this thread instead of starting one. */
      readonly thread: string | undefined;
      /** An issue the thread is about, which it is linked to. */
      readonly issue?: IssueAddress | undefined;
      /** How a new thread starts. Refused with `thread`, which keeps how it started. */
      readonly launch?: AgentLaunch | undefined;
    }) => Effect.Effect<AgentTurn, WorkflowAgentError>;
    /**
     * Wait for the turn to end and return what it produced. With `quiet`, a turn that ended
     * without the output it owes is waited past: its agent may be waiting to be woken, and
     * submits from a later turn. Only once the thread has done nothing for `quiet` is the turn
     * returned without output.
     */
    readonly result: (
      turn: AgentTurn,
      options?: { readonly quiet?: Duration.Duration | undefined },
    ) => Effect.Effect<AgentResult, WorkflowAgentError>;
    /**
     * Stop whatever the thread is doing, when its run is cancelled. `ended` when there was nothing
     * to stop: the turn had already ended.
     */
    readonly interrupt: (thread: {
      readonly threadId: string;
      readonly environment?: string | undefined;
      /** The step's own turn. With it, a turn of someone else's on the same thread is left alone. */
      readonly turnId?: string | undefined;
    }) => Effect.Effect<"stopped" | "ended", WorkflowAgentError>;
  }
>()("t3/workflows/WorkflowAgents") {}
