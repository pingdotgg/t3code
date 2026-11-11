// Written the way an agent with only the skill would write it.
// @effect-diagnostics globalDateInEffect:off globalJsonInEffect:off
export default ({
  workflow,
  agent,
  ask,
  stop,
  daily,
  Tick,
  Effect,
  Schema,
  Option,
}: typeof import("../../../apps/server/src/workflows/api.ts")) => [
  workflow(
    "todo-sweep",
    { version: 1, payload: Tick, triggers: [daily("09:00", { weekdays: [1, 2, 3, 4, 5] })] },
    Effect.fn(function* () {
      const found = yield* agent("list", {
        project: "proj-1",
        brief: "List the TODO comments in this repository. Do not change any file.",
        output: Schema.Struct({
          todos: Schema.Array(
            Schema.Struct({ file: Schema.String, line: Schema.Number, text: Schema.String }),
          ),
        }),
      });
      if (found.value.todos.length === 0) return yield* stop("no TODO comments");
      const answer = yield* ask("fix", {
        title: `Fix ${found.value.todos.length} TODO comments?`,
        choices: ["fix", "skip"],
        data: found.value,
        timeout: "1 day",
      });
      if (Option.isNone(answer) || answer.value.choice === "skip")
        return yield* stop("not approved");
      yield* agent("fix-them", {
        thread: found.thread,
        brief: "Fix the TODO comments you listed.",
      });
    }),
  ),
];
