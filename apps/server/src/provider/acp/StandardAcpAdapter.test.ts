import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { AcpRequestError } from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { type ChatAttachment, ProviderDriverKind, ThreadId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import { makeStandardAcpAdapter } from "./StandardAcpAdapter.ts";

const standardAcpAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-standard-acp-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeAcpRuntime(input: {
  readonly cancelCalled: Deferred.Deferred<void>;
  readonly cancel?: Effect.Effect<void, AcpRequestError>;
  readonly prompt?: () => Effect.Effect<EffectAcpSchema.PromptResponse, unknown>;
  readonly request?: (method: string, payload: unknown) => Effect.Effect<unknown, unknown>;
}): AcpSessionRuntimeShape {
  const ignoreHandler = () => Effect.void;
  return {
    handleRequestPermission: ignoreHandler,
    handleElicitation: ignoreHandler,
    handleReadTextFile: ignoreHandler,
    handleWriteTextFile: ignoreHandler,
    handleCreateTerminal: ignoreHandler,
    handleTerminalOutput: ignoreHandler,
    handleTerminalWaitForExit: ignoreHandler,
    handleTerminalKill: ignoreHandler,
    handleTerminalRelease: ignoreHandler,
    handleSessionUpdate: ignoreHandler,
    handleElicitationComplete: ignoreHandler,
    handleUnknownExtRequest: ignoreHandler,
    handleUnknownExtNotification: ignoreHandler,
    handleExtRequest: ignoreHandler,
    handleExtNotification: ignoreHandler,
    start: () =>
      Effect.succeed({
        sessionId: "fake-session",
        initializeResult: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
        } as EffectAcpSchema.InitializeResponse,
        sessionSetupResult: {
          sessionId: "fake-session",
        } as EffectAcpSchema.NewSessionResponse,
        modelConfigId: undefined,
      }),
    getEvents: () => Stream.empty,
    getModeState: Effect.sync(() => undefined),
    getConfigOptions: Effect.succeed([]),
    prompt: input.prompt ?? (() => Effect.succeed({ stopReason: "end_turn" })),
    cancel: input.cancel ?? Deferred.succeed(input.cancelCalled, undefined).pipe(Effect.asVoid),
    setMode: () => Effect.succeed({} as EffectAcpSchema.SetSessionModeResponse),
    setConfigOption: () => Effect.succeed({} as EffectAcpSchema.SetSessionConfigOptionResponse),
    setModel: () => Effect.void,
    request: input.request ?? (() => Effect.succeed({})),
    notify: () => Effect.void,
  } as unknown as AcpSessionRuntimeShape;
}

