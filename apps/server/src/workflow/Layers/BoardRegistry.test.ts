import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";

const layer = it.layer(BoardRegistryLive);

const def = {
  name: "wf",
  lanes: [
    { key: "backlog", name: "Backlog", entry: "manual" },
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
      ],
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

layer("BoardRegistry", (it) => {
  it.effect("registers a definition and resolves lanes", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-1" as never, def);
      const lane = yield* registry.getLane("b-1" as never, "impl" as never);
      assert.equal(lane?.entry, "auto");
      assert.equal(lane?.pipeline?.length, 1);
    }),
  );

  it.effect("rejects an invalid definition", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const result = yield* Effect.exit(
        registry.register("b-2" as never, {
          name: "bad",
          lanes: [{ key: "a", name: "A", entry: "auto", on: { success: "ghost" } }],
        }),
      );
      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("rejects invalid WIP limits during registration", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const result = yield* Effect.exit(
        registry.register("b-invalid-wip" as never, {
          name: "bad wip",
          lanes: [
            { key: "backlog", name: "Backlog", entry: "manual", wipLimit: 0 },
            { key: "done", name: "Done", entry: "manual", terminal: true, wipLimit: 1 },
          ],
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.isTrue(result.cause.toString().includes("invalid_wip_limit"));
      }
    }),
  );

  it.effect("registers an already-decoded workflow definition with retention duration", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-retention" as never, {
        name: "retention",
        lanes: [
          { key: "backlog", name: "Backlog", entry: "manual" },
          {
            key: "done",
            name: "Done",
            entry: "manual",
            terminal: true,
            retention: Duration.days(7),
          },
        ],
      });

      const lane = yield* registry.getLane("b-retention" as never, "done" as never);
      assert.equal(
        Duration.toMillis((lane as any)?.retention),
        Duration.toMillis(Duration.days(7)),
      );
    }),
  );

  it.effect("unregister removes a registered definition", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-3" as never, def);
      yield* registry.unregister("b-3" as never);
      assert.isNull(yield* registry.getDefinition("b-3" as never));
    }),
  );
});
