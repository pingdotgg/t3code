// Written the way an agent with only the skill would write it.
// @effect-diagnostics globalDateInEffect:off globalJsonInEffect:off
// The mistake the replay case exists for: the time is read by the body, so a replay reads it again.
export default ({
  workflow,
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
      const time = Date.now();
      const signal = yield* wait("go", { returns: Schema.String });
      if (Option.isNone(signal)) return yield* stop("no signal");
      return `${payload.label}:${time}:${signal.value}`;
    }),
  ),
];
