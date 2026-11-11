import * as Context from "effect/Context";
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
}

export const AgentTurn = Schema.Struct({ threadId: Schema.String, turnId: Schema.String });
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

/** Where agent steps run. The server implements it with threads; tests stand in for it. */
export class WorkflowAgents extends Context.Service<
  WorkflowAgents,
  {
    /** Start a turn. The same `key` is the same turn, however often it is asked for. */
    readonly start: (input: {
      readonly key: string;
      readonly title: string;
      readonly prompt: string;
      readonly outputSchema: Readonly<Record<string, Schema.Json>> | undefined;
      readonly model: AgentModel | undefined;
      /** The project a new thread is made in. Not needed to continue `thread`. */
      readonly project: string | undefined;
      /** Continue this thread instead of starting one. */
      readonly thread: string | undefined;
    }) => Effect.Effect<AgentTurn, WorkflowAgentError>;
    /** Wait for the turn to end and return what it produced. */
    readonly result: (turn: AgentTurn) => Effect.Effect<AgentResult, WorkflowAgentError>;
    /** Stop whatever the thread is doing, when its run is cancelled. */
    readonly interrupt: (threadId: string) => Effect.Effect<void, WorkflowAgentError>;
  }
>()("t3/workflows/WorkflowAgents") {}
