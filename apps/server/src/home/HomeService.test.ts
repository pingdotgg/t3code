import { assert, it } from "@effect/vitest";
import { ClientServerSettingsPatch, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as BotService from "../bots/BotService.ts";
import { makeOrchestration, model, provideBots } from "../bots/BotTestkit.ts";
import * as ServerConfig from "../config.ts";
import * as HomeService from "./HomeService.ts";

const decodeClientPatch = Schema.decodeUnknownSync(ClientServerSettingsPatch);

it.effect("enables Home as a Bot in its own folder, with no stale instructions file left", () => {
  const orchestration = makeOrchestration();
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const agents = path.join(config.baseDir, "home", "AGENTS.md");
    yield* fileSystem.makeDirectory(path.dirname(agents), { recursive: true });
    yield* fileSystem.writeFileString(agents, "Use home_notes_read.");

    const home = yield* HomeService.HomeService;
    const { threadId } = yield* home.enable({ modelSelection: model });
    assert.isTrue(threadId.startsWith("home:"));
    assert.deepStrictEqual(orchestration.threads.get(threadId)?.botConfig, {
      enabled: true,
      muteChildren: false,
    });
    // Enabling again returns the running Home.
    assert.strictEqual((yield* home.enable({})).threadId, threadId);
    assert.deepStrictEqual(yield* home.read, { enabled: true, threadId, modelSelection: model });
    assert.isFalse(yield* fileSystem.exists(agents));
  }).pipe(provideBots(orchestration));
});

it.effect("needs a model when neither the request nor the environment names one", () => {
  const orchestration = makeOrchestration();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const exit = yield* home.enable({}).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual((yield* home.read).enabled, false);
  }).pipe(provideBots(orchestration));
});

it.effect(
  "Start fresh moves the Bot grant, crew and memory to the new Home; disable ends the grant",
  () => {
    const orchestration = makeOrchestration();
    return Effect.gen(function* () {
      const home = yield* HomeService.HomeService;
      const bots = yield* BotService.BotService;
      const first = (yield* home.enable({ modelSelection: model })).threadId;
      orchestration.addThread("thread:crew", {
        projectId: "project:elsewhere" as never,
        groupedUnderThreadId: first,
      });
      yield* bots.addWatch(first, { workflowRunId: "run:watched", reason: "manual" });
      yield* bots.writeFile({ threadId: first, file: "notes", contents: "release train" });
      orchestration.threads.get(first)!.activeRunId = RunId.make("run:busy");

      const second = (yield* home.reset).threadId;
      assert.notStrictEqual(second, first);
      assert.isFalse(yield* bots.isBot(first));
      assert.isTrue(yield* bots.isBot(second));
      // A `home:` id is not the grant: only the current Home thread is.
      assert.isFalse(yield* bots.isBot(ThreadId.make("home:someone-else")));
      assert.deepStrictEqual(yield* bots.watches(first), []);
      assert.strictEqual(
        orchestration.threads.get(ThreadId.make("thread:crew"))?.groupedUnderThreadId,
        second,
      );
      assert.strictEqual((yield* bots.readFiles({ threadId: second })).notes, "release train");
      assert.deepStrictEqual(
        orchestration.dispatched
          .filter((command) => command.type !== "thread.metadata.update")
          .map((command) => [command.type, command.threadId]),
        [
          ["run.interrupt", first],
          ["thread.settle", first],
        ],
      );
      // The replaced Home cannot change Home's memory any more.
      const stale = yield* bots
        .writeFile({ threadId: first, file: "notes", contents: "x" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(stale));

      yield* home.disable;
      assert.isFalse(yield* bots.isBot(second));
      const after = yield* home.read;
      assert.deepStrictEqual(
        [after.enabled, after.threadId, after.modelSelection],
        [false, null, model],
      );
    }).pipe(provideBots(orchestration));
  },
);

it("drops `home` from client settings patches", () => {
  const patch = decodeClientPatch({
    defaultRuntimeMode: "full-access",
    home: { enabled: true, threadId: "home:forged", modelSelection: null },
  });
  assert.deepStrictEqual(patch, { defaultRuntimeMode: "full-access" });
});