it.effect("keeps interrupted ACP turns active until session/prompt resolves", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-cancel-awaits-prompt");
    const promptStarted = yield* Deferred.make<void>();
    const promptResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: () =>
        Deferred.succeed(promptStarted, undefined).pipe(
          Effect.andThen(Deferred.await(promptResponse)),
        ),
    });

    const adapter = yield* makeStandardAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      makeRuntime: () => Effect.succeed(runtime),
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
        input: "cancel after provider prompt resolves",
        attachments: [],
      })
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.isUndefined(sendTurnFiber.pollUnsafe());
    yield* Deferred.await(promptStarted).pipe(Effect.timeout("1 second"));
    yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("1 second"));
    yield* Deferred.await(cancelCalled).pipe(Effect.timeout("1 second"));
    yield* Effect.yieldNow;

    const earlySendTurnExit = sendTurnFiber.pollUnsafe();
    assert.isUndefined(earlySendTurnExit);

    yield* Deferred.succeed(promptResponse, { stopReason: "cancelled" });
    const result = yield* Fiber.join(sendTurnFiber);

    assert.equal(result.threadId, threadId);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("forwards session/cancel when no local active prompt is registered", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-cancel-without-local-prompt");
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({ cancelCalled });

    const adapter = yield* makeStandardAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("1 second"));
    yield* Deferred.await(cancelCalled).pipe(Effect.timeout("1 second"));
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("stops the ACP session on interrupt when cancel is unsupported and opted in", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const threadId = ThreadId.make("standard-acp-cancel-unsupported-stops-session");
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      cancel: Deferred.succeed(cancelCalled, undefined).pipe(
        Effect.andThen(Effect.fail(AcpRequestError.methodNotFound("session/cancel"))),
      ),
    });

    const adapter = yield* makeStandardAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      stopSessionOnInterruptCancelUnsupported: true,
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("1 second"));
    yield* Deferred.await(cancelCalled).pipe(Effect.timeout("1 second"));

    assert.isFalse(yield* adapter.hasSession(threadId));
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("stops the ACP session on interrupt after a successful cancel write when opted in", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("kiro");
    const threadId = ThreadId.make("standard-acp-cancel-write-stops-session");
    const cancelCalled = yield* Deferred.make<void>();
    const runtime = makeFakeAcpRuntime({ cancelCalled });

    const adapter = yield* makeStandardAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      stopSessionOnInterruptCancelUnsupported: true,
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("1 second"));
    yield* Deferred.await(cancelCalled).pipe(Effect.timeout("1 second"));

    assert.isFalse(yield* adapter.hasSession(threadId));
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("routes text sent during an active ACP prompt through the active prompt hook", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-active-prompt-steering");
    const promptStarted = yield* Deferred.make<void>();
    const promptResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const cancelCalled = yield* Deferred.make<void>();
    let promptCallCount = 0;
    const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: () =>
        Effect.sync(() => {
          promptCallCount += 1;
        }).pipe(
          Effect.andThen(Deferred.succeed(promptStarted, undefined)),
          Effect.andThen(Deferred.await(promptResponse)),
        ),
      request: (method, payload) =>
        Effect.sync(() => {
          requests.push({ method, payload });
          return {};
        }),
    });

    const adapter = yield* makeStandardAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      activePromptMessageMethod: "_message/send",
      sendMessageWhilePromptActive: ({ runtime, sessionId, content }) =>
        runtime.request("_message/send", { sessionId, content }),
      makeRuntime: () => Effect.succeed(runtime),
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
        input: "start a long prompt",
        attachments: [],
      })
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.isUndefined(sendTurnFiber.pollUnsafe());
    yield* Deferred.await(promptStarted).pipe(Effect.timeout("1 second"));
    assert.equal(promptCallCount, 1);

    const steeringResult = yield* adapter
      .sendTurn({
        threadId,
        input: "steer the active prompt",
        attachments: [],
      })
      .pipe(Effect.timeout("1 second"));

    assert.equal(promptCallCount, 1);
    assert.deepEqual(requests, [
      {
        method: "_message/send",
        payload: { sessionId: "fake-session", content: "steer the active prompt" },
      },
    ]);

    yield* Deferred.succeed(promptResponse, { stopReason: "end_turn" });
    const firstResult = yield* Fiber.join(sendTurnFiber);

    assert.equal(steeringResult.turnId, firstResult.turnId);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect(
  "routes attachments sent during an active ACP prompt through the active prompt hook",
  () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("cursor");
      const threadId = ThreadId.make("standard-acp-active-prompt-attachment-steering");
      const promptStarted = yield* Deferred.make<void>();
      const promptResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
      const cancelCalled = yield* Deferred.make<void>();
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const imageBytes = Buffer.from("fake image bytes");
      const attachment: ChatAttachment = {
        type: "image",
        id: "active-prompt-image",
        name: "active-prompt-image.png",
        mimeType: "image/png",
        sizeBytes: imageBytes.byteLength,
      };
      yield* fileSystem.writeFile(
        path.join(serverConfig.attachmentsDir, `${attachment.id}.png`),
        imageBytes,
      );

      let promptCallCount = 0;
      const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
      const runtime = makeFakeAcpRuntime({
        cancelCalled,
        prompt: () =>
          Effect.sync(() => {
            promptCallCount += 1;
          }).pipe(
            Effect.andThen(Deferred.succeed(promptStarted, undefined)),
            Effect.andThen(Deferred.await(promptResponse)),
          ),
        request: (method, payload) =>
          Effect.sync(() => {
            requests.push({ method, payload });
            return {};
          }),
      });

      const adapter = yield* makeStandardAcpAdapter({
        provider,
        runtimeLabel: "Fake ACP",
        activePromptMessageMethod: "_message/send",
        sendMessageWhilePromptActive: ({ runtime, sessionId, content, contentBlocks }) =>
          runtime.request("_message/send", {
            sessionId,
            content:
              contentBlocks.length === 1 && contentBlocks[0]?.type === "text"
                ? content
                : contentBlocks,
          }),
        makeRuntime: () => Effect.succeed(runtime),
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
          input: "start a long prompt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.isUndefined(sendTurnFiber.pollUnsafe());
      yield* Deferred.await(promptStarted).pipe(Effect.timeout("1 second"));

      const steeringResult = yield* adapter
        .sendTurn({
          threadId,
          input: "inspect this",
          attachments: [attachment],
        })
        .pipe(Effect.timeout("1 second"));

      assert.equal(promptCallCount, 1);
      assert.deepEqual(requests, [
        {
          method: "_message/send",
          payload: {
            sessionId: "fake-session",
            content: [
              { type: "text", text: "inspect this" },
              {
                type: "image",
                data: imageBytes.toString("base64"),
                mimeType: "image/png",
              },
            ],
          },
        },
      ]);

      yield* Deferred.succeed(promptResponse, { stopReason: "end_turn" });
      const firstResult = yield* Fiber.join(sendTurnFiber);

      assert.equal(steeringResult.turnId, firstResult.turnId);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("starts a fresh ACP prompt after the previous prompt completes", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-new-prompt-after-completion");
    const cancelCalled = yield* Deferred.make<void>();
    let promptCallCount = 0;
    const requests: Array<{ readonly method: string; readonly payload: unknown }> = [];
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: () =>
        Effect.sync(() => {
          promptCallCount += 1;
          return { stopReason: "end_turn" as const };
        }),
      request: (method, payload) =>
        Effect.sync(() => {
          requests.push({ method, payload });
          return {};
        }),
    });

    const adapter = yield* makeStandardAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      activePromptMessageMethod: "_message/send",
      sendMessageWhilePromptActive: ({ runtime, sessionId, content }) =>
        runtime.request("_message/send", { sessionId, content }),
      makeRuntime: () => Effect.succeed(runtime),
    });

    yield* adapter.startSession({
      threadId,
      provider,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.sendTurn({
      threadId,
      input: "first prompt",
      attachments: [],
    });
    const sessionsAfterFirst = yield* adapter.listSessions();
    assert.isUndefined(sessionsAfterFirst[0]?.activeTurnId);
    yield* adapter.sendTurn({
      threadId,
      input: "second prompt",
      attachments: [],
    });

    assert.equal(promptCallCount, 2);
    assert.deepEqual(requests, []);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);

it.effect("restores the previous active ACP turn after an overlapping prompt fails", () =>
  Effect.gen(function* () {
    const provider = ProviderDriverKind.make("cursor");
    const threadId = ThreadId.make("standard-acp-overlap-failure-restores-active-turn");
    const promptStarted = yield* Deferred.make<void>();
    const promptResponse = yield* Deferred.make<EffectAcpSchema.PromptResponse>();
    const cancelCalled = yield* Deferred.make<void>();
    let promptCallCount = 0;
    const runtime = makeFakeAcpRuntime({
      cancelCalled,
      prompt: () =>
        Effect.sync(() => {
          promptCallCount += 1;
          return promptCallCount;
        }).pipe(
          Effect.flatMap((callCount) =>
            callCount === 1
              ? Deferred.succeed(promptStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(promptResponse)),
                )
              : Effect.fail(
                  AcpRequestError.internalError("Internal error", "Prompt already in progress"),
                ),
          ),
        ),
    });

    const adapter = yield* makeStandardAcpAdapter({
      provider,
      runtimeLabel: "Fake ACP",
      makeRuntime: () => Effect.succeed(runtime),
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
        input: "start a long prompt",
        attachments: [],
      })
      .pipe(Effect.forkChild);

    yield* Deferred.await(promptStarted).pipe(Effect.timeout("1 second"));
    const sessionsWhileFirstPromptRuns = yield* adapter.listSessions();
    const firstActiveTurnId = sessionsWhileFirstPromptRuns[0]?.activeTurnId;
    assert.isDefined(firstActiveTurnId);

    const secondExit = yield* adapter
      .sendTurn({
        threadId,
        input: "overlapping prompt",
        attachments: [],
      })
      .pipe(Effect.exit, Effect.timeout("1 second"));

    assert.isTrue(Exit.isFailure(secondExit));
    const sessionsAfterOverlapFailure = yield* adapter.listSessions();
    assert.equal(sessionsAfterOverlapFailure[0]?.activeTurnId, firstActiveTurnId);

    yield* Deferred.succeed(promptResponse, { stopReason: "end_turn" });
    yield* Fiber.join(sendTurnFiber);
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped, Effect.provide(standardAcpAdapterTestLayer)),
);
