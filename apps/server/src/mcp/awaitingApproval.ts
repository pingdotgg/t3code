import * as Schema from "effect/Schema";

/**
 * A tool's answer while the person it asked has not answered yet. Nothing was done and nothing
 * failed: the request is still in the thread, and the same call made again goes on waiting.
 */
export const AwaitingApproval = Schema.Struct({
  status: Schema.Literal("awaiting_approval"),
  next: Schema.String.annotate({ description: "What to do now." }),
});
export type AwaitingApproval = typeof AwaitingApproval.Type;

/** The result of a tool that asks a person first: what it returns once done, or that it waits. */
export const orAwaitingApproval = <S extends Schema.Top>(done: S) =>
  Schema.Union([done, AwaitingApproval]);
