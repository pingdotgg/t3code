import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CursorDriver } from "./CursorDriver.ts";

const cliSource = `
import { createInterface } from "node:readline";
if (!process.argv.includes("acp")) {
  console.log(JSON.stringify({ cliVersion: "2026.09.02-c22c1a3", userEmail: "test@example.com" }));
  process.exit(0);
}
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
const commands = (availableCommands) => send({ method: "session/update", params: {
  sessionId: "mock-session", update: { sessionUpdate: "available_commands_update", availableCommands }
}});
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  if (request.method === "session/new") {
    if (!process.env.T3_DELAY_COMMANDS) commands([{ name: "goal", description: "Pursue a goal", input: { hint: "objective" } },
      { name: "compact", description: "Native compact" }]);
    result = { sessionId: "mock-session" };
  }
  if (request.method === "session/prompt") {
    if (request.params.prompt[0]?.text === "clear commands") commands([]);
    const text = request.params.prompt.filter((part) => part.type === "text").map((part) => part.text).join("\\n");
    send({ method: "session/update", params: { sessionId: "mock-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text }
    }}});
    result = { stopReason: "end_turn" };
  }
  if (request.method === "cursor/list_available_models") result = { models: [] };
  if (request.method === "session/set_config_option") result = { configOptions: [] };
  if (request.id !== undefined) send({ id: request.id, result });
}
`;

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "cursor-commands-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Command discovery must not make HTTP requests")),
    ),
  ),
);

const makeHarness = Effect.fn("makeCursorCommandsHarness")(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  yield* settings.updateSettings({ enableProviderUpdateChecks: false });
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-command-catalog-" });
  const binaryPath = yield* Effect.sync(() =>
    writeFakeCli({
      directory,
      name: "cursor-agent",
      source: cliSource,
      env: id === "cursor-delayed-commands" ? { T3_DELAY_COMMANDS: "1" } : {},
    }),
  );
  const cwd = path.join(directory, "workspace");
  const skillRoot = path.join(cwd, ".agents", "skills", "local-skill");
  yield* fs.makeDirectory(skillRoot, { recursive: true });
  yield* fs.writeFileString(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: local-skill\ndescription: Local skill\n---\nDo work.",
  );
  const instance = yield* CursorDriver.create({
    instanceId: ProviderInstanceId.make(id),
    displayName: undefined,
    enabled: true,
    environment: [{ name: "HOME", value: directory, sensitive: false }],
    config: { ...CursorDriver.defaultConfig(), binaryPath },
  });
  const threadId = ThreadId.make(id);
  yield* instance.snapshot.refresh;
  const start = instance.adapter.startSession({
    threadId,
    cwd,
    provider: ProviderDriverKind.make("cursor"),
    runtimeMode: "full-access",
  });
  const prompt = (input: string) => instance.adapter.sendTurn({ threadId, input });
  return { instance, cwd, start, prompt };
});

it.layer(testLayer)("Cursor command discovery", (it) => {
  it.effect("keeps advertised slash commands intact for Cursor's command parser", () =>
    Effect.gen(function* () {
      const { instance, start, prompt } = yield* makeHarness("cursor-command-input");
      yield* start;
      const events = yield* instance.adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* prompt("/goal check invocation");
      const reply = (yield* Fiber.join(events)).find((event) => event.type === "content.delta");
      expect(reply?.payload.delta).toBe("/goal check invocation");
    }).pipe(Effect.scoped),
  );
  it.effect("preserves a leading command before Cursor publishes its catalog", () =>
    Effect.gen(function* () {
      const { instance, start, prompt } = yield* makeHarness("cursor-delayed-commands");
      yield* start;
      const events = yield* instance.adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* prompt("/goal first turn before command metadata");
      const reply = (yield* Fiber.join(events)).find((event) => event.type === "content.delta");
      expect(reply?.payload.delta).toBe("/goal first turn before command metadata");
    }).pipe(Effect.scoped),
  );
  it.effect("publishes ACP commands to the workspace catalog without losing local skills", () =>
    Effect.gen(function* () {
      const { instance, cwd, start, prompt } = yield* makeHarness("cursor-commands");
      const updates = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.workspaceSnapshots?.some(
              (workspace) =>
                workspace.cwd === cwd &&
                workspace.slashCommands.some((command) => command.name === "goal"),
            ) ?? false,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* start;
      yield* prompt("hello");
      const workspace = (yield* instance.snapshot.getSnapshot).workspaceSnapshots?.find(
        (item) => item.cwd === cwd,
      );
      expect(workspace?.slashCommands ?? []).toContainEqual({
        name: "goal",
        description: "Pursue a goal",
        input: { hint: "objective" },
      });
      expect(workspace?.skills.map((skill) => skill.name)).toContain("local-skill");
      expect(workspace?.slashCommands.filter((command) => command.name === "compact")).toHaveLength(
        1,
      );
      expect((yield* instance.snapshotForCwd!(cwd)).slashCommands).toEqual(
        workspace?.slashCommands,
      );
      expect(yield* Fiber.join(updates)).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("replaces native commands and isolates them from other workspaces and instances", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness("cursor-first");
      const second = yield* makeHarness("cursor-second");
      yield* first.instance.snapshotForCwd!(second.cwd);
      yield* first.start;
      yield* first.prompt("hello");
      expect(
        (yield* first.instance.snapshot.getSnapshot).workspaceSnapshots
          ?.find((workspace) => workspace.cwd === second.cwd)
          ?.skills.map((skill) => skill.name),
      ).toContain("local-skill");
      expect(
        (yield* first.instance.snapshotForCwd!(first.cwd)).slashCommands.some(
          (command) => command.name === "goal",
        ),
      ).toBe(true);
      expect(
        (yield* first.instance.snapshotForCwd!(second.cwd)).slashCommands.some(
          (command) => command.name === "goal",
        ),
      ).toBe(false);
      expect(
        (yield* second.instance.snapshotForCwd!(first.cwd)).slashCommands.some(
          (command) => command.name === "goal",
        ),
      ).toBe(false);
      yield* first.prompt("clear commands");
      const cleared = yield* first.instance.snapshotForCwd!(first.cwd);
      expect(cleared.slashCommands.map((command) => command.name)).toEqual(["compact"]);
      expect(cleared.skills.map((skill) => skill.name)).toContain("local-skill");
    }).pipe(Effect.scoped),
  );
});
