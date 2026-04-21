import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CodexAppServerClient } from "./client.ts";

export const CodexAppServerReplayEntry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("expect_outbound"),
    label: Schema.optional(Schema.String),
    frame: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("emit_inbound"),
    label: Schema.optional(Schema.String),
    frame: Schema.Unknown,
    afterMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_exit"),
    status: Schema.Literals(["success", "error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  }),
]);
export type CodexAppServerReplayEntry = typeof CodexAppServerReplayEntry.Type;

export const CodexAppServerReplayTranscript = Schema.Struct({
  provider: Schema.Literal("codex"),
  protocol: Schema.Literal("codex.app-server"),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(CodexAppServerReplayEntry),
});
export type CodexAppServerReplayTranscript = typeof CodexAppServerReplayTranscript.Type;

export class CodexAppServerReplayLayerNotImplementedError extends Schema.TaggedErrorClass<CodexAppServerReplayLayerNotImplementedError>()(
  "CodexAppServerReplayLayerNotImplementedError",
  {
    scenario: Schema.String,
  },
) {
  override get message(): string {
    return `Codex app-server replay layer is not implemented for scenario ${this.scenario}.`;
  }
}

export const CodexAppServerReplayError = Schema.Union([
  CodexAppServerReplayLayerNotImplementedError,
]);
export type CodexAppServerReplayError = typeof CodexAppServerReplayError.Type;

export function layerReplay(
  transcript: CodexAppServerReplayTranscript,
): Layer.Layer<CodexAppServerClient, CodexAppServerReplayError> {
  return Layer.effect(
    CodexAppServerClient,
    Effect.fail(
      new CodexAppServerReplayLayerNotImplementedError({
        scenario: transcript.scenario,
      }),
    ),
  );
}
