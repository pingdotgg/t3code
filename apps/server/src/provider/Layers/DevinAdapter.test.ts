// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import { isHostWindows } from "@t3tools/shared/hostProcess";
import {
  ApprovalRequestId,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalOption,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makeDevinAdapter, makeDevinPromptLease, settleDevinPromptLease } from "./DevinAdapter.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";

const decodeDevinSettings = Schema.decodeSync(
  Schema.Struct({
    enabled: Schema.Boolean,
    binaryPath: Schema.String,
    customModels: Schema.Array(Schema.String),
  }),
);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const makeMockDevinWrapper = Effect.fn("makeMockDevinWrapper")(function* (
  extraEnv?: Record<string, string>,
  skills?: {
    readonly jsonPath: string;
    readonly callLogPath: string;
    readonly exitCode?: number;
  },
) {
  const isWindows = yield* isHostWindows;
  const dir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-")),
  );
  if (isWindows) {
    // resolveSpawnCommand detects .cmd and uses shell:true on Windows.
    const wrapperPath = NodePath.join(dir, "fake-devin.cmd");
    const envLines = Object.entries(extraEnv ?? {})
      .map(([key, value]) => `set ${key}=${value}`)
      .join("\r\n");
    const skillsBranch = skills
      ? `if "%~1"=="skills" (\r\n  echo called>>"${skills.callLogPath}"\r\n  type "${skills.jsonPath}"\r\n  exit /b ${skills.exitCode ?? 0}\r\n)\r\n`
      : "";
    const script = `@echo off\r\n${envLines}\r\n${skillsBranch}"${mockAgentCommand}" "${mockAgentPath}" %*\r\n`;
    yield* Effect.promise(() => NodeFSP.writeFile(wrapperPath, script, "utf8"));
    return wrapperPath;
  }
  const wrapperPath = NodePath.join(dir, "fake-devin.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const skillsBranch = skills
    ? `if [ "$1" = "skills" ]; then\n  echo called >> '${skills.callLogPath}'\n  cat '${skills.jsonPath}'\n  exit ${skills.exitCode ?? 0}\nfi\n`
    : "";
  const script = `#!/bin/sh
${envExports}
${skillsBranch}
exec ${shellQuote(mockAgentCommand)} ${shellQuote(mockAgentPath)} "$@"
`;
  yield* Effect.promise(() => NodeFSP.writeFile(wrapperPath, script, "utf8"));
  yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));
  return wrapperPath;
});

const devinAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDevinAdapter>[1]) =>
  makeDevinAdapter(
    decodeDevinSettings({ enabled: true, binaryPath, customModels: [] }),
    options,
  ).pipe(Effect.orDie);

const devinModelSelection = (model: string) => ({
  instanceId: ProviderInstanceId.make("devin"),
  model,
});

const devinResourceLinkFixture = {
  type: "content",
  content: {
    type: "resource_link",
    uri: "urn:acp:fixture:resource-link",
    name: "schema fixture",
    description: "typed protocol fixture",
    mimeType: "text/markdown",
  },
} satisfies EffectAcpSchema.ToolCallContent;

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((entry) => containsString(entry, needle));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((entry) => containsString(entry, needle));
}

it("does not let a stale prompt lease consume a newer turn's accounting", () => {
  const firstTurnId = TurnId.make("devin-first-turn");
  const nextTurnId = TurnId.make("devin-next-turn");
  const staleLease = makeDevinPromptLease(firstTurnId);
  const nextLease = makeDevinPromptLease(nextTurnId);
  const accounting = {
    activeTurnId: firstTurnId,
    activePromptLeases: new Set([staleLease]),
  };

  accounting.activeTurnId = nextTurnId;
  accounting.activePromptLeases.clear();
  accounting.activePromptLeases.add(nextLease);

  assert.isFalse(settleDevinPromptLease(accounting, staleLease));
  assert.equal(accounting.activePromptLeases.size, 1);
  assert.isTrue(accounting.activePromptLeases.has(nextLease));
  assert.equal(accounting.activeTurnId, nextTurnId);
});

it("settles each steered prompt lease exactly once", () => {
  const turnId = TurnId.make("devin-steered-turn");
  const firstLease = makeDevinPromptLease(turnId);
  const secondLease = makeDevinPromptLease(turnId);
  const accounting = {
    activeTurnId: turnId,
    activePromptLeases: new Set([firstLease, secondLease]),
  };

  assert.isTrue(settleDevinPromptLease(accounting, firstLease));
  assert.equal(accounting.activePromptLeases.size, 1);
  assert.isTrue(accounting.activePromptLeases.has(secondLease));
  assert.isFalse(settleDevinPromptLease(accounting, firstLease));
  assert.equal(accounting.activePromptLeases.size, 1);
});

