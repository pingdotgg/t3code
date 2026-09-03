// @effect-diagnostics nodeBuiltinImport:off - the suite creates real temp dirs and reads the mock agent's JSONL request log outside the Effect FileSystem.
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
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { createModelSelection } from "@t3tools/shared/model";

import {
  ApprovalRequestId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ACP_AGENT_DEFAULT_MODEL_SLUG } from "../acp/AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import { makeAcpAdapter } from "./AcpAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const ACP_PROVIDER = ProviderDriverKind.make("acp");
const ACP_INSTANCE = ProviderInstanceId.make("acp_test");

const makeTestAcpAdapter = (environment: NodeJS.ProcessEnv) =>
  makeAcpAdapter(
    {
      provider: ACP_PROVIDER,
      displayName: "Test ACP",
      makeRuntime: ({ childProcessSpawner, environment: runtimeEnvironment, ...input }) =>
        AcpSessionRuntime.make({
          ...input,
          respectAgentCapabilities: true,
          reasoningStream: true,
          clientCapabilities: { _meta: { parameterizedModelPicker: true } },
          spawn: {
            command: "node",
            args: [mockAgentPath],
            cwd: input.cwd,
            ...(runtimeEnvironment ? { env: runtimeEnvironment } : {}),
          },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        ),
    },
    { instanceId: ACP_INSTANCE, environment },
  );

const makeRequestLog = (prefix: string) =>
  Effect.promise(async () => {
    const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
    return NodePath.join(tempDir, "requests.jsonl");
  });

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const acpAdapterTestLayer = it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-acp-adapter-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);

