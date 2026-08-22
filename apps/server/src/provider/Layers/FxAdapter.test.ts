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
  FxSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { fxPromptSettlementBelongsToContext, makeFxAdapter } from "./FxAdapter.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockFxWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fx-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-fx.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const fxAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-fx-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeFxAdapter>[1]) =>
  makeFxAdapter(decodeFxSettings({ binaryPath }), options).pipe(Effect.orDie);

it("requires a settlement to match the live fx turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    fxPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    fxPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it.layer(fxAdapterTestLayer)("FxAdapterLive", (it) => {
  it.effect("runs a standard ACP session without an authenticate request", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fx-mock-thread");
      const requestLogDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fx-acp-requests-")),
      );
      const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockFxWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("fx"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("fx"), model: "composer-2" },
      });

      assert.equal(session.provider, "fx");
      assert.equal(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello fx",
        attachments: [],
      });
      yield* Deferred.await(turnCompleted);

      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventsFiber);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.include(
        requests.map((request) => request.method),
        "initialize",
      );
      assert.include(
        requests.map((request) => request.method),
        "session/new",
      );
      assert.notInclude(
        requests.map((request) => request.method),
        "authenticate",
      );
      assert.isTrue(
        requests.some(
          (request) =>
            request.method === "session/set_config_option" &&
            (request.params as { configId?: string; value?: string } | undefined)?.configId ===
              "model" &&
            (request.params as { value?: string } | undefined)?.value === "composer-2",
        ),
      );
    }),
  );

  it.effect("keeps the selected model when prompt preparation fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fx-model-switch-preparation-failure");
      const wrapperPath = yield* Effect.promise(() => makeMockFxWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const switchedModel = "gpt-5.3-codex[reasoning=medium,fast=false]";

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("fx"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("fx"), model: "composer-2" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "use the screenshot",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
          modelSelection: { instanceId: ProviderInstanceId.make("fx"), model: switchedModel },
        }),
      );

      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(session?.status, "ready");
      assert.equal(session?.model, switchedModel);

      yield* adapter.stopSession(threadId);
    }),
  );
});
