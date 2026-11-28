// Written the way an agent with only the skill would write it.
// @effect-diagnostics globalDateInEffect:off
// A replay in the same process finds the time it kept; a restarted server does not.
const { workflow, wait, stop } = T3;

let time: number | undefined;

export default [
  workflow(
    "stamp",
    { version: 1, payload: Schema.Struct({ label: Schema.String }), returns: Schema.String },
    Effect.fn(function* (payload) {
      time ??= Date.now();
      const signal = yield* wait("go", { returns: Schema.String });
      if (Option.isNone(signal)) return yield* stop("no signal");
      return `${payload.label}:${time}:${signal.value}`;
    }),
  ),
];
