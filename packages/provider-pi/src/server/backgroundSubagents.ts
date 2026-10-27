import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Extensions publish RPC metadata with appendEntry(), independently of tool
// names, formatted output, and model-visible result delivery.
const Lifecycle = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.NonEmptyString,
  toolCallId: Schema.NonEmptyString,
  status: Schema.Literals(["running", "completed", "failed", "interrupted"]),
  title: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  progress: Schema.optional(Schema.NullOr(Schema.String)),
  result: Schema.optional(Schema.NullOr(Schema.String)),
});
const Entry = Schema.Struct({
  type: Schema.Literal("custom"),
  customType: Schema.Literal("t3-subagent"),
  data: Lifecycle,
});
const decode = Schema.decodeUnknownOption(Entry);

export type PiBackgroundSubagentUpdate = typeof Lifecycle.Type;

export function piBackgroundSubagentEntryUpdate(entry: unknown): PiBackgroundSubagentUpdate | null {
  const decoded = decode(entry);
  if (Option.isNone(decoded)) return null;
  const data = decoded.value.data;
  return {
    ...data,
    ...(data.title === undefined ? {} : { title: data.title.slice(0, 160) }),
    ...(data.prompt === undefined ? {} : { prompt: data.prompt.slice(0, 10_000) }),
    ...(data.model === undefined ? {} : { model: data.model?.slice(0, 512) ?? null }),
    ...(data.progress === undefined ? {} : { progress: data.progress?.slice(0, 200) ?? null }),
    ...(data.result === undefined ? {} : { result: data.result?.slice(0, 10_000) ?? null }),
  };
}
