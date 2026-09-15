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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  KiroSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  kiroApprovalOperationInput,
  makeKiroAdapter,
  selectKiroPermissionOptionId,
} from "./KiroAdapter.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

// Every mock rejects `authenticate` the way the real Kiro agent does, so a
// passing session start proves the runtime never sends it.
async function makeMockKiroWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-kiro-cli",
    env: { T3_ACP_REJECT_AUTHENTICATE: "1", ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
  });
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const kiroAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKiroAdapter>[1]) =>
  makeKiroAdapter(decodeKiroSettings({ binaryPath }), options).pipe(Effect.orDie);

it("drops Kiro's per-call purpose note from the approval identity", () => {
  assert.deepEqual(
    kiroApprovalOperationInput({ command: "echo hi", __tool_use_purpose: "Say hello" }),
    { command: "echo hi" },
  );
  assert.deepEqual(kiroApprovalOperationInput({ path: "/tmp/x" }), { path: "/tmp/x" });
  assert.equal(kiroApprovalOperationInput("raw"), "raw");
});

it("maps Always allow to allow_once when Kiro omits allow_always", () => {
  const request = {
    sessionId: "mock-session-1",
    toolCall: { toolCallId: "tool-call-1", title: "Running: echo hi" },
    options: [
      { optionId: "allow_once", name: "Yes", kind: "allow_once" as const },
      { optionId: "reject_once", name: "No", kind: "reject_once" as const },
    ],
  };
  assert.equal(selectKiroPermissionOptionId(request, "acceptForSession"), "allow_once");
  assert.equal(selectKiroPermissionOptionId(request, "acceptAlways"), "allow_once");
  assert.equal(selectKiroPermissionOptionId(request, "accept"), "allow_once");
  assert.equal(selectKiroPermissionOptionId(request, "decline"), "reject_once");
});

it("maps acceptAlways to allow_always like acceptForSession when Kiro offers it", () => {
  const request = {
    sessionId: "mock-session-1",
    toolCall: { toolCallId: "tool-call-1", title: "Running: echo hi" },
    options: [
      { optionId: "allow_once", name: "Yes", kind: "allow_once" as const },
      { optionId: "allow_always", name: "Always", kind: "allow_always" as const },
      { optionId: "reject_once", name: "No", kind: "reject_once" as const },
    ],
  };
  assert.equal(selectKiroPermissionOptionId(request, "acceptAlways"), "allow_always");
  assert.equal(selectKiroPermissionOptionId(request, "acceptForSession"), "allow_always");
});

it.layer(kiroAdapterTestLayer)("KiroAdapterLive", (it) => {
  it.effect("starts without ACP authenticate and maps the mock prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-mock-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-requests-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
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

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        // The mock agent's non-default model id; Kiro forwards any id the catalog advertises.
        modelSelection: { instanceId: ProviderInstanceId.make("kiro"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "kiro");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello kiro", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const types = runtimeEvents.map((event) => event.type);
      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);
      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requests.map((request) => request.method);
      assert.notInclude(methods, "authenticate");
      assert.include(methods, "session/set_model");
      const prompt = requests.find((request) => request.method === "session/prompt");
      assert.isDefined(prompt);
      const promptParts = (prompt!.params as { prompt: Array<{ type: string; text: string }> })
        .prompt;
      assert.deepEqual(promptParts[0], { type: "text", text: "hello kiro" });
      assert.include(promptParts[1]?.text, "Kiro harness, as grok-mock-alt");
    }),
  );

  it.effect("remembers Always allow across Kiro's changing tool purpose notes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-always-allow-purpose");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_KIRO_PERMISSION_INPUT: "1",
          T3_ACP_OMIT_ALLOW_ALWAYS: "1",
          T3_ACP_PERMISSION_REQUEST_COUNT: "2",
          T3_ACP_PERMISSION_TITLE: "Running: cat server/package.json",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const openedCount = yield* Ref.make(0);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Effect.gen(function* () {
              yield* Ref.update(openedCount, (count) => count + 1);
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "acceptForSession",
              );
            })
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this session", attachments: [] });

      assert.equal(yield* Ref.get(openedCount), 1);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("asks before a different command after Always allow this session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-session-approval-scope");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_KIRO_PERMISSION_INPUT: "1",
          T3_ACP_OMIT_ALLOW_ALWAYS: "1",
          T3_ACP_PERMISSION_REQUEST_COUNT: "2",
          T3_ACP_PERMISSION_TITLE: "Running a shell command",
          T3_ACP_SECOND_PERMISSION_COMMAND: "rm server/package.json",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const openedCount = yield* Ref.make(0);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(openedCount, (value) => value + 1);
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                count === 1 ? "acceptForSession" : "decline",
              );
            })
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "check approval scope", attachments: [] });
      assert.equal(yield* Ref.get(openedCount), 2);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects rollback and structured user input without dropping the session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-unsupported-operations");
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "Remember this turn" });
      const originalTurns = [...(yield* adapter.readThread(threadId)).turns];

      assert.isFalse(adapter.capabilities.supportsConversationRollback);
      const rollbackError = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.equal(rollbackError._tag, "ProviderAdapterRequestError");
      const userInputError = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.make("missing"), {})
        .pipe(Effect.flip);
      assert.equal(userInputError._tag, "ProviderAdapterRequestError");

      assert.deepStrictEqual((yield* adapter.readThread(threadId)).turns, originalTurns);
      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("kiro-provider-mismatch"),
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );
});
