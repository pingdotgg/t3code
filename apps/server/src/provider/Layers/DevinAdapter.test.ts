// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { DevinAdapterShape } from "../Services/DevinAdapter.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

// Test-local service tag so the rest of the file can keep using `yield* DevinAdapter`.
class DevinAdapter extends Context.Service<DevinAdapter, DevinAdapterShape>()(
  "t3/provider/Layers/DevinAdapter.test/DevinAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-devin",
    env: extraEnv ?? {},
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
}

async function makeProbeWrapper(
  requestLogPath: string,
  argvLogPath: string,
  extraEnv?: Record<string, string>,
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-probe-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-devin",
    env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
  });
}

async function readArgvLog(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Tests mutate `ServerSettingsService` mid-flight (setting
// `providers.devin.binaryPath` to a mock ACP wrapper); see the equivalent
// resolver comment in CursorAdapter.test.ts.
const makeResolveDevinSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.devin),
      Effect.orDie,
    ),
  );
});

const devinAdapterTestLayer = it.layer(
  Layer.effect(
    DevinAdapter,
    Effect.gen(function* () {
      const devinConfig = decodeDevinSettings({});
      const resolveSettings = yield* makeResolveDevinSettings;
      return yield* makeDevinAdapter(devinConfig, { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-devin-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

devinAdapterTestLayer("DevinAdapter", (it) => {
  it.effect(
    "starts a session, applies the selected model, and maps the prompt flow to runtime events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("devin-mock-thread");
        const workspace = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-workspace-")),
        );
        const requestLogPath = NodePath.join(workspace, "requests.ndjson");
        const argvLogPath = NodePath.join(workspace, "argv.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("devin"),
          cwd: workspace,
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("devin"),
            model: "composer-2",
          },
        });

        assert.equal(session.provider, "devin");
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
        const types = runtimeEvents.map((event) => event.type);
        for (const t of [
          "session.started",
          "session.state.changed",
          "thread.started",
          "turn.started",
          "content.delta",
          "turn.completed",
        ] as const) {
          assert.include(types, t);
        }

        const delta = runtimeEvents.find((event) => event.type === "content.delta");
        if (delta?.type === "content.delta") {
          assert.equal(delta.payload.delta, "hello from mock");
        }

        yield* adapter.stopSession(threadId);

        // full-access spawns `devin --permission-mode bypass acp`.
        const argv = yield* Effect.promise(() => readArgvLog(argvLogPath));
        assert.deepStrictEqual(argv, [["--permission-mode", "bypass", "acp"]]);

        // Model selection goes through the model config option. The mock has
        // no `bypass` mode, so full-access leaves the session mode alone.
        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const configRequests = requests
          .filter((entry) => entry.method === "session/set_config_option")
          .map((entry) => {
            const params = entry.params as { configId: string; value: unknown };
            return { configId: params.configId, value: params.value };
          });
        assert.includeDeepMembers(configRequests, [{ configId: "model", value: "composer-2" }]);
      }),
  );

  it.effect("maps approval-required to --permission-mode normal at spawn", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-approval-thread");
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-approval-")),
      );
      const argvLogPath = NodePath.join(workspace, "argv.txt");
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: workspace,
        runtimeMode: "approval-required",
      });
      yield* adapter.stopSession(threadId);

      const argv = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.deepStrictEqual(argv, [["--permission-mode", "normal", "acp"]]);

      // The mock starts in the read-only `ask` mode; approval-required must
      // restore the least-privileged writable mode so work can proceed.
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequests = requests
        .filter((entry) => entry.method === "session/set_config_option")
        .map((entry) => {
          const params = entry.params as { configId: string; value: unknown };
          return { configId: params.configId, value: params.value };
        })
        .filter((params) => params.configId === "mode");
      assert.deepStrictEqual(modeRequests, [{ configId: "mode", value: "code" }]);
    }),
  );

  it.effect("routes plan turns to the agent's plan/architect mode", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-plan-thread");
      const workspace = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-plan-")),
      );
      const requestLogPath = NodePath.join(workspace, "requests.ndjson");
      const argvLogPath = NodePath.join(workspace, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: workspace,
        runtimeMode: "auto-accept-edits",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan this out",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequests = requests
        .filter((entry) => entry.method === "session/set_config_option")
        .map((entry) => {
          const params = entry.params as { configId: string; value: unknown };
          return { configId: params.configId, value: params.value };
        })
        .filter((params) => params.configId === "mode");
      // Session start maps auto-accept-edits -> code; the plan turn then
      // maps to the mock's architect mode.
      assert.deepStrictEqual(modeRequests, [
        { configId: "mode", value: "code" },
        { configId: "mode", value: "architect" },
      ]);
    }),
  );

  it.effect("surfaces a permission request and resolves it on respondToRequest", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("devin-permission-thread");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* settings.updateSettings({ providers: { devin: { binaryPath: wrapperPath } } });

      const approvalRequestedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "request.opened" }> =>
            event.type === "request.opened" && event.threadId === threadId,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "read package.json", attachments: [] })
        .pipe(Effect.forkChild);

      const approvalEvents = yield* Fiber.join(approvalRequestedFiber);
      const approvalRequest = Array.from(approvalEvents)[0];
      assert.isDefined(approvalRequest);
      assert.equal(approvalRequest.payload.requestType, "exec_command_approval");

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(approvalRequest.requestId)),
        "accept",
      );

      const turn = yield* Fiber.join(sendTurnFiber);
      assert.equal(turn.threadId, threadId);
      yield* adapter.stopSession(threadId);
    }),
  );
});