// excludeTestServices avoids the TestClock/TestConsole layers so that
// Effect.timeout and Effect.sleep use the real wall clock — which is what
// these integration tests need since they spawn real child processes.
it.layer(devinAdapterTestLayer, { excludeTestServices: true })("DevinAdapterLive", (it) => {
  it.effect("rejects unsupported conversation rollback without changing local history", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter(yield* makeMockDevinWrapper());
      const threadId = ThreadId.make("devin-rollback");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "keep this turn" });
      const before = structuredClone(yield* adapter.readThread(threadId));
      assert.isNotEmpty(before.turns);
      const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.equal(adapter.capabilities.supportsConversationRollback, false);
      assert.deepEqual(yield* adapter.readThread(threadId), before);
    }),
  );

  for (const stage of [
    "spawn",
    "start",
    "configure",
    "restart-start",
    "restart-configure",
  ] as const) {
    it.effect(`closes the independent runtime scope on ${stage} failure`, () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const scopes: Scope.Scope[] = [];
        let closed = 0;
        const trackedSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            scopes.push(yield* Effect.scope);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed += 1;
              }),
            );
            if (stage === "spawn")
              return yield* PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "spawn",
                description: "test spawn failure",
              });
            return yield* spawner.spawn(command);
          }),
        );
        const goodWrapper = yield* makeMockDevinWrapper();
        const failingWrapper = yield* makeMockDevinWrapper(
          stage.endsWith("start")
            ? { T3_ACP_FAIL_LOAD_SESSION: "1" }
            : { T3_ACP_FAIL_SET_CONFIG_OPTION: "1" },
        );
        const restart = stage.startsWith("restart");
        let binaryPath = restart ? goodWrapper : failingWrapper;
        const adapter = yield* makeTestAdapter(binaryPath, {
          resolveSettings: Effect.sync(() =>
            decodeDevinSettings({ enabled: true, binaryPath, customModels: [] }),
          ),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, trackedSpawner));
        // Red runs must also release the scopes whose missing finalizers this test detects.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { discard: true }),
        );
        const threadId = ThreadId.make(`devin-failure-${stage}`);
        const start = adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: devinModelSelection(restart ? "default" : "composer-2"),
          ...(stage === "start"
            ? { resumeCursor: { schemaVersion: 1, sessionId: "prior-session" } }
            : {}),
        });
        if (restart) yield* start;
        binaryPath = failingWrapper;
        const operation = restart
          ? adapter
              .sendTurn({
                threadId,
                input: "change model",
                modelSelection: devinModelSelection("composer-2"),
              })
              .pipe(Effect.asVoid)
          : start.pipe(Effect.asVoid);
        const result = yield* Effect.exit(operation);
        assert.isTrue(Exit.isFailure(result));
        assert.equal(closed, restart ? 2 : 1);
        assert.isFalse(yield* adapter.hasSession(threadId));
        assert.isEmpty(yield* adapter.listSessions());
      }),
    );
  }

  for (const [decision, optionId] of [
    ["accept", "native-allow-once"],
    ["acceptForSession", "native-allow-always"],
    ["acceptAlways", "native-allow-always"],
    ["decline", "native-reject"],
    ["cancel", undefined],
  ] as const) {
    it.effect(
      `resolves ${decision} with advertised ACP permission options and bounded resources`,
      () =>
        Effect.gen(function* () {
          const wrapperPath = yield* makeMockDevinWrapper();
          const logPath = NodePath.join(NodePath.dirname(wrapperPath), "requests.log");
          const binaryPath = yield* makeMockDevinWrapper({
            T3_ACP_REQUEST_LOG_PATH: logPath,
            T3_ACP_EMIT_TOOL_CALLS: "1",
            T3_ACP_PERMISSION_RESOURCE: "1",
            T3_ACP_ALLOW_ONCE_OPTION_ID: "native-allow-once",
            T3_ACP_ALLOW_ALWAYS_OPTION_ID: "native-allow-always",
            T3_ACP_REJECT_ONCE_OPTION_ID: "native-reject",
            T3_ACP_OMIT_ALLOW_ALWAYS: decision === "cancel" ? "1" : "0",
          });
          const nativeLogs: unknown[] = [];
          const adapter = yield* makeTestAdapter(binaryPath, {
            nativeEventLogger: {
              filePath: logPath,
              write: (event) => Effect.sync(() => nativeLogs.push(event)),
              close: () => Effect.void,
            },
          });
          const threadId = ThreadId.make(`devin-approval-${decision}`);
          const opened =
            yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
          yield* Stream.runForEach(adapter.streamEvents, (event) =>
            event.type === "request.opened"
              ? Deferred.succeed(opened, event).pipe(
                  Effect.andThen(
                    decision === "cancel"
                      ? adapter
                          .respondToRequest(
                            threadId,
                            ApprovalRequestId.make(String(event.requestId)),
                            "acceptForSession",
                          )
                          .pipe(
                            Effect.flip,
                            Effect.tap((error) =>
                              Effect.sync(() => assert.include(error.message, "did not advertise")),
                            ),
                          )
                      : Effect.void,
                  ),
                  Effect.andThen(
                    adapter.respondToRequest(
                      threadId,
                      ApprovalRequestId.make(String(event.requestId)),
                      decision,
                    ),
                  ),
                )
              : Effect.void,
          ).pipe(Effect.forkChild);
          yield* adapter.startSession({
            threadId,
            cwd: process.cwd(),
            runtimeMode: "approval-required",
          });
          yield* adapter.sendTurn({ threadId, input: "review resource" });
          const request = yield* Deferred.await(opened);
          const allowOnce: ProviderApprovalOption = { decision: "accept", label: "Allow once" };
          const allowAlways: ProviderApprovalOption = {
            decision: "acceptForSession",
            label: "Allow always",
          };
          const reject: ProviderApprovalOption = { decision: "decline", label: "Reject" };
          const cancel: ProviderApprovalOption = { decision: "cancel", label: "Cancel" };
          const expectedOptions: ReadonlyArray<ProviderApprovalOption> =
            decision === "cancel"
              ? [allowOnce, reject, cancel]
              : [allowOnce, allowAlways, reject, cancel];
          assert.deepEqual(request.payload.options, expectedOptions);
          assert.isTrue(containsString(request.payload.args, "urn:permission:notes"));
          assert.isTrue(containsString(request.payload.args, "Review these notes"));
          assert.deepEqual(request.raw?.payload, request.payload.args);
          for (const excluded of [
            "permission-binary",
            "permission-resource-metadata",
            "urn:permission:oversized",
            "x".repeat(8_001),
          ]) {
            assert.isFalse(containsString(request, excluded), excluded.slice(0, 40));
            assert.isFalse(containsString(nativeLogs, excluded), excluded.slice(0, 40));
          }
          const requestLog = yield* Effect.promise(() => NodeFSP.readFile(logPath, "utf8"));
          const requests = yield* Effect.forEach(requestLog.trim().split("\n"), (line) =>
            decodeUnknownJson(line),
          );
          assert.isTrue(
            requests.some(
              Schema.is(
                Schema.Struct({
                  result: Schema.Struct({
                    outcome:
                      optionId === undefined
                        ? Schema.Struct({ outcome: Schema.Literal("cancelled") })
                        : Schema.Struct({
                            outcome: Schema.Literal("selected"),
                            optionId: Schema.Literal(optionId),
                          }),
                  }),
                }),
              ),
            ),
          );
        }),
    );
  }

  it.effect("keeps compacted ACP occupancy separate from lifetime processed tokens", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAdapter(
        yield* makeMockDevinWrapper({ T3_ACP_EMIT_USAGE_UPDATE: "1", T3_ACP_COMPACT_USAGE: "1" }),
      );
      const threadId = ThreadId.make("devin-compacted-context");
      const usageEvents: Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>[] =
        [];
      const completed = yield* Deferred.make<void>();
      let turns = 0;
      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "thread.token-usage.updated") usageEvents.push(event);
        if (event.type === "turn.completed" && ++turns === 2)
          return Deferred.succeed(completed, undefined);
        return Effect.void;
      }).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });
      yield* adapter.sendTurn({ threadId, input: "first" });
      yield* adapter.sendTurn({ threadId, input: "compact" });
      yield* Deferred.await(completed);
      assert.deepEqual(
        usageEvents.map((event) => event.payload.usage.usedTokens),
        [600, 600, 100, 100],
      );
      assert.equal(usageEvents.at(-1)?.payload.usage.totalProcessedTokens, 1_140);
      assert.equal(usageEvents.at(-1)?.payload.usage.lastUsedTokens, 0);
    }),
  );

  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockDevinWrapper();
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-mock-thread");

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
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
        "item.started",
        "content.delta",
        "item.completed",
      ] as const) {
        assert.include(types, t);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sanitizes resource content at the canonical and native log boundaries", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockDevinWrapper({
        T3_ACP_EMIT_DEVIN_RESOURCE_TOOL_CALL: "1",
      });
      const nativeLogs: unknown[] = [];
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "devin-resource-test.log",
          write: (event) => Effect.sync(() => nativeLogs.push(event)),
          close: () => Effect.void,
        },
      });
      const threadId = ThreadId.make("devin-resource-tool-event");
      const completedTool =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "item.completed" }>>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "item.completed" &&
        String(event.threadId) === String(threadId) &&
        String(event.itemId) === "devin-resource-tool"
          ? Deferred.succeed(completedTool, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* Effect.gen(function* () {
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("devin"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: devinModelSelection("default"),
        });

        yield* adapter.sendTurn({
          threadId,
          input: "emit typed resource fixture",
          attachments: [],
        });

        const event = yield* Deferred.await(completedTool).pipe(Effect.timeout("5 seconds"));
        assert.isDefined(event);
        const data = event.payload.data as Record<string, unknown> | undefined;
        assert.deepEqual(data?.resource, {
          uri: devinResourceLinkFixture.content.uri,
          name: devinResourceLinkFixture.content.name,
          description: devinResourceLinkFixture.content.description,
          mimeType: devinResourceLinkFixture.content.mimeType,
        });
        assert.deepEqual(data?.content, [
          {
            type: "content",
            content: {
              type: "text",
              text: "ordinary tool output",
            },
          },
        ]);
        assert.isFalse(containsString(data, "malformed-resource-link"));
        assert.isFalse(containsString(data, "oversized-resource"));
        assert.isFalse(containsString(data, "binary-resource"));
        assert.isFalse(containsString(data, "opaque-binary-fixture"));

        const nativeToolLogs = nativeLogs.filter((log) => {
          const payload = (log as { event?: { payload?: unknown } } | undefined)?.event?.payload;
          return (
            typeof payload === "object" &&
            payload !== null &&
            "update" in payload &&
            typeof payload.update === "object" &&
            payload.update !== null &&
            "sessionUpdate" in payload.update &&
            payload.update.sessionUpdate === "tool_call"
          );
        });
        assert.lengthOf(nativeToolLogs, 1);
        const nativePayload = (nativeToolLogs[0] as { event?: { payload?: unknown } } | undefined)
          ?.event?.payload;
        assert.deepEqual(nativePayload, {
          sessionId: "mock-session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "devin-resource-tool",
            title: "Resource fixture",
            kind: "other",
            status: "completed",
            resource: {
              uri: devinResourceLinkFixture.content.uri,
              name: devinResourceLinkFixture.content.name,
              description: devinResourceLinkFixture.content.description,
              mimeType: devinResourceLinkFixture.content.mimeType,
            },
          },
        });
        assert.deepEqual(event.raw?.payload, nativePayload);
        assert.isFalse(containsString(nativeLogs, "malformed-resource-link"));
        assert.isFalse(containsString(nativeLogs, "oversized-resource"));
        assert.isFalse(containsString(nativeLogs, "binary-resource"));
        assert.isFalse(containsString(nativeLogs, "opaque-binary-fixture"));
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* adapter.stopSession(threadId).pipe(Effect.ignore);
            yield* Fiber.interrupt(runtimeEventsFiber);
          }),
        ),
      );
    }),
  );

  it.effect(
    "connects T3 tools from a private workspace and removes it when the session stops",
    () =>
      Effect.gen(function* () {
        const requestLogDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mcp-")),
        );
        const requestLogPath = NodePath.join(requestLogDir, "requests.log");
        const wrapperPath = yield* makeMockDevinWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        });
        const adapter = yield* makeTestAdapter(wrapperPath);
        const threadId = ThreadId.make("devin-t3-mcp");
        const endpoint = "http://127.0.0.1:43123/mcp";
        const authorizationHeader = "Bearer devin-mcp-test-token";

        yield* Effect.sync(() =>
          McpProviderSession.setMcpProviderSession({
            environmentId: EnvironmentId.make("devin-mcp-test-environment"),
            threadId,
            providerSessionId: "devin-mcp-test-session",
            providerInstanceId: ProviderInstanceId.make("devin"),
            endpoint,
            authorizationHeader,
            capabilities: new Set(["preview"]),
          }),
        );

        yield* Effect.gen(function* () {
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("devin"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: devinModelSelection("default"),
          });

          yield* adapter.sendTurn({ threadId, input: "Use the test tool." });

          const logContents = yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8"));
          const requests = logContents
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line): { method?: string; params?: unknown } | undefined => {
              try {
                return JSON.parse(line) as { method?: string; params?: unknown };
              } catch {
                return undefined;
              }
            })
            .filter(
              (value): value is { method: string; params: unknown } =>
                value !== undefined && typeof value.method === "string",
            );
          const newSessionRequest = requests.find((request) => request.method === "session/new");
          assert.isDefined(newSessionRequest);
          const params = newSessionRequest!.params as {
            cwd: string;
            mcpServers: unknown[];
            additionalDirectories: string[];
          };
          assert.equal(params.cwd, process.cwd());
          assert.isEmpty(params.mcpServers);
          assert.lengthOf(params.additionalDirectories, 1);
          const directory = params.additionalDirectories[0]!;
          const connection = requests.find(
            (request) => request.method === "_cognition.ai/mcp/connectServer",
          );
          assert.deepEqual(connection?.params, { serverId: "t3-code", workspaceDirs: [directory] });
          const config = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(directory, ".devin/mcp_config.local.json"), "utf8"),
          );
          assert.include(config, authorizationHeader);
          assert.include(config, endpoint);
          assert.notInclude(logContents, authorizationHeader);
          yield* adapter.stopSession(threadId);
          const exists = yield* Effect.promise(() =>
            NodeFSP.stat(directory).then(
              () => true,
              () => false,
            ),
          );
          assert.isFalse(exists);
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* adapter.stopSession(threadId).pipe(Effect.ignore);
              yield* Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId));
            }),
          ),
        );
      }),
  );

  it.effect("keeps the session ready after rejecting an empty prompt", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockDevinWrapper();
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-empty-prompt-recovery");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "",
          attachments: [],
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapterValidationError);

      const sessionsAfterRejection = yield* adapter.listSessions();
      const sessionAfterRejection = sessionsAfterRejection.find(
        (session) => session.threadId === threadId,
      );
      assert.isUndefined(sessionAfterRejection?.activeTurnId);

      yield* adapter.sendTurn({
        threadId,
        input: "continue after rejected prompt",
        attachments: [],
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("recovers when turn event id generation fails", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const uuidError = PlatformError.systemError({
        _tag: "Unknown",
        module: "Crypto",
        method: "randomUUIDv4",
        description: "UUID generation unavailable",
      });
      let successfulUuidsBeforeFailure: number | undefined;
      const wrapperPath = yield* makeMockDevinWrapper();
      const adapter = yield* makeTestAdapter(wrapperPath).pipe(
        Effect.provideService(Crypto.Crypto, {
          ...crypto,
          randomUUIDv4: Effect.suspend(() => {
            if (successfulUuidsBeforeFailure === undefined) {
              return crypto.randomUUIDv4;
            }
            if (successfulUuidsBeforeFailure > 0) {
              successfulUuidsBeforeFailure -= 1;
              return crypto.randomUUIDv4;
            }
            successfulUuidsBeforeFailure = undefined;
            return Effect.fail(uuidError);
          }),
        }),
      );
      const threadId = ThreadId.make("devin-turn-event-id-recovery");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });

      const turnEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.started" || event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

      // The first UUID opens the turn; the second stamps turn.started.
      successfulUuidsBeforeFailure = 1;
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "fail while opening the turn",
          attachments: [],
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapterRequestError);

      const sessionsAfterFailure = yield* adapter.listSessions();
      const sessionAfterFailure = sessionsAfterFailure.find(
        (session) => session.threadId === threadId,
      );
      assert.isUndefined(sessionAfterFailure?.activeTurnId);

      const recovered = yield* adapter.sendTurn({
        threadId,
        input: "continue after event id failure",
        attachments: [],
      });
      const turnEvents = Array.from(
        yield* Fiber.join(turnEventsFiber).pipe(Effect.timeout("5 seconds")),
      );
      assert.deepStrictEqual(
        turnEvents.map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
      assert.equal(turnEvents[0]?.turnId, recovered.turnId);
      assert.equal(turnEvents[1]?.turnId, recovered.turnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("prompt timeout surfaces a clear error and resets the session", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockDevinWrapper({
        T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
      });
      const adapter = yield* makeTestAdapter(wrapperPath, {
        promptTimeout: "2 seconds",
      });
      const threadId = ThreadId.make("devin-prompt-timeout");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });

      // Run the hanging prompt directly and capture its exit. The 2s
      // prompt timeout should fire and produce a ProviderAdapterRequestError.
      const exit = yield* adapter
        .sendTurn({
          threadId,
          input: "hang forever",
          attachments: [],
        })
        .pipe(
          Effect.map(Exit.succeed),
          Effect.catch((error) => Effect.succeed(Exit.fail(error))),
          Effect.timeoutOption("10 seconds"),
        );
      assert.isTrue(Option.isSome(exit));
      if (Option.isSome(exit)) {
        const result = exit.value;
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) {
          const error = Cause.findErrorOption(result.cause);
          if (Option.isSome(error)) {
            assert.instanceOf(error.value, ProviderAdapterRequestError);
            assert.match(error.value.detail, /timed out/i);
          }
        }
      }

      // After the timeout, the session should still be usable.
      yield* adapter.sendTurn({
        threadId,
        input: "continue after timeout",
        attachments: [],
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancelling a stuck request recovers so the next prompt works", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockDevinWrapper({
        T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
      });
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-cancel-recover");

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) return;
          runtimeEvents.push(event);
          if (event.type === "turn.started") {
            yield* Deferred.succeed(turnStarted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "hang first prompt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      // Wait for the turn to start, then let the prompt RPC actually reach
      // the mock agent before cancelling. `turn.started` fires inside the
      // thread lock before the RPC is sent; cooperative yields let the
      // sendTurn fiber release the lock and dispatch the prompt.
      yield* Deferred.await(turnStarted).pipe(Effect.timeout("5 seconds"));
      for (let i = 0; i < 16; i += 1) {
        yield* Effect.yieldNow;
      }
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("5 seconds"));

      for (let i = 0; i < 8; i += 1) {
        yield* Effect.yieldNow;
      }

      // The session should be ready for a new turn.
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((s) => s.threadId === threadId);
      assert.equal(session?.status, "ready");

      // The next prompt should complete normally.
      yield* adapter.sendTurn({
        threadId,
        input: "continue after cancel",
        attachments: [],
      });

      const completedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const followUpCompleted = completedEvents.filter((e) => e.payload.state === "completed");
      assert.isAtLeast(followUpCompleted.length, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("concurrent sendTurn calls do not create duplicate turns", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockDevinWrapper({ T3_ACP_PROMPT_DELAY_MS: "500" });
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-concurrent-send");

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });

      // Fire two sendTurn calls concurrently. The thread lock should
      // serialize preparation so only one opens a new turn; the second
      // becomes a steer on the same turn.
      const [first, second] = yield* Effect.all(
        [
          adapter.sendTurn({ threadId, input: "first", attachments: [] }),
          adapter.sendTurn({ threadId, input: "second", attachments: [] }),
        ],
        { concurrency: 2 },
      );

      // Both should return the same turn id (steer).
      assert.equal(String(first.turnId), String(second.turnId));

      const turnStartedEvents = runtimeEvents.filter((e) => e.type === "turn.started");
      assert.equal(turnStartedEvents.length, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("emits context-window and per-turn usage for ACP telemetry", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockDevinWrapper({ T3_ACP_EMIT_USAGE_UPDATE: "1" });
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-usage-telemetry");
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });
      yield* adapter.sendTurn({ threadId, input: "measure usage", attachments: [] });
      yield* Effect.yieldNow;

      const usageEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
          event.type === "thread.token-usage.updated",
      );
      assert.isAtLeast(usageEvents.length, 2);
      const contextUsage = usageEvents.find((event) => event.payload.usage.maxTokens === 200_000);
      assert.exists(contextUsage);
      assert.equal(contextUsage?.payload.usage.usedTokens, 12_000);
      const turnUsage = usageEvents.find((event) => event.payload.usage.lastOutputTokens === 120);
      assert.exists(turnUsage);
      assert.equal(turnUsage?.payload.usage.lastInputTokens, 1_000);
      assert.equal(turnUsage?.payload.usage.lastCachedInputTokens, 250);
      assert.equal(turnUsage?.payload.usage.lastCacheCreationTokens, 50);
      assert.equal(turnUsage?.payload.usage.lastCostUsd, 0.02);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reinitializes the ACP session when the model changes mid-thread", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockDevinWrapper();
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-model-change-restart");

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });

      // First turn with the initial model.
      yield* adapter.sendTurn({
        threadId,
        input: "hello with default model",
        attachments: [],
      });

      // Now send a turn with a different model. The adapter should
      // internally restart the ACP session and restore context via
      // loadSession, keeping the same T3 thread.
      yield* adapter.sendTurn({
        threadId,
        input: "now with composer-2",
        attachments: [],
        modelSelection: devinModelSelection("composer-2"),
      });

      // The session should still be active with the new model.
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((s) => s.threadId === threadId);
      assert.equal(session?.status, "ready");
      assert.equal(session?.model, "composer-2");

      // We should see a "starting" state change for the reinit, then "ready".
      const stateChanges = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "session.state.changed" }> =>
          event.type === "session.state.changed" && String(event.threadId) === String(threadId),
      );
      const reinitStates = stateChanges.filter((e) => e.payload.reason?.includes("model change"));
      assert.isAtLeast(reinitStates.length, 2);
      assert.equal(reinitStates[0]?.payload.state, "starting");
      assert.equal(reinitStates[1]?.payload.state, "ready");

      // No session.exited should be emitted — the thread stays continuous.
      const exitedEvents = runtimeEvents.filter(
        (event) => event.type === "session.exited" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(exitedEvents, 0);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  // Verifies that a model-change restart initializes the new ACP session with
  // loadSession using the previous session id. Per the ACP spec, the backend
  // replays the full conversation (including images) via session/update
  // notifications, so the adapter does not client-side replay prior images.
  it.effect("model-change restart loads the prior session without client-side image replay", () =>
    Effect.gen(function* () {
      // A request log captures every JSON-RPC request the adapter sends to
      // the mock Devin CLI, so we can assert on loadSession and prompt
      // payloads across the restart. The wrapper re-sets this env var on
      // every invocation, so the restarted child process appends to the
      // same file.
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-reqlog-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.log");
      const wrapperPath = yield* makeMockDevinWrapper({
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      });
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-image-replay");

      // Write a small PNG into the test attachments dir so the adapter can
      // resolve and base64-encode it as an image attachment.
      const serverConfig = yield* Effect.service(ServerConfig);
      const attachmentsDir = serverConfig.attachmentsDir;
      yield* Effect.promise(() => NodeFSP.mkdir(attachmentsDir, { recursive: true }));
      const attachmentId = "devin-image-replay-test-image";
      const imageBytes = Buffer.from(
        // 1x1 transparent PNG.
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64",
      );
      const imageFilePath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      yield* Effect.promise(() => NodeFSP.writeFile(imageFilePath, imageBytes));

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });

      // First turn includes an image attachment. The adapter base64-encodes
      // it into the prompt and tracks it in priorImages for replay on restart.
      yield* adapter.sendTurn({
        threadId,
        input: "look at this image",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "test.png",
            mimeType: "image/png",
            sizeBytes: imageBytes.length,
          },
        ],
      });

      // Trigger the model-change restart by sending a turn with a new model.
      // The adapter tears down the old ACP runtime and spawns a new one with
      // the previous session id for loadSession context restoration.
      yield* adapter.sendTurn({
        threadId,
        input: "now with composer-2",
        attachments: [],
        modelSelection: devinModelSelection("composer-2"),
      });

      // The visible T3 thread stays continuous: same threadId, no
      // session.exited, and the session is ready with the new model.
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((s) => s.threadId === threadId);
      assert.equal(session?.status, "ready");
      assert.equal(session?.model, "composer-2");

      const exitedEvents = runtimeEvents.filter(
        (event) => event.type === "session.exited" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(exitedEvents, 0);

      // The restart must emit the starting -> ready state changes.
      const stateChanges = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "session.state.changed" }> =>
          event.type === "session.state.changed" && String(event.threadId) === String(threadId),
      );
      const reinitStates = stateChanges.filter((e) => e.payload.reason?.includes("model change"));
      assert.isAtLeast(reinitStates.length, 2);
      assert.equal(reinitStates[0]?.payload.state, "starting");
      assert.equal(reinitStates[1]?.payload.state, "ready");

      // Parse the raw JSON-RPC request log captured from the mock CLI.
      const logContents = yield* Effect.promise(() =>
        NodeFSP.readFile(requestLogPath, "utf8").catch(() => ""),
      );
      const requests = logContents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line): { method?: string; params?: unknown } | undefined => {
          try {
            return JSON.parse(line) as { method?: string; params?: unknown };
          } catch {
            return undefined;
          }
        })
        .filter(
          (value): value is { method: string; params: unknown } =>
            value !== undefined && typeof value.method === "string",
        );

      // The restart must initialize the new ACP session with loadSession,
      // passing the previous session id so the Devin backend restores
      // conversation context.
      const loadSessionRequests = requests.filter((r) => r.method === "session/load");
      assert.isAtLeast(loadSessionRequests.length, 1);
      const loadParams = loadSessionRequests[0]!.params as { sessionId?: string };
      assert.equal(loadParams.sessionId, "mock-session-1");

      // Per the ACP spec, session/load MUST replay the entire conversation
      // history (including images) via session/update notifications. The
      // loadSession request itself carries only { sessionId, cwd, mcpServers }
      // because the backend already has the conversation content. The adapter
      // does NOT client-side replay prior images — that would duplicate them
      // in the agent's context (once from the backend's session restore, once
      // from our replay). T3 Code's own read model persists across the model
      // change for the UI side. These assertions confirm the correct behavior.
      const loadParamsBlocks = (
        loadSessionRequests[0]!.params as {
          prompt?: ReadonlyArray<{ type?: string }>;
        }
      )?.prompt;
      assert.isUndefined(
        loadParamsBlocks,
        "loadSession payload should not carry a prompt with image blocks",
      );

      // Only the original first-turn prompt should carry an image content
      // block. The model-change turn sends text only, and the adapter does
      // not re-send prior images as a replay prompt.
      const promptRequests = requests.filter((r) => r.method === "session/prompt");
      const promptsWithImages = promptRequests.filter((r) => {
        const params = r.params as { prompt?: ReadonlyArray<{ type?: string }> } | undefined;
        return (
          Array.isArray(params?.prompt) && params!.prompt.some((block) => block.type === "image")
        );
      });
      assert.lengthOf(promptsWithImages, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  // After a model-change restart, a subsequent turn carrying an image
  // attachment must still be accepted and base64-encoded into the
  // session/prompt request on the fresh ACP session. This pins that the
  // restart path does not leave the session unable to ingest images, and
  // that the image block lands in the prompt RPC (not just tracked in
  // priorImages).
  it.effect("accepts an image attachment on a turn after a model-change restart", () =>
    Effect.gen(function* () {
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-reqlog-img-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.log");
      const wrapperPath = yield* makeMockDevinWrapper({
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      });
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-image-after-restart");

      const serverConfig = yield* Effect.service(ServerConfig);
      const attachmentsDir = serverConfig.attachmentsDir;
      yield* Effect.promise(() => NodeFSP.mkdir(attachmentsDir, { recursive: true }));
      const attachmentId = "devin-image-after-restart-img";
      const imageBytes = Buffer.from(
        // 1x1 transparent PNG.
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64",
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(attachmentsDir, `${attachmentId}.png`), imageBytes),
      );

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });

      // First turn with the initial model so the session has a response.
      yield* adapter.sendTurn({
        threadId,
        input: "first turn with default model",
        attachments: [],
      });

      // Trigger the model-change restart with a text-only turn.
      yield* adapter.sendTurn({
        threadId,
        input: "switch to composer-2",
        attachments: [],
        modelSelection: devinModelSelection("composer-2"),
      });

      // Now send a turn with an image attachment on the restarted session.
      yield* adapter.sendTurn({
        threadId,
        input: "look at this image on composer-2",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "test.png",
            mimeType: "image/png",
            sizeBytes: imageBytes.length,
          },
        ],
      });

      // The session stays continuous and reports the new model.
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((s) => s.threadId === threadId);
      assert.equal(session?.status, "ready");
      assert.equal(session?.model, "composer-2");

      const exitedEvents = runtimeEvents.filter(
        (event) => event.type === "session.exited" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(exitedEvents, 0);

      const logContents = yield* Effect.promise(() =>
        NodeFSP.readFile(requestLogPath, "utf8").catch(() => ""),
      );
      const requests = logContents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line): { method?: string; params?: unknown } | undefined => {
          try {
            return JSON.parse(line) as { method?: string; params?: unknown };
          } catch {
            return undefined;
          }
        })
        .filter(
          (value): value is { method: string; params: unknown } =>
            value !== undefined && typeof value.method === "string",
        );

      // The restart must have called loadSession with the prior session id.
      const loadSessionRequests = requests.filter((r) => r.method === "session/load");
      assert.isAtLeast(loadSessionRequests.length, 1);
      const loadParams = loadSessionRequests[0]!.params as { sessionId?: string };
      assert.equal(loadParams.sessionId, "mock-session-1");

      // The last session/prompt must carry a base64 image content block —
      // the image attachment on the post-restart turn is accepted and sent.
      const promptRequests = requests.filter((r) => r.method === "session/prompt");
      assert.isAtLeast(promptRequests.length, 1);
      const lastPrompt = promptRequests.at(-1)!;
      const lastPromptParams = lastPrompt.params as {
        prompt?: ReadonlyArray<{ type?: string; data?: string; mimeType?: string }>;
      };
      const imageBlocks = (lastPromptParams.prompt ?? []).filter((block) => block.type === "image");
      assert.lengthOf(imageBlocks, 1);
      assert.equal(imageBlocks[0]!.mimeType, "image/png");
      // The base64 data must round-trip back to the original PNG bytes.
      assert.equal(
        Buffer.from(imageBlocks[0]!.data ?? "", "base64").toString("base64"),
        imageBytes.toString("base64"),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  const readPromptRequests = (logContents: string) =>
    logContents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line): { method?: string; params?: unknown } | undefined => {
        try {
          return JSON.parse(line) as { method?: string; params?: unknown };
        } catch {
          return undefined;
        }
      })
      .filter(
        (value): value is { method: string; params: unknown } =>
          value !== undefined && typeof value.method === "string",
      )
      .filter((request) => request.method === "session/prompt");

  it.effect("dispatches a known $skill mention as @skills:name to Devin", () =>
    Effect.gen(function* () {
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-skills-req-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.log");
      const skillsJsonPath = NodePath.join(requestLogDir, "skills.json");
      const skillsCallLogPath = NodePath.join(requestLogDir, "skills-calls.log");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          skillsJsonPath,
          encodeUnknownJson([
            {
              name: "deploy",
              base_dir: NodePath.join(requestLogDir, "skills", "deploy"),
              description: "Deploy the app.",
              triggers: ["user", "model"],
            },
          ]),
          "utf8",
        ),
      );
      const wrapperPath = yield* makeMockDevinWrapper(
        { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
        { jsonPath: skillsJsonPath, callLogPath: skillsCallLogPath },
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-skill-dispatch");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });
      yield* adapter.sendTurn({
        threadId,
        input: "$deploy staging now",
        attachments: [],
      });

      const logContents = yield* Effect.promise(() =>
        NodeFSP.readFile(requestLogPath, "utf8").catch(() => ""),
      );
      const promptRequests = readPromptRequests(logContents);
      assert.isAtLeast(promptRequests.length, 1);
      const lastPrompt = promptRequests.at(-1)!;
      const params = lastPrompt.params as {
        prompt?: ReadonlyArray<{ type?: string; text?: string }>;
      };
      const textBlocks = (params.prompt ?? []).filter((block) => block.type === "text");
      assert.lengthOf(textBlocks, 1);
      assert.equal(textBlocks[0]!.text, "@skills:deploy staging now");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends the original prompt unchanged when skill discovery fails", () =>
    Effect.gen(function* () {
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-skill-fail-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.log");
      const skillsJsonPath = NodePath.join(requestLogDir, "skills.json");
      const skillsCallLogPath = NodePath.join(requestLogDir, "skills-calls.log");
      yield* Effect.promise(() => NodeFSP.writeFile(skillsJsonPath, "[]", "utf8"));
      const wrapperPath = yield* makeMockDevinWrapper(
        { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
        { jsonPath: skillsJsonPath, callLogPath: skillsCallLogPath, exitCode: 3 },
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-skill-fail");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });
      yield* adapter.sendTurn({
        threadId,
        input: "$deploy staging now",
        attachments: [],
      });

      const logContents = yield* Effect.promise(() =>
        NodeFSP.readFile(requestLogPath, "utf8").catch(() => ""),
      );
      const promptRequests = readPromptRequests(logContents);
      assert.isAtLeast(promptRequests.length, 1);
      const lastPrompt = promptRequests.at(-1)!;
      const params = lastPrompt.params as {
        prompt?: ReadonlyArray<{ type?: string; text?: string }>;
      };
      const textBlocks = (params.prompt ?? []).filter((block) => block.type === "text");
      // Discovery failed, so the original prompt goes out unchanged.
      assert.lengthOf(textBlocks, 1);
      assert.equal(textBlocks[0]!.text, "$deploy staging now");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("caches a successful discovery per workspace across turns", () =>
    Effect.gen(function* () {
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-skill-cache-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.log");
      const skillsJsonPath = NodePath.join(requestLogDir, "skills.json");
      const skillsCallLogPath = NodePath.join(requestLogDir, "skills-calls.log");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          skillsJsonPath,
          encodeUnknownJson([{ name: "deploy", base_dir: NodePath.join(requestLogDir, "deploy") }]),
          "utf8",
        ),
      );
      const wrapperPath = yield* makeMockDevinWrapper(
        { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
        { jsonPath: skillsJsonPath, callLogPath: skillsCallLogPath },
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("devin-skill-cache");

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: devinModelSelection("default"),
      });
      yield* adapter.sendTurn({ threadId, input: "$deploy staging", attachments: [] });
      yield* adapter.sendTurn({
        threadId,
        input: "follow up with $deploy again",
        attachments: [],
      });

      const calls = yield* Effect.promise(() =>
        NodeFSP.readFile(skillsCallLogPath, "utf8").catch(() => ""),
      );
      // Two turns, one discovery: the successful catalog is cached per cwd.
      assert.lengthOf(
        calls.split("called").filter((part) => part.length === 0),
        1,
      );

      const logContents = yield* Effect.promise(() =>
        NodeFSP.readFile(requestLogPath, "utf8").catch(() => ""),
      );
      const promptRequests = readPromptRequests(logContents);
      assert.lengthOf(promptRequests, 2);
      const firstText = (
        (
          promptRequests[0]!.params as {
            prompt?: ReadonlyArray<{ type?: string; text?: string }>;
          }
        ).prompt ?? []
      ).find((block) => block.type === "text")?.text;
      const secondText = (
        (
          promptRequests.at(-1)!.params as {
            prompt?: ReadonlyArray<{ type?: string; text?: string }>;
          }
        ).prompt ?? []
      ).find((block) => block.type === "text")?.text;
      assert.equal(firstText, "@skills:deploy staging");
      assert.equal(secondText, "follow up with @skills:deploy again");

      yield* adapter.stopSession(threadId);
    }),
  );
});
