import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeAcpAdapterLive } from "./AcpAdapterLive.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type TestAcpRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"];

const acpAdapterLiveTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-acp-adapter-live-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const noopHandler = (() => Effect.void) as unknown;
const unsupported = <A>() =>
  Effect.die(new Error("unsupported test ACP method")) as Effect.Effect<A>;

it.effect(
  "does not mark a turn interrupted when interruptTurn times out before taking the lock",
  () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("test-acp");
      const threadId = ThreadId.make("acp-interrupt-timeout-before-lock");
      const drainEntered = yield* Deferred.make<void>();
      const releaseDrain = yield* Deferred.make<void>();

      const acp = {
        handleRequestPermission: noopHandler as TestAcpRuntime["handleRequestPermission"],
        handleElicitation: noopHandler as TestAcpRuntime["handleElicitation"],
        handleReadTextFile: noopHandler as TestAcpRuntime["handleReadTextFile"],
        handleWriteTextFile: noopHandler as TestAcpRuntime["handleWriteTextFile"],
        handleCreateTerminal: noopHandler as TestAcpRuntime["handleCreateTerminal"],
        handleTerminalOutput: noopHandler as TestAcpRuntime["handleTerminalOutput"],
        handleTerminalWaitForExit: noopHandler as TestAcpRuntime["handleTerminalWaitForExit"],
        handleTerminalKill: noopHandler as TestAcpRuntime["handleTerminalKill"],
        handleTerminalRelease: noopHandler as TestAcpRuntime["handleTerminalRelease"],
        handleSessionUpdate: noopHandler as TestAcpRuntime["handleSessionUpdate"],
        handleElicitationComplete: noopHandler as TestAcpRuntime["handleElicitationComplete"],
        handleUnknownExtRequest: noopHandler as TestAcpRuntime["handleUnknownExtRequest"],
        handleUnknownExtNotification: noopHandler as TestAcpRuntime["handleUnknownExtNotification"],
        handleExtRequest: noopHandler as TestAcpRuntime["handleExtRequest"],
        handleExtNotification: noopHandler as TestAcpRuntime["handleExtNotification"],
        start: () =>
          Effect.succeed({
            sessionId: "test-acp-session",
            initializeResult: {
              protocolVersion: 1,
              agentCapabilities: { promptCapabilities: {} },
            } satisfies EffectAcpSchema.InitializeResponse,
            sessionSetupResult: {
              sessionId: "test-acp-session",
            } satisfies EffectAcpSchema.NewSessionResponse,
            modelConfigId: undefined,
          }),
        getEvents: () => Stream.empty,
        drainEvents: Effect.gen(function* () {
          yield* Deferred.succeed(drainEntered, undefined).pipe(Effect.ignore);
          yield* Deferred.await(releaseDrain);
        }),
        getModeState: Effect.sync(() => undefined),
        getConfigOptions: Effect.succeed([]),
        prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
        cancel: Effect.void,
        setMode: () => unsupported<EffectAcpSchema.SetSessionModeResponse>(),
        setConfigOption: () => unsupported<EffectAcpSchema.SetSessionConfigOptionResponse>(),
        setModel: () => unsupported<void>(),
        setSessionModel: () => unsupported<EffectAcpSchema.SetSessionModelResponse>(),
        request: () => unsupported<unknown>(),
        notify: () => unsupported<void>(),
      } satisfies TestAcpRuntime;

      const adapter = yield* makeAcpAdapterLive<never>({
        provider,
        providerLabel: "Test ACP",
        resumeSchemaVersion: 1,
        readyReason: "test-ready",
        respondToUserInputMethod: "session/elicitation",
        capabilities: { sessionModelSwitch: "unsupported" },
        completedStopReasonFromPromptResponse: (response) => response.stopReason,
        makeAcpRuntime: () => Effect.succeed(acp),
        registerAcpCallbacks: () => Effect.void,
        bindSessionModel: () =>
          Effect.succeed({ currentModelId: undefined, displayModel: undefined }),
        prepareTurnModel: () =>
          Effect.succeed({ currentModelId: undefined, displayModel: undefined }),
      });

      yield* adapter.startSession({
        threadId,
        provider,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "complete while interrupted cancellation is waiting",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(drainEntered).pipe(Effect.timeout("2 seconds"));
      const interruptedExit = yield* Effect.exit(
        adapter.interruptTurn(threadId).pipe(Effect.timeout("25 millis")),
      );
      assert.isTrue(Exit.isFailure(interruptedExit));

      yield* Deferred.succeed(releaseDrain, undefined);
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);

      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(acpAdapterLiveTestLayer), TestClock.withLive),
);
