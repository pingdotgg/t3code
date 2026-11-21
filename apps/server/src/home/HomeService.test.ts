import { assert, it } from "@effect/vitest";
import { ClientServerSettingsPatch, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { hiddenFromNonHomeThreads, requireHomeCaller } from "../mcp/homeAccess.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as HomeService from "./HomeService.ts";
import { makeOrchestration, model, provideHome } from "./HomeTestkit.ts";

const decodeClientPatch = Schema.decodeUnknownSync(ClientServerSettingsPatch);

const callerScope = (threadId: string): McpInvocationContext.McpInvocationScope => ({
  environmentId: "env:test" as never,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
});

const asHome = (threadId: ThreadId) =>
  requireHomeCaller().pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope(threadId)),
    Effect.exit,
  );

it.effect(
  "enables Home in its own folder as a full-access home: thread and seeds its files",
  () => {
    const orchestration = makeOrchestration();
    return Effect.gen(function* () {
      const home = yield* HomeService.HomeService;
      const { threadId } = yield* home.enable({ modelSelection: model });
      assert.isTrue(threadId.startsWith("home:"));
      // Enabling again returns the running Home.
      assert.strictEqual((yield* home.enable({})).threadId, threadId);
      assert.deepStrictEqual(yield* home.read, {
        enabled: true,
        threadId,
        modelSelection: model,
        watches: [],
      });

      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const instructions = yield* fileSystem.readFileString(
        path.join(config.baseDir, "home", "AGENTS.md"),
      );
      assert.include(instructions, "t3_environment_links");
      yield* home.writeNotes("remember the release train");
      assert.strictEqual(yield* home.readNotes, "remember the release train");
    }).pipe(provideHome(orchestration));
  },
);

it.effect("needs a model when neither the request nor the environment names one", () => {
  const orchestration = makeOrchestration();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const exit = yield* home.enable({}).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual((yield* home.read).enabled, false);
  }).pipe(provideHome(orchestration));
});

it.effect("disable and Start fresh revoke the old grant at once and stop its run", () => {
  const orchestration = makeOrchestration();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const first = (yield* home.enable({ modelSelection: model })).threadId;
    yield* home.addWatch(first, { threadId: ThreadId.make("thread:watched"), reason: "manual" });
    assert.isTrue(Exit.isSuccess(yield* asHome(first)));
    orchestration.shells.get(first)!.activeRunId = RunId.make("run:busy");

    const second = (yield* home.reset).threadId;
    assert.notStrictEqual(second, first);
    assert.isTrue(Exit.isFailure(yield* asHome(first)));
    assert.isTrue(Exit.isSuccess(yield* asHome(second)));
    assert.deepStrictEqual((yield* home.read).watches, []);
    assert.deepStrictEqual(
      orchestration.dispatched.map((command) => [command.type, command.threadId]),
      [
        ["run.interrupt", first],
        ["thread.settle", first],
      ],
    );
    // A replaced Home cannot touch the new Home's watches.
    const stale = yield* home
      .addWatch(first, { threadId: ThreadId.make("thread:x"), reason: "manual" })
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(stale));

    orchestration.shells.get(second)!.activeRunId = RunId.make("run:second");
    yield* home.disable;
    assert.isTrue(Exit.isFailure(yield* asHome(second)));
    assert.deepStrictEqual(orchestration.dispatched.at(-1), {
      ...orchestration.dispatched.at(-1)!,
      type: "run.interrupt",
      threadId: second,
    });
    const after = yield* home.read;
    assert.deepStrictEqual(
      [after.enabled, after.threadId, after.modelSelection],
      [false, null, model],
    );
  }).pipe(provideHome(orchestration));
});

it.effect("Home's tools are listed and callable only by the active Home thread", () => {
  const orchestration = makeOrchestration();
  return Effect.gen(function* () {
    const home = yield* HomeService.HomeService;
    const homeThread = (yield* home.enable({ modelSelection: model })).threadId;
    const listed = (threadId: string) =>
      Effect.sync(hiddenFromNonHomeThreads).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope(threadId)),
      );
    assert.isFalse(yield* listed("thread:ordinary"));
    assert.isTrue(yield* listed(homeThread));
    const denied = yield* asHome(ThreadId.make("thread:ordinary"));
    assert.isTrue(
      Exit.isFailure(denied) &&
        Exit.findErrorOption(denied).pipe(
          Option.exists((error) => error.code === "capability_denied"),
        ),
    );
    // A `home:` id is not the grant: only the current Home thread is.
    assert.isTrue(Exit.isFailure(yield* asHome(ThreadId.make("home:someone-else"))));
  }).pipe(provideHome(orchestration));
});

it("drops `home` from client settings patches", () => {
  const patch = decodeClientPatch({
    defaultRuntimeMode: "full-access",
    home: { enabled: true, threadId: "home:forged", modelSelection: null, watches: [] },
  });
  assert.deepStrictEqual(patch, { defaultRuntimeMode: "full-access" });
});
