import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export type FrontAction = "reply" | "delegate" | "note" | "none";

export interface FrontDecision {
  readonly action: FrontAction;
  readonly speech: string;
  readonly task?: string;
}

export interface FrontMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export class FrontModelError extends Schema.TaggedError<FrontModelError>()("FrontModelError", {
  operation: Schema.Literals(["download", "load", "decide"]),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const base = `The voice front model failed to ${this.operation}.`;
    return this.detail ? `${base} ${this.detail}` : base;
  }
}

export interface FrontModelSession {
  /** Output forced through a JSON schema, so it always decodes. A shared message prefix reuses the KV cache. Interrupting the effect aborts generation. */
  readonly decide: (
    messages: readonly FrontMessage[],
  ) => Effect.Effect<FrontDecision, FrontModelError>;
}

export class FrontModel extends Context.Service<
  FrontModel,
  {
    /** Loads the configured model (managed GGUF, or the OpenAI-compatible URL override) and keeps it loaded for the scope, e.g. one call. */
    readonly acquire: Effect.Effect<FrontModelSession, FrontModelError, Scope.Scope>;
  }
>()("t3/voice/FrontModel") {}