acpAdapterTestLayer("AcpAdapterLive", (it) => {
  it.effect("runs a configured ACP agent with its selected model and options", () =>
    Effect.gen(function* () {
      const requestLogPath = yield* makeRequestLog("acp-model-");
      const adapter = yield* makeTestAcpAdapter({
        ...process.env,
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_ALLOW_ALWAYS_OPTION_ID: "agent-session-permission",
      });
      const threadId = ThreadId.make("acp-thread");

      yield* adapter.startSession({
        threadId,
        provider: ACP_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: createModelSelection(ACP_INSTANCE, "gpt-5.4", [
          { id: "reasoning", value: "high" },
        ]),
      });
      yield* adapter.sendTurn({ threadId, input: "hello ACP", attachments: [] });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      // Full-access mode auto-approves with the agent's own option id.
      assert.deepInclude(
        requests.map((request) => request.result),
        { outcome: { outcome: "selected", optionId: "agent-session-permission" } },
      );
      const selections = requests.flatMap((request) => {
        if (request.method !== "session/set_config_option") return [];
        const { configId, value } = request.params as { configId: string; value: unknown };
        return [{ configId, value }];
      });
      assert.includeDeepMembers(selections, [
        { configId: "model", value: "gpt-5.4" },
        { configId: "reasoning", value: "high" },
      ]);
      assert.include(
        requests.map((request) => request.method),
        "session/close",
      );
    }),
  );

  it.effect("switches models in-session and keeps the agent default opaque", () =>
    Effect.gen(function* () {
      const requestLogPath = yield* makeRequestLog("acp-default-");
      const adapter = yield* makeTestAcpAdapter({
        ...process.env,
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      });
      const threadId = ThreadId.make("acp-default-thread");

      assert.equal(adapter.capabilities.sessionModelSwitch, "in-session");

      const session = yield* adapter.startSession({
        threadId,
        provider: ACP_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: createModelSelection(ACP_INSTANCE, ACP_AGENT_DEFAULT_MODEL_SLUG),
      });
      assert.equal(session.model, ACP_AGENT_DEFAULT_MODEL_SLUG);
      assert.isUndefined(session.resumeCursor);

      yield* adapter.sendTurn({
        threadId,
        input: "switch model",
        attachments: [],
        modelSelection: createModelSelection(ACP_INSTANCE, "composer-2"),
      });
      // A custom model the agent does not advertise is forwarded and rejected by
      // the runtime's option validation rather than silently ignored.
      const rejected = yield* adapter
        .sendTurn({
          threadId,
          input: "custom model",
          attachments: [],
          modelSelection: createModelSelection(ACP_INSTANCE, "my-custom"),
        })
        .pipe(Effect.flip);
      assert.equal(rejected._tag, "ProviderAdapterRequestError");
      assert.match(rejected.message, /expected one of/);
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modelWrites = requests.flatMap((request) =>
        request.method === "session/set_config_option" &&
        (request.params as { configId: string }).configId === "model"
          ? [(request.params as { value: unknown }).value]
          : [],
      );
      assert.deepStrictEqual(modelWrites, ["composer-2"]);
      assert.equal(requests.filter((request) => request.method === "session/new").length, 1);
    }),
  );

  it.effect("maps the ACP prompt flow, including agent thoughts, to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAcpAdapter({
        ...process.env,
        T3_ACP_EMIT_THOUGHT_CHUNK: "1",
      });
      const threadId = ThreadId.make("acp-flow-thread");

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ACP_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "acp");
      assert.equal(session.providerInstanceId, ACP_INSTANCE);

      yield* adapter.sendTurn({ threadId, input: "hello mock", attachments: [] });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((event) => event.type);
      for (const type of [
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
        assert.include(types, type);
      }

      const deltas = runtimeEvents.flatMap((event) =>
        event.type === "content.delta" ? [[event.payload.streamKind, event.payload.delta]] : [],
      );
      assert.deepStrictEqual(deltas, [
        ["reasoning_text", "thinking about mock"],
        ["assistant_text", "hello from mock"],
      ]);
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

  it.effect("answers a permission request with the agent's offered rejection option", () =>
    Effect.gen(function* () {
      const requestLogPath = yield* makeRequestLog("acp-decline-");
      const adapter = yield* makeTestAcpAdapter({
        ...process.env,
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_REJECT_ONCE_OPTION_ID: "agent-reject",
      });
      const threadId = ThreadId.make("acp-decline-thread");
      const requestResolved = yield* Deferred.make<ProviderRuntimeEvent>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (event.type === "request.opened" && event.requestId) {
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "decline",
            );
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolved, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ACP_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "run a tool", attachments: [] });
      const resolved = yield* Deferred.await(requestResolved);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);

      if (resolved.type === "request.resolved") {
        assert.equal(resolved.payload.decision, "decline");
      }
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.deepInclude(
        requests.map((request) => request.result),
        { outcome: { outcome: "selected", optionId: "agent-reject" } },
      );
    }),
  );

  it.effect(
    "switches modes through session/set_mode when the agent only exposes legacy modes",
    () =>
      Effect.gen(function* () {
        const requestLogPath = yield* makeRequestLog("acp-legacy-modes-");
        const adapter = yield* makeTestAcpAdapter({
          ...process.env,
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_OMIT_MODE_CONFIG_OPTION: "1",
        });
        const threadId = ThreadId.make("acp-legacy-modes-thread");

        yield* adapter.startSession({
          threadId,
          provider: ACP_PROVIDER,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId,
          input: "plan it",
          attachments: [],
          interactionMode: "plan",
        });
        yield* adapter.stopSession(threadId);

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const modeWrites = requests.flatMap((request) =>
          request.method === "session/set_mode"
            ? [(request.params as { modeId: string }).modeId]
            : [],
        );
        // full-access start selects the implement mode, the plan turn the plan alias.
        assert.deepStrictEqual(modeWrites, ["code", "architect"]);
        assert.isEmpty(
          requests.filter(
            (request) =>
              request.method === "session/set_config_option" &&
              (request.params as { configId: string }).configId === "mode",
          ),
        );
      }),
  );

  it.effect("settles the turn as failed when the prompt request fails", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAcpAdapter({ ...process.env, T3_ACP_FAIL_PROMPT: "1" });
      const threadId = ThreadId.make("acp-failed-prompt-thread");
      const turnEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.started" || event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ACP_PROVIDER,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const error = yield* adapter
        .sendTurn({ threadId, input: "please fail", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");

      const turnEvents = Array.from(yield* Fiber.join(turnEventsFiber));
      assert.deepStrictEqual(
        turnEvents.map((event) => event.type),
        ["turn.started", "turn.completed"],
      );
      const completed = turnEvents[1];
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.equal(completed.payload.errorMessage, error.message);
      }
      const [session] = yield* adapter.listSessions();
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when the provider mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* makeTestAcpAdapter({ ...process.env });
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("acp-mismatch"),
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );
});
