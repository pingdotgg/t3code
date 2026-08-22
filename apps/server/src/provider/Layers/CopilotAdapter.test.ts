// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  CopilotSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { copilotSkillsFromCommands, discoverCopilotViaAcp } from "./CopilotProvider.ts";
import { makeCopilotAdapter } from "./CopilotAdapter.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockCopilotWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-copilot.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const copilotAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-copilot-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeCopilotAdapter>[1]) =>
  makeCopilotAdapter(decodeCopilotSettings({ binaryPath }), options).pipe(Effect.orDie);

it.layer(copilotAdapterTestLayer)("CopilotAdapterLive", (it) => {
  it.effect("starts a session and maps the mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("copilot-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockCopilotWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("copilot"),
        cwd: process.cwd(),
        runtimeMode: "auto",
      });

      assert.equal(session.provider, "copilot");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello copilot",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("projects Copilot subagent tool calls onto the task lifecycle", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("copilot-subagent-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({ T3_ACP_EMIT_TASK_TOOL_CALL: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("copilot"),
        cwd: process.cwd(),
        runtimeMode: "auto",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "use the researcher subagent",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      // Task completion rides the event stream; give the fold a beat to drain.
      yield* adapter.readThread(threadId);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const taskStarted = runtimeEvents.find((e) => e.type === "task.started");
      const taskCompleted = runtimeEvents.find((e) => e.type === "task.completed");
      assert.isDefined(taskStarted);
      assert.isDefined(taskCompleted);
      if (taskStarted?.type === "task.started") {
        assert.equal(taskStarted.payload.taskId, "task-tool-1");
        assert.equal(taskStarted.payload.description, "researcher");
        assert.equal(taskStarted.payload.agentKind, "agent");
      }
      if (taskCompleted?.type === "task.completed") {
        assert.equal(taskCompleted.payload.taskId, "task-tool-1");
        assert.equal(taskCompleted.payload.status, "completed");
      }

      // The subagent tool call must not double-render on the tool timeline.
      const itemEventsForToolCall = runtimeEvents.filter(
        (e) =>
          (e.type === "item.updated" || e.type === "item.completed") && e.itemId === "task-tool-1",
      );
      assert.isEmpty(itemEventsForToolCall);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("holds the turn open until a background subagent reports idle", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("copilot-background-thread");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({ T3_ACP_EMIT_BACKGROUND_TASK: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: Array<{ readonly type: ProviderRuntimeEvent["type"] }> = [];
      const turnCompleted = yield* Deferred.make<void>();
      const helloSeen = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push({ type: event.type });
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
          Effect.andThen(
            event.type === "content.delta" ? Deferred.succeed(helloSeen, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("copilot"),
        cwd: process.cwd(),
        runtimeMode: "auto",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run delayed-hello in the background",
        attachments: [],
      });

      // Copilot answers `end_turn` while the background agent still runs.
      assert.isDefined(turn);
      yield* Deferred.await(helloSeen);
      // The post-answer traffic must land inside a still-open turn...
      const deltaIndex = runtimeEvents.findIndex((e) => e.type === "content.delta");
      const completedIndex = runtimeEvents.findIndex((e) => e.type === "turn.completed");
      assert.isTrue(deltaIndex >= 0);
      assert.isTrue(completedIndex < 0 || completedIndex > deltaIndex);

      // ...and the idle report closes both the task and the turn.
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.isTrue(runtimeEvents.some((e) => e.type === "task.started"));
      assert.isTrue(runtimeEvents.some((e) => e.type === "task.completed"));
      const finalCompletedIndex = runtimeEvents.findIndex((e) => e.type === "turn.completed");
      assert.isTrue(finalCompletedIndex > deltaIndex);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.timeoutOption(15_000)),
  );

  it.effect("collects skills advertised through available_commands_update", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockCopilotWrapper({ T3_ACP_EMIT_AVAILABLE_COMMANDS: "1" }),
      );
      const discovery = yield* discoverCopilotViaAcp(
        decodeCopilotSettings({ binaryPath: wrapperPath }),
      );

      assert.deepEqual(
        discovery.commands.map((command) => command.name),
        ["research", "plan"],
      );
      assert.equal(discovery.commands[0]?.inputHint, "topic to research");

      const skills = copilotSkillsFromCommands(discovery.commands);
      assert.equal(skills.length, 2);
      assert.equal(skills[0]?.name, "research");
      assert.equal(skills[0]?.path, "/research");
      assert.equal(skills[0]?.enabled, true);
    }),
  );
});
