import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { beforeEach } from "vite-plus/test";

import {
  ApprovalRequestId,
  KiloSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { KiloAdapterShape } from "../Services/KiloAdapter.ts";
import { KiloRuntime, KiloRuntimeError, type KiloRuntimeShape } from "../kiloRuntime.ts";
import { makeKiloAdapter } from "./KiloAdapter.ts";

class KiloAdapter extends Context.Service<KiloAdapter, KiloAdapterShape>()(
  "t3/provider/Layers/KiloAdapter.test/KiloAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateCalls: [] as Array<unknown>,
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    closeCalls: [] as string[],
    promptCalls: [] as Array<unknown>,
    permissionReplies: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    messages: [] as Array<unknown>,
    subscribedEvents: [] as unknown[],
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateCalls.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.closeCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.permissionReplies.length = 0;
    this.state.promptAsyncError = null;
    this.state.messages = [];
    this.state.subscribedEvents = [];
  },
};

const KiloRuntimeTestDouble: KiloRuntimeShape = {
  startKiloServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      return {
        url,
        password: "secret-password",
        exitCode: Effect.never,
      };
    }),
  connectToKiloServer: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      return {
        url,
        password: "secret-password",
        exitCode: null,
        external: false,
      };
    }),
  runKiloCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createKiloSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async (input: unknown) => {
          runtimeMock.state.sessionCreateCalls.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`kilo:${serverPassword}`)}` : null,
          );
          return { data: { id: `${baseUrl}/session` } };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        revert: async () => undefined,
      },
      permission: {
        reply: async (input: unknown) => {
          runtimeMock.state.permissionReplies.push(input);
        },
      },
      question: {
        reply: async () => undefined,
      },
      mcp: {
        add: async () => undefined,
      },
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            for (const event of runtimeMock.state.subscribedEvents) {
              yield event;
            }
            // Keep the subscription open so a clean stream end does not tear
            // the session down mid-test (production SSE is long-lived).
            await new Promise(() => {});
          })(),
        }),
      },
    }) as unknown as ReturnType<KiloRuntimeShape["createKiloSdkClient"]>,
  loadKiloInventory: () =>
    Effect.fail(
      new KiloRuntimeError({
        operation: "loadKiloInventory",
        detail: "KiloRuntimeTestDouble.loadKiloInventory not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const kiloAdapterTestSettings = Schema.decodeSync(KiloSettings)({
  binaryPath: "fake-kilo",
});

const KiloAdapterTestLayer = Layer.effect(
  KiloAdapter,
  makeKiloAdapter(kiloAdapterTestSettings),
).pipe(
  Layer.provideMerge(Layer.succeed(KiloRuntime, KiloRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

it.layer(KiloAdapterTestLayer)("KiloAdapter", (it) => {
  it.effect("starts a managed Kilo server session with agent code", () =>
    Effect.gen(function* () {
      const adapter = yield* KiloAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId: asThreadId("thread-kilo"),
        runtimeMode: "full-access",
      });

      NodeAssert.equal(session.provider, "kilo");
      NodeAssert.equal(session.threadId, "thread-kilo");
      NodeAssert.deepEqual(runtimeMock.state.startCalls, ["fake-kilo"]);
      NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("kilo:secret-password")}`,
      ]);
      const createCall = runtimeMock.state.sessionCreateCalls.at(-1) as {
        agent?: string;
      };
      NodeAssert.equal(createCall?.agent, "code");
    }),
  );

  it.effect("sends turns with model slug and default agent code", () =>
    Effect.gen(function* () {
      const adapter = yield* KiloAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId: asThreadId("thread-kilo-turn"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-kilo-turn"),
        input: "Hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("kilo"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:4301/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "code",
        parts: [{ type: "text", text: "Hello" }],
      });
    }),
  );

  it.effect("uses agent plan when interactionMode is plan", () =>
    Effect.gen(function* () {
      const adapter = yield* KiloAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId: asThreadId("thread-kilo-plan"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-kilo-plan"),
        input: "Plan this",
        interactionMode: "plan",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("kilo"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      const prompt = runtimeMock.state.promptCalls.at(-1) as { agent?: string };
      NodeAssert.equal(prompt?.agent, "plan");
    }),
  );

  it.effect("interrupts an active turn via session.abort", () =>
    Effect.gen(function* () {
      const adapter = yield* KiloAdapter;
      const threadId = asThreadId("thread-kilo-interrupt");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "long task",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("kilo"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.interruptTurn(threadId, turn.turnId);
      NodeAssert.ok(runtimeMock.state.abortCalls.includes("http://127.0.0.1:4301/session"));
      const sessions = yield* adapter.listSessions();
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
    }),
  );

  it.effect("maps permission decisions to once/always/reject", () =>
    Effect.gen(function* () {
      const adapter = yield* KiloAdapter;
      const threadId = asThreadId("thread-kilo-permission");
      const requestId = ApprovalRequestId.make("perm-1");

      runtimeMock.state.subscribedEvents = [
        {
          type: "permission.asked",
          properties: {
            id: requestId,
            sessionID: "http://127.0.0.1:4301/session",
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId,
        runtimeMode: "full-access",
      });

      yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second"));

      yield* adapter.respondToRequest(threadId, requestId, "accept");
      NodeAssert.deepEqual(runtimeMock.state.permissionReplies, [
        { requestID: requestId, reply: "once" },
      ]);

      yield* adapter.respondToRequest(threadId, requestId, "acceptForSession");
      NodeAssert.deepEqual(runtimeMock.state.permissionReplies.at(-1), {
        requestID: requestId,
        reply: "always",
      });

      yield* adapter.respondToRequest(threadId, requestId, "decline");
      NodeAssert.deepEqual(runtimeMock.state.permissionReplies.at(-1), {
        requestID: requestId,
        reply: "reject",
      });
    }),
  );

  it.effect("rolls back session state when sendTurn fails", () =>
    Effect.gen(function* () {
      const adapter = yield* KiloAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("kilo"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        NodeAssert.match(error.detail, /prompt failed/);
      }
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
    }),
  );
});
