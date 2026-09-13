// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  DevinSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { makeDevinAdapter } from "./DevinAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

async function makeMockDevinWrapper(extraEnv?: Record<string, string>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "devin-acp-mock-"));
  return writeFakeCli({
    directory,
    name: "fake-devin",
    env: extraEnv ?? {},
    source: execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["acp"] }),
  });
}

const devinAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-devin-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string) =>
  makeDevinAdapter(decodeDevinSettings({ binaryPath })).pipe(Effect.orDie);

it.layer(devinAdapterTestLayer)("DevinAdapterLive", (it) => {
  it.effect("rejects a session bound to another provider instance", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockDevinWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("devin-instance-mismatch"),
          provider: ProviderDriverKind.make("devin"),
          providerInstanceId: ProviderInstanceId.make("different-devin"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ProviderAdapterValidationError);
      assert.equal(error.operation, "startSession");
    }),
  );

  it.effect("handles xAI ask_user_question extension requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("devin-xai-ask-user-question");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDevinWrapper({ T3_ACP_EMIT_XAI_ASK_USER_QUESTION: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.threadId !== threadId) return Effect.void;
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("devin"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);
      const requestedEvent = yield* Deferred.await(requested);

      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.equal(requestedEvent.raw?.source, "acp.devin.extension");
      assert.equal(requestedEvent.raw?.method, "_x.ai/ask_user_question");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        { "Which scope should Grok use?": "Workspace" },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        "Which scope should Grok use?": "Workspace",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
