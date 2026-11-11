// Written the way an agent with only the skill would write it.
// @effect-diagnostics globalDateInEffect:off globalJsonInEffect:off
export default ({
  workflow,
  step,
  wait,
  stop,
  Effect,
  Schema,
  Option,
}: typeof import("../../../apps/server/src/workflows/api.ts")) => [
  workflow(
    "stamp",
    { version: 1, payload: Schema.Struct({ label: Schema.String }), returns: Schema.String },
    Effect.fn(function* (payload) {
      const time = yield* step(
        "read-time",
        { returns: Schema.Number },
        Effect.sync(() => Date.now()),
      );
      const signal = yield* wait("go", { returns: Schema.String });
      if (Option.isNone(signal)) return yield* stop("no signal");
      return `${payload.label}:${time}:${signal.value}`;
    }),
  ),
];
