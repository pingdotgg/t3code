import type { ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

/** A project named by its folder instead of its id. */
export const isProjectPath = (project: string) => project.startsWith("/");

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
    /** Stop whatever the thread is doing, when its run is cancelled. */
    readonly interrupt: (thread: {
      readonly threadId: string;
      readonly environment?: string | undefined;
    }) => Effect.Effect<void, WorkflowAgentError>;
  }
>()("t3/workflows/WorkflowAgents") {}
