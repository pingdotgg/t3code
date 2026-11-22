import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type BotProfile } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as BotStore from "./BotStore.ts";

const bot: BotProfile = {
  threadId: ThreadId.make("bot:thread"),
  projectId: ProjectId.make("project"),
  state: "active",
  access: { writeSources: [], handoffProjects: [] },
  revision: 1,
  name: "Project assistant",
  role: "Project assistant",
  description: "",
  icon: "",
  color: "#6366f1",
  instructions: "Summarize changes.",
};

it.effect("preserves bot identity, versions, and lifecycle across edits and creation retries", () =>
  Effect.gen(function* () {
    const store = yield* BotStore.BotStore;
    assert.deepEqual(yield* store.create(bot), bot);
    const edited = yield* store.update(bot.threadId, 1, {
      ...bot,
      instructions: "Review changes.",
    });
    const conflict = yield* store.update(bot.threadId, 1, bot).pipe(Effect.flip);
    assert.equal(conflict.reason, "conflict");
    assert.deepEqual(yield* store.create(bot), edited);
    assert.equal((yield* store.setState(bot.threadId, "paused")).state, "paused");
    const history = yield* store.history(bot.threadId);
    assert.deepEqual(
      history.map(({ revision, instructions }) => [revision, instructions]),
      [
        [2, "Review changes."],
        [1, "Summarize changes."],
      ],
    );
    assert.equal((yield* store.find(bot.threadId))?.state, "paused");
  }).pipe(Effect.provide(BotStore.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);

it.effect("keeps bot write and handoff grants separate from the editable profile", () =>
  Effect.gen(function* () {
    const store = yield* BotStore.BotStore;
    yield* store.create(bot);
    const access = {
      writeSources: ["scheduled"] as const,
      handoffProjects: [ProjectId.make("handoff-project")],
    };
    yield* store.setAccess(bot.threadId, access);
    const changed = yield* store.update(bot.threadId, 1, { ...bot, name: "Renamed" });
    assert.deepEqual(changed.access, access);
    assert.deepEqual((yield* store.find(bot.threadId))?.access, access);
  }).pipe(Effect.provide(BotStore.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);
