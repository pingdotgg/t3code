import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";

import { ApprovalRequestId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { makeCursorAdapterLive } from "./CursorAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const bunExe = "bun";

async function makeMockAgentWrapper(
  extraEnv?: Record<string, string>,
  options?: { initialDelaySeconds?: number },
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-mock-"));
  const wrapperPath = path.join(dir, "fake-agent.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
${options?.initialDelaySeconds ? `sleep ${JSON.stringify(String(options.initialDelaySeconds))}` : ""}
exec ${JSON.stringify(bunExe)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeProbeWrapper(
  requestLogPath: string,
  argvLogPath: string,
  extraEnv?: Record<string, string>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-acp-probe-"));
  const wrapperPath = path.join(dir, "fake-agent.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
printf '%s\t' "$@" >> ${JSON.stringify(argvLogPath)}
printf '\n' >> ${JSON.stringify(argvLogPath)}
export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(requestLogPath)}
${envExports}
exec ${JSON.stringify(bunExe)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readArgvLog(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

async function readJsonLines(filePath: string) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForFileContent(filePath: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await readFile(filePath, "utf8");
      if (raw.trim().length > 0) {
        return raw;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

const cursorAdapterTestLayer = it.layer(
  makeCursorAdapterLive().pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-cursor-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

cursorAdapterTestLayer("CursorAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "default" },
      });

      assert.equal(session.provider, "cursor");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((e) => e.type);

      for (const t of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, t);
      }

      const assistantStarted = runtimeEvents.find(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantStarted);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
        assert.match(String(delta.itemId), /^assistant:mock-session-1:segment:0$/);
      }

      const assistantCompleted = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantCompleted);

      const planUpdate = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.isDefined(planUpdate);
      if (planUpdate?.type === "turn.plan.updated") {
        assert.deepStrictEqual(planUpdate.payload.plan, [
          { step: "Inspect mock ACP state", status: "completed" },
          { step: "Implement the requested change", status: "inProgress" },
        ]);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "cursor-adapter-exit-log-")),
      );
      const exitLogPath = path.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "default" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect(
    "serializes concurrent startSession calls for the same thread and closes the replaced ACP session",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-concurrent-start-session");
        const tempDir = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), "cursor-adapter-concurrent-exit-log-")),
        );
        const exitLogPath = path.join(tempDir, "exit.log");

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper(
            {
              T3_ACP_EXIT_LOG_PATH: exitLogPath,
            },
            { initialDelaySeconds: 0.2 },
          ),
        );
        yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

        const [firstSession, secondSession] = yield* Effect.all(
          [
            adapter.startSession({
              threadId,
              provider: "cursor",
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: { provider: "cursor", model: "default" },
            }),
            adapter.startSession({
              threadId,
              provider: "cursor",
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: { provider: "cursor", model: "default" },
            }),
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(firstSession.threadId, threadId);
        assert.equal(secondSession.threadId, threadId);

        yield* adapter.stopSession(threadId);

        const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
        assert.equal(exitLog.match(/SIGTERM/g)?.length ?? 0, 2);
      }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("bad-provider"),
          provider: "codex",
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("maps app plan mode onto the ACP plan session mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-plan-mode-probe");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequest = requests
        .toReversed()
        .find(
          (entry) =>
            entry.method === "session/set_mode" ||
            (entry.method === "session/set_config_option" &&
              (entry.params as Record<string, unknown> | undefined)?.configId === "mode"),
        );
      assert.isDefined(modeRequest);
      assert.equal(
        (modeRequest?.params as Record<string, unknown> | undefined)?.sessionId,
        "mock-session-1",
      );
      assert.include(
        ["architect", "plan"],
        String(
          (modeRequest?.params as Record<string, unknown> | undefined)?.modeId ??
            (modeRequest?.params as Record<string, unknown> | undefined)?.value,
        ),
      );
    }),
  );

  it.effect(
    "applies initial model and mode configuration during startSession and skips repeating it on first send",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-initial-config-probe");
        const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        const argvLogPath = path.join(tempDir, "argv.txt");
        yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        const modelSelection = {
          provider: "cursor" as const,
          model: "gpt-5.4",
          options: {
            reasoning: "xhigh" as const,
            contextWindow: "1m",
            fastMode: true,
          },
        };

        yield* adapter.startSession({
          threadId,
          provider: "cursor",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection,
        });

        yield* Effect.promise(() => waitForFileContent(requestLogPath));

        const requestsAfterStart = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const configIdsAfterStart = requestsAfterStart.flatMap((entry) =>
          entry.method === "session/set_config_option" &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === "string"
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        );
        assert.deepStrictEqual(configIdsAfterStart, [
          "model",
          "reasoning",
          "context",
          "fast",
          "mode",
        ]);

        yield* adapter.sendTurn({
          threadId,
          input: "hello mock",
          attachments: [],
          modelSelection,
          interactionMode: "default",
        });
        yield* adapter.stopSession(threadId);

        const finalRequests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const finalConfigIds = finalRequests.flatMap((entry) =>
          entry.method === "session/set_config_option" &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === "string"
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        );
        assert.deepStrictEqual(finalConfigIds, ["model", "reasoning", "context", "fast", "mode"]);
        assert.equal(finalRequests.filter((entry) => entry.method === "session/prompt").length, 1);
      }),
  );

  it.effect(
    "streams ACP tool calls and approvals on the active turn in approval-required mode",
    () =>
      Effect.gen(function* () {
        const previousEmitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS;
        process.env.T3_ACP_EMIT_TOOL_CALLS = "1";

        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-tool-call-probe");
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (event.type === "request.opened" && event.requestId) {
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "accept",
              );
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        const program = Effect.gen(function* () {
          yield* adapter.startSession({
            threadId,
            provider: "cursor",
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            modelSelection: { provider: "cursor", model: "default" },
          });

          const turn = yield* adapter.sendTurn({
            threadId,
            input: "run a tool call",
            attachments: [],
          });
          yield* Deferred.await(settledEventsReady);

          const threadEvents = runtimeEvents.filter(
            (event) => String(event.threadId) === String(threadId),
          );
          assert.includeMembers(
            threadEvents.map((event) => event.type),
            [
              "session.started",
              "session.state.changed",
              "thread.started",
              "turn.started",
              "request.opened",
              "request.resolved",
              "item.updated",
              "item.completed",
              "content.delta",
              "turn.completed",
            ],
          );

          const turnEvents = threadEvents.filter(
            (event) => String(event.turnId) === String(turn.turnId),
          );
          const toolUpdates = turnEvents.filter((event) => event.type === "item.updated");
          // ACP updates can arrive either as distinct pending + in-progress events
          // or as a single coalesced in-progress update before approval resolves.
          assert.isAtLeast(toolUpdates.length, 1);
          for (const toolUpdate of toolUpdates) {
            if (toolUpdate.type !== "item.updated") {
              continue;
            }
            assert.equal(toolUpdate.payload.itemType, "command_execution");
            assert.equal(toolUpdate.payload.status, "inProgress");
            assert.equal(toolUpdate.payload.detail, "cat server/package.json");
            assert.equal(String(toolUpdate.itemId), "tool-call-1");
          }

          const requestOpened = turnEvents.find((event) => event.type === "request.opened");
          assert.isDefined(requestOpened);
          if (requestOpened?.type === "request.opened") {
            assert.equal(String(requestOpened.turnId), String(turn.turnId));
            assert.equal(requestOpened.payload.requestType, "exec_command_approval");
            assert.equal(requestOpened.payload.detail, "cat server/package.json");
          }

          const requestResolved = turnEvents.find((event) => event.type === "request.resolved");
          assert.isDefined(requestResolved);
          if (requestResolved?.type === "request.resolved") {
            assert.equal(String(requestResolved.turnId), String(turn.turnId));
            assert.equal(requestResolved.payload.requestType, "exec_command_approval");
            assert.equal(requestResolved.payload.decision, "accept");
          }

          const toolCompleted = turnEvents.find(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "command_execution",
          );
          assert.isDefined(toolCompleted);
          if (toolCompleted?.type === "item.completed") {
            assert.equal(String(toolCompleted.turnId), String(turn.turnId));
            assert.equal(toolCompleted.payload.itemType, "command_execution");
            assert.equal(toolCompleted.payload.status, "completed");
            assert.equal(toolCompleted.payload.detail, "cat server/package.json");
            assert.equal(String(toolCompleted.itemId), "tool-call-1");
          }

          const contentDelta = turnEvents.find((event) => event.type === "content.delta");
          assert.isDefined(contentDelta);
          if (contentDelta?.type === "content.delta") {
            assert.equal(String(contentDelta.turnId), String(turn.turnId));
            assert.equal(contentDelta.payload.delta, "hello from mock");
            assert.equal(String(contentDelta.itemId), "assistant:mock-session-1:segment:0");
          }
        });

        yield* program.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousEmitToolCalls === undefined) {
                delete process.env.T3_ACP_EMIT_TOOL_CALLS;
              } else {
                process.env.T3_ACP_EMIT_TOOL_CALLS = previousEmitToolCalls;
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          makeCursorAdapterLive().pipe(
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3code-cursor-adapter-test-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect(
    "auto-approves ACP tool permissions in full-access mode without approval runtime events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-full-access-auto-approve");
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();
        const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
        const requestLogPath = path.join(tempDir, "requests.ndjson");
        const argvLogPath = path.join(tempDir, "argv.txt");
        yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: "cursor",
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { provider: "cursor", model: "default" },
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run a tool call",
          attachments: [],
        });

        yield* Deferred.await(settledEventsReady);
        yield* Fiber.interrupt(runtimeEventsFiber);

        const turnEvents = runtimeEvents.filter(
          (event) =>
            String(event.threadId) === String(threadId) &&
            String(event.turnId) === String(turn.turnId),
        );
        assert.notInclude(
          turnEvents.map((event) => event.type),
          "request.opened",
        );
        assert.notInclude(
          turnEvents.map((event) => event.type),
          "request.resolved",
        );
        assert.includeMembers(
          turnEvents.map((event) => event.type),
          ["item.updated", "item.completed", "content.delta", "turn.completed"],
        );

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const permissionResponse = requests.find(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "outcome" in entry.result.outcome &&
            entry.result.outcome.outcome === "selected" &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "allow-always",
        );
        assert.isDefined(permissionResponse);

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("segments assistant messages around ACP tool activity in full-access mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-assistant-tool-segmentation");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const settledEventTypes = new Set<string>();
      const settledEventsReady = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({
        providers: { cursor: { binaryPath: wrapperPath } },
      });

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (
            event.type === "content.delta" ||
            (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
            event.type === "turn.completed"
          ) {
            if (event.type === "content.delta") {
              settledEventTypes.add(`delta:${event.payload.delta}`);
            } else {
              settledEventTypes.add(event.type);
            }
            if (
              settledEventTypes.has("delta:before tool") &&
              settledEventTypes.has("delta:after tool") &&
              settledEventTypes.has("item.completed") &&
              settledEventTypes.has("turn.completed")
            ) {
              yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
            }
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "default" },
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run an interleaved tool call",
        attachments: [],
      });

      yield* Deferred.await(settledEventsReady);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const turnEvents = runtimeEvents.filter(
        (event) =>
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turn.turnId),
      );
      const firstAssistantStartIndex = turnEvents.findIndex(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      const firstAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "before tool",
      );
      const assistantBoundaryIndex = turnEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolUpdateIndex = turnEvents.findIndex(
        (event) => event.type === "item.updated" && event.payload.itemType === "command_execution",
      );
      const toolCompletedIndex = turnEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      const secondAssistantStartIndex = turnEvents.findIndex(
        (event, index) =>
          index > toolCompletedIndex &&
          event.type === "item.started" &&
          event.payload.itemType === "assistant_message",
      );
      const secondAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "after tool",
      );

      assert.isAtLeast(firstAssistantStartIndex, 0);
      assert.isAtLeast(firstAssistantDeltaIndex, 0);
      assert.isAtLeast(assistantBoundaryIndex, 0);
      assert.isAtLeast(toolUpdateIndex, 0);
      assert.isAtLeast(toolCompletedIndex, 0);
      assert.isAtLeast(secondAssistantStartIndex, 0);
      assert.isAtLeast(secondAssistantDeltaIndex, 0);
      assert.isBelow(firstAssistantStartIndex, firstAssistantDeltaIndex);
      assert.isBelow(firstAssistantDeltaIndex, assistantBoundaryIndex);
      assert.isBelow(assistantBoundaryIndex, toolUpdateIndex);
      assert.isBelow(toolUpdateIndex, toolCompletedIndex);
      assert.isBelow(toolCompletedIndex, secondAssistantStartIndex);
      assert.isBelow(secondAssistantStartIndex, secondAssistantDeltaIndex);

      const assistantStarts = turnEvents.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      const assistantDeltas = turnEvents.filter((event) => event.type === "content.delta");
      assert.lengthOf(assistantStarts, 2);
      assert.lengthOf(assistantDeltas, 2);
      if (
        assistantStarts[0]?.type === "item.started" &&
        assistantStarts[1]?.type === "item.started" &&
        assistantDeltas[0]?.type === "content.delta" &&
        assistantDeltas[1]?.type === "content.delta"
      ) {
        assert.notEqual(String(assistantStarts[0].itemId), String(assistantStarts[1].itemId));
        assert.equal(String(assistantDeltas[0].itemId), String(assistantStarts[0].itemId));
        assert.equal(String(assistantDeltas[1].itemId), String(assistantStarts[1].itemId));
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels pending ACP approvals and marks the turn cancelled when interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-cancel-probe");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const requestResolvedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      const turnCompletedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      let interrupted = false;

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && !interrupted) {
            interrupted = true;
            yield* adapter.interruptTurn(threadId);
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolvedReady, event).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompletedReady, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { provider: "cursor", model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel this turn",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestResolved = yield* Deferred.await(requestResolvedReady);
      const turnCompleted = yield* Deferred.await(turnCompletedReady);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(requestResolved.type, "request.resolved");
      if (requestResolved.type === "request.resolved") {
        assert.equal(requestResolved.payload.decision, "cancel");
      }

      assert.equal(turnCompleted.type, "turn.completed");
      if (turnCompleted.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "cancelled");
        assert.equal(turnCompleted.payload.stopReason, "cancelled");
      }

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "session/cancel"));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "outcome" in entry.result.outcome &&
            entry.result.outcome.outcome === "cancelled",
        ),
      );

      yield* adapter.stopSession(threadId);
    }),
  );
  it.effect("stopping a session settles pending approval waits", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-stop-pending-approval");
      const approvalRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "request.opened") {
          return Effect.void;
        }
        return Deferred.succeed(approvalRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { provider: "cursor", model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "run a tool call and then stop",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(approvalRequested);
      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("stopping a session settles pending user-input waits", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-stop-pending-user-input");
      const userInputRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_ASK_QUESTION: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "user-input.requested") {
          return Effect.void;
        }
        return Deferred.succeed(userInputRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "ask me a question and then stop",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(userInputRequested);
      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("interrupting a session settles pending user-input waits", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-interrupt-pending-user-input");
      const userInputRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_ASK_QUESTION: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "user-input.requested") {
          return Effect.void;
        }
        return Deferred.succeed(userInputRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "ask me a question and then interrupt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(userInputRequested);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("broadcasts runtime events to multiple stream consumers", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-runtime-event-broadcast");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const firstConsumer = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const secondConsumer = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "default" },
      });

      const firstEvents = Array.from(yield* Fiber.join(firstConsumer));
      const secondEvents = Array.from(yield* Fiber.join(secondConsumer));

      assert.deepStrictEqual(
        firstEvents.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );
      assert.deepStrictEqual(
        secondEvents.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("switches model in-session via session/set_config_option", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-model-switch");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });

      yield* adapter.sendTurn({
        threadId,
        input: "second turn after switching model",
        attachments: [],
        modelSelection: { provider: "cursor", model: "composer-2", options: { fastMode: true } },
      });

      const argvRuns = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.lengthOf(argvRuns, 1, "session should not restart — only one spawn");
      assert.deepStrictEqual(argvRuns[0], ["acp"]);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const setConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "model",
      );
      assert.isAbove(setConfigRequests.length, 0, "should call session/set_config_option");
      assert.equal((setConfigRequests[0]?.params as Record<string, unknown>)?.value, "composer-2");

      const fastConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "fast",
      );
      assert.isAbove(fastConfigRequests.length, 0, "should apply fast mode as a separate config");
      const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1];
      assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, "true");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("clears prior fast mode in-session when the next turn sets fastMode: false", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-fast-mode-reset");
      const tempDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "cursor-acp-")));
      const requestLogPath = path.join(tempDir, "requests.ndjson");
      const argvLogPath = path.join(tempDir, "argv.txt");
      yield* Effect.promise(() => writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: "cursor",
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { provider: "cursor", model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn with fast mode",
        attachments: [],
        modelSelection: { provider: "cursor", model: "composer-2", options: { fastMode: true } },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "second turn without fast mode",
        attachments: [],
        modelSelection: { provider: "cursor", model: "composer-2", options: { fastMode: false } },
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const fastConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "fast",
      );
      assert.isAtLeast(fastConfigRequests.length, 2, "should set fast mode on and then off");

      const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1];
      assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, "false");

      yield* adapter.stopSession(threadId);
    }),
  );
});
