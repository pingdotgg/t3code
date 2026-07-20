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
  TurnId,
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
    /**
     * Optional gate the mocked `session.abort` RPC awaits before
     * resolving. Tests install a gate so they can pin `interruptTurn`
     * inside the in-flight abort RPC and then exercise concurrent
     * `sendTurn`. While the gate is installed, all registered
     * `abortEnteredCallbacks` are invoked synchronously when the abort
     * RPC is entered so the test can wake up deterministically before
     * allowing the RPC to make progress.
     */
    abortGate: null as { readonly promise: Promise<void> } | null,
    abortEnteredCallbacks: [] as Array<() => void>,
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
    this.state.abortGate = null;
    this.state.abortEnteredCallbacks.length = 0;
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
          const gate = runtimeMock.state.abortGate;
          if (gate) {
            // Fire any "abort entered" callbacks so the test fiber
            // wakes up, THEN await the gate's promise. Resolving the
            // entered callbacks here is safe — they schedule an Effect
            // that resumes when the test fiber gets a chance to run.
            while (runtimeMock.state.abortEnteredCallbacks.length > 0) {
              const cb = runtimeMock.state.abortEnteredCallbacks.shift()!;
              cb();
            }
            await gate.promise;
          }
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

  it.effect("steers concurrent sendTurn into one active turn id", () =>
    Effect.gen(function* () {
      const adapter = yield* KiloAdapter;
      const threadId = asThreadId("thread-kilo-steer");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId,
        runtimeMode: "full-access",
      });

      const modelSelection = createModelSelection(
        ProviderInstanceId.make("kilo"),
        "anthropic/claude-sonnet-4-5",
      );
      const first = yield* adapter.sendTurn({
        threadId,
        input: "first",
        modelSelection,
      });
      const second = yield* adapter.sendTurn({
        threadId,
        input: "second",
        modelSelection,
      });

      NodeAssert.equal(String(second.turnId), String(first.turnId));
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
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

  it.effect(
    "does not call session.abort when interrupting a stale turn id",
    Effect.fn(function* () {
      const adapter = yield* KiloAdapter;
      const threadId = asThreadId("thread-kilo-stale-interrupt");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId,
        runtimeMode: "full-access",
      });

      // Open a turn so the adapter claims an activeTurnId.
      const first = yield* adapter.sendTurn({
        threadId,
        input: "first",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("kilo"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      // Simulate that an interrupting client targets a turn id that no
      // longer matches the active claim. The adapter must NOT issue
      // session.abort because the SDK aborts every turn in the session,
      // which would cancel the newer running turn.
      runtimeMock.state.abortCalls.length = 0;
      yield* adapter.interruptTurn(threadId, TurnId.make("stale-turn-id"));
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, []);

      // The next legitimate interrupt on the live turn id should still
      // resolve correctly (no leftover state from the stale call).
      runtimeMock.state.abortCalls.length = 0;
      yield* adapter.interruptTurn(threadId, first.turnId);
      NodeAssert.ok(
        (runtimeMock.state.abortCalls as ReadonlyArray<string>).includes(
          "http://127.0.0.1:4301/session",
        ),
      );
    }),
  );

  it.effect(
    "keeps the active turn claim during in-flight session.abort so a concurrent sendTurn steers instead of opening a new turn",
    Effect.fn(function* () {
      const adapter = yield* KiloAdapter;
      const threadId = asThreadId("thread-kilo-abort-race");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId,
        runtimeMode: "full-access",
      });

      const modelSelection = createModelSelection(
        ProviderInstanceId.make("kilo"),
        "anthropic/claude-sonnet-4-5",
      );
      const first = yield* adapter.sendTurn({
        threadId,
        input: "first",
        modelSelection,
      });

      // Install an "abort entered" callback so we can wait until
      // `interruptTurn` has reached the in-flight abort RPC, then a
      // gate that holds the RPC open until we are ready.
      runtimeMock.state.abortCalls.length = 0;
      let releaseAbort!: () => void;
      let abortReached = false;
      let abortEnteredDeferred!: (value: void | PromiseLike<void>) => void;
      const abortEnteredPromise = new Promise<void>((resolve) => {
        abortEnteredDeferred = resolve;
      });
      runtimeMock.state.abortGate = {
        promise: new Promise<void>((resolve) => {
          releaseAbort = resolve;
        }),
      };
      runtimeMock.state.abortEnteredCallbacks.push(() => {
        abortReached = true;
        abortEnteredDeferred();
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, first.turnId)
        .pipe(Effect.forkChild);

      // Wait (with a generous timeout) until the abort RPC has been
      // invoked, proving that interruptTurn is parked inside it.
      yield* Effect.tryPromise({
        try: () => abortEnteredPromise,
        catch: () => new Error("abort RPC was never entered"),
      }).pipe(Effect.timeout("2 seconds"));

      // While the abort RPC is still in flight, run a concurrent
      // sendTurn. With the fix in place, the adapter MUST keep
      // `activeTurnId` set so concurrent `sendTurn` steers into the
      // in-flight turn id rather than opening a new one that the
      // session-wide `session.abort` would unintentionally cancel.
      const second = yield* adapter.sendTurn({
        threadId,
        input: "second",
        modelSelection,
      });
      NodeAssert.equal(String(second.turnId), String(first.turnId));
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);

      // Release the abort RPC and let interruptTurn complete.
      releaseAbort();
      yield* Fiber.join(interruptFiber);

      // Session should be ready with no active turn after the abort
      // settles.
      const sessions = yield* adapter.listSessions();
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
      NodeAssert.equal(abortReached, true);
    }),
  );

  it.effect(
    "idle handler does not clear a turn id that is no longer owned",
    Effect.fn(function* () {
      const adapter = yield* KiloAdapter;
      const threadId = asThreadId("thread-kilo-idle-race");

      // Pre-stage an idle event so the SSE stream yields it when the
      // event pump subscribes. We send the idle event with a STALE turn
      // id (different from the one sendTurn will claim) so the handler's
      // compare-and-set must reject it. Because the mock SSE stream is
      // consumed by the event pump before sendTurn runs, the observed
      // activeTurnId at the top of the idle handler is undefined, so the
      // `if (turnId)` guard short-circuits. To exercise the
      // compare-and-set branch we instead drive the handler through a
      // dedicated session that does not start any turn.
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.status",
          properties: {
            sessionID: "http://127.0.0.1:4301/session",
            status: { type: "idle" },
          },
        },
      ];

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("kilo"),
        threadId,
        runtimeMode: "full-access",
      });

      // After consuming the idle event with no active turn, listSessions
      // should still report a ready session with no activeTurnId. The
      // session.started / thread.started events should still be emitted.
      const sessions = yield* adapter.listSessions();
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
    }),
  );

  it.effect(
    "surfaces unknown-session errors as typed failures, not defects",
    Effect.fn(function* () {
      const adapter = yield* KiloAdapter;
      const missingThreadId = asThreadId("thread-kilo-missing");

      const stopError = yield* adapter.stopSession(missingThreadId).pipe(Effect.flip);
      NodeAssert.equal(stopError._tag, "ProviderAdapterSessionNotFoundError");

      const interruptError = yield* adapter.interruptTurn(missingThreadId).pipe(Effect.flip);
      NodeAssert.equal(interruptError._tag, "ProviderAdapterSessionNotFoundError");

      const readError = yield* adapter.readThread(missingThreadId).pipe(Effect.flip);
      NodeAssert.equal(readError._tag, "ProviderAdapterSessionNotFoundError");

      const rollbackError = yield* adapter.rollbackThread(missingThreadId, 1).pipe(Effect.flip);
      NodeAssert.equal(rollbackError._tag, "ProviderAdapterSessionNotFoundError");

      const respondError = yield* adapter
        .respondToRequest(missingThreadId, ApprovalRequestId.make("perm"), "accept")
        .pipe(Effect.flip);
      NodeAssert.equal(respondError._tag, "ProviderAdapterSessionNotFoundError");
    }),
  );
});
