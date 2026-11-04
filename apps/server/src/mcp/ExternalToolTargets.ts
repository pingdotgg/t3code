import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Targets = Schema.Record(
  Schema.String,
  Schema.Struct({
    endpoint: Schema.String,
    operations: Schema.Array(Schema.String),
  }),
);

const decodeTargets = Schema.decodeUnknownEffect(Schema.fromJsonString(Targets));

export const readTargets = Effect.gen(function* () {
  const raw = yield* Config.String("T3CODE_EXTERNAL_TOOL_TARGETS").pipe(Config.withDefault("{}"));
  const targets = yield* decodeTargets(raw);
  for (const target of Object.values(targets)) {
    const url = yield* Effect.try(() => new URL(target.endpoint));
    if (
      url.search ||
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
    )
      return yield* Effect.fail({ _tag: "InvalidExternalToolTarget" as const });
  }
  return targets;
}).pipe(
  Effect.catch(() =>
    Effect.logWarning("External tool configuration is invalid; targets disabled.").pipe(
      Effect.as({} as typeof Targets.Type),
    ),
  ),
);
