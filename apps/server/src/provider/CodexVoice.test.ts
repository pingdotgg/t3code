import * as NodeAssert from "node:assert/strict";

import type { ProviderVoiceSessionEvent } from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  CodexVoiceSessionError,
  makeCodexVoice,
  readRealtimeDelegationInput,
  readSpeakableAnswer,
} from "./CodexVoice.ts";

const isCodexVoiceSessionError = Schema.is(CodexVoiceSessionError);

const PROVIDER_THREAD = "provider-thread-1";

function delegation(input: string) {
  return `<realtime_delegation>\n  <input>${input}</input>\n</realtime_delegation>`;
}

const makeFakeClient = Effect.gen(function* () {
  const handlers = new Map<string, Array<(payload: unknown) => Effect.Effect<void, Error>>>();
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  let closeOnStop = false;
  let onStart: Effect.Effect<void, CodexErrors.CodexAppServerError> = Effect.void;
  let onStop: Effect.Effect<void, CodexErrors.CodexAppServerError> = Effect.void;
  const startRequested = yield* Deferred.make<void>();
  const secondStartRequested = yield* Deferred.make<void>();
  const thirdStartRequested = yield* Deferred.make<void>();
  const speechRequested = yield* Deferred.make<void>();
  const stopRequested = yield* Deferred.make<void>();
  const client = {
    handleServerNotification: (
      method: string,
      handler: (payload: unknown) => Effect.Effect<void, Error>,
    ) =>
      Effect.sync(() => {
        handlers.set(method, [...(handlers.get(method) ?? []), handler]);
      }),
    raw: {
      request: (method: string, params: unknown) =>
        Effect.gen(function* () {
          requests.push({ method, params });
          if (method === "thread/realtime/start") {
            yield* Deferred.succeed(startRequested, undefined);
            if (requests.filter((request) => request.method === method).length === 2)
              yield* Deferred.succeed(secondStartRequested, undefined);
            if (requests.filter((request) => request.method === method).length === 3)
              yield* Deferred.succeed(thirdStartRequested, undefined);
            yield* onStart;
          }
          if (method === "thread/realtime/appendSpeech") {
            yield* Deferred.succeed(speechRequested, undefined);
          }
          if (method === "thread/realtime/stop") {
            yield* Deferred.succeed(stopRequested, undefined);
            yield* onStop;
            if (closeOnStop)
              yield* emit("thread/realtime/closed", {
                threadId: PROVIDER_THREAD,
                reason: "old-session-closed",
              });
          }
          return {};
        }),
    },
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  const emit = (method: string, payload: unknown) =>
    Effect.forEach(handlers.get(method) ?? [], (handler) => Effect.ignore(handler(payload)), {
      discard: true,
    });
  return {
    client,
    requests,
    emit,
    startRequested,
    secondStartRequested,
    thirdStartRequested,
    speechRequested,
    setStart: (effect: typeof onStart) => {
      onStart = effect;
    },
    setStop: (effect: typeof onStop) => {
      onStop = effect;
    },
    stopRequested,
    closePreviousOnStop: () => {
      closeOnStop = true;
    },
  };
});

const startVoice = Effect.gen(function* () {
  const fake = yield* makeFakeClient;
  const scope = yield* Scope.make();
  const voice = yield* makeCodexVoice(fake.client, scope);
  const fiber = yield* voice
    .start({ providerThreadId: PROVIDER_THREAD, offerSdp: "v=offer\r\n", voice: "cove" })
    .pipe(Stream.runCollect, Effect.forkChild);
  yield* Deferred.await(fake.startRequested);
  return { ...fake, fiber };
});

describe("readRealtimeDelegationInput", () => {
  it("unwraps and unescapes the spoken request", () => {
    NodeAssert.equal(
      readRealtimeDelegationInput(delegation("run the tests &amp; fix &lt;Foo&gt;")),
      "run the tests & fix <Foo>",
    );
  });

  it("ignores ordinary user messages", () => {
    NodeAssert.equal(readRealtimeDelegationInput("please fix the build"), undefined);
  });
});

describe("readSpeakableAnswer", () => {
  it("speaks final answers without the channel marker", () => {
    NodeAssert.equal(
      readSpeakableAnswer({ type: "agentMessage", text: "[FINAL] All green.", phase: null }),
      "All green.",
    );
  });

  it("keeps commentary private", () => {
    NodeAssert.equal(
      readSpeakableAnswer({ type: "agentMessage", text: "Looking…", phase: "commentary" }),
      undefined,
    );
    NodeAssert.equal(
      readSpeakableAnswer({ type: "agentMessage", text: "[COMMENTARY] Looking…", phase: null }),
      undefined,
    );
  });

  it("leaves oversized answers on screen only", () => {
    NodeAssert.equal(
      readSpeakableAnswer({ type: "agentMessage", text: "x".repeat(5000), phase: "final_answer" }),
      undefined,
    );
  });
});

describe("makeCodexVoice", () => {
  it.effect("starts a WebRTC realtime session and relays signaling until Codex closes it", () =>
    Effect.gen(function* () {
      const voice = yield* startVoice;
      NodeAssert.deepEqual(voice.requests[0], {
        method: "thread/realtime/start",
        params: {
          threadId: PROVIDER_THREAD,
          outputModality: "audio",
          transport: { type: "webrtc", sdp: "v=offer\r\n" },
          version: "v3",
          clientManagedHandoffs: true,
          includeStartupContext: false,
          voice: "cove",
        },
      });

      yield* voice.emit("thread/realtime/started", { threadId: PROVIDER_THREAD, version: "v3" });
      yield* voice.emit("thread/realtime/sdp", { threadId: PROVIDER_THREAD, sdp: "v=answer\r\n" });
      yield* voice.emit("thread/realtime/transcript/delta", {
        threadId: "another-thread",
        role: "user",
        delta: "ignored",
      });
      yield* voice.emit("thread/realtime/transcript/delta", {
        threadId: PROVIDER_THREAD,
        role: "user",
        delta: "hello",
      });
      yield* voice.emit("thread/realtime/transcript/done", {
        threadId: PROVIDER_THREAD,
        role: "assistant",
        text: "Hi there",
      });
      yield* voice.emit("thread/realtime/closed", {
        threadId: PROVIDER_THREAD,
        reason: "transport_closed",
      });

      const events = yield* Fiber.join(voice.fiber);
      NodeAssert.deepEqual(events, [
        { type: "started" },
        { type: "answer", sdp: "v=answer\r\n" },
        { type: "transcript.delta", role: "user", delta: "hello" },
        { type: "transcript.done", role: "assistant", text: "Hi there" },
        { type: "closed", reason: "transport_closed" },
      ] satisfies ReadonlyArray<ProviderVoiceSessionEvent>);
      // Codex already closed the session, so there is nothing to stop.
      NodeAssert.ok(!voice.requests.some((request) => request.method === "thread/realtime/stop"));
    }),
  );

  it.effect(
    "keeps the replacement stream alive when stopping the previous session emits closed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeClient;
          const voice = yield* makeCodexVoice(fake.client, yield* Effect.scope);
          const start = () =>
            voice
              .start({ providerThreadId: PROVIDER_THREAD, offerSdp: "v=offer\r\n" })
              .pipe(Stream.runCollect, Effect.forkChild);
          const first = yield* start();
          yield* Deferred.await(fake.startRequested);
          fake.closePreviousOnStop();
          const replacement = yield* start();
          yield* Deferred.await(fake.secondStartRequested);
          yield* fake.emit("thread/realtime/sdp", {
            threadId: PROVIDER_THREAD,
            sdp: "replacement-answer",
          });
          yield* fake.emit("thread/realtime/closed", {
            threadId: PROVIDER_THREAD,
            reason: "replacement-done",
          });
          NodeAssert.deepEqual(yield* Fiber.join(first), [{ type: "closed", reason: "replaced" }]);
          NodeAssert.deepEqual(yield* Fiber.join(replacement), [
            { type: "answer", sdp: "replacement-answer" },
            { type: "closed", reason: "replacement-done" },
          ]);
          // The predecessor is stopped once, before the successor starts, and
          // its finalizer must not stop the successor's session.
          NodeAssert.deepEqual(
            fake.requests
              .map((request) => request.method)
              .filter((method) => method.startsWith("thread/realtime/")),
            ["thread/realtime/start", "thread/realtime/stop", "thread/realtime/start"],
          );
        }),
      ),
  );

  it.effect("serializes concurrent replacements before routing the successor's SDP", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeClient;
        const voice = yield* makeCodexVoice(fake.client, yield* Effect.scope);
        const owners: Array<string> = [];
        const start = (owner: string) =>
          voice
            .start(
              { providerThreadId: PROVIDER_THREAD, offerSdp: "offer" },
              Effect.sync(() => {
                owners.push(owner);
              }),
            )
            .pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
        const first = yield* start("first");
        yield* Deferred.await(fake.startRequested);
        const releaseStop = yield* Deferred.make<void>();
        fake.setStop(Deferred.await(releaseStop));
        const second = yield* start("second");
        yield* Deferred.await(fake.stopRequested);
        const third = yield* start("third");
        const cancelled = yield* start("cancelled");
        const cancellation = yield* Fiber.interrupt(cancelled).pipe(Effect.forkChild);
        const whileStopping = fake.requests.map(({ method }) => method);
        yield* Deferred.succeed(releaseStop, undefined);
        NodeAssert.deepEqual(whileStopping, ["thread/realtime/start", "thread/realtime/stop"]);
        yield* Deferred.await(fake.thirdStartRequested);
        yield* Fiber.join(cancellation);
        NodeAssert.deepEqual(owners, ["first", "second", "third"]);
        yield* fake.emit("thread/realtime/sdp", { threadId: PROVIDER_THREAD, sdp: "third-answer" });
        yield* fake.emit("thread/realtime/closed", { threadId: PROVIDER_THREAD });
        NodeAssert.deepEqual(yield* Fiber.join(first), [{ type: "closed", reason: "replaced" }]);
        NodeAssert.deepEqual(yield* Fiber.join(second), [{ type: "closed", reason: "replaced" }]);
        NodeAssert.deepEqual(yield* Fiber.join(third), [
          { type: "answer", sdp: "third-answer" },
          { type: "closed" },
        ]);
        NodeAssert.deepEqual(
          fake.requests.map(({ method }) => method),
          [
            "thread/realtime/start",
            "thread/realtime/stop",
            "thread/realtime/start",
            "thread/realtime/stop",
            "thread/realtime/start",
          ],
        );
      }),
    ),
  );

  it.effect("waits for unsubscribe cleanup before starting another native thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeClient;
        const voice = yield* makeCodexVoice(fake.client, yield* Effect.scope);
        const first = yield* voice
          .start({ providerThreadId: PROVIDER_THREAD, offerSdp: "offer" })
          .pipe(Stream.runCollect, Effect.forkChild);
        yield* Deferred.await(fake.startRequested);
        const releaseStop = yield* Deferred.make<void>();
        fake.setStop(Deferred.await(releaseStop));
        const cleanup = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
        yield* Deferred.await(fake.stopRequested);
        const replacement = yield* voice
          .start({ providerThreadId: "another-thread", offerSdp: "offer" })
          .pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
        const whileStopping = fake.requests.map(({ method }) => method);
        yield* Deferred.succeed(releaseStop, undefined);
        NodeAssert.deepEqual(whileStopping, ["thread/realtime/start", "thread/realtime/stop"]);
        yield* Fiber.join(cleanup);
        yield* Deferred.await(fake.secondStartRequested);
        yield* fake.emit("thread/realtime/sdp", { threadId: PROVIDER_THREAD, sdp: "ignored" });
        yield* fake.emit("thread/realtime/sdp", { threadId: "another-thread", sdp: "answer" });
        yield* fake.emit("thread/realtime/closed", { threadId: "another-thread" });
        NodeAssert.deepEqual(yield* Fiber.join(replacement), [
          { type: "answer", sdp: "answer" },
          { type: "closed" },
        ]);
      }),
    ),
  );

  it.effect.each(["stop response", "closed notification"] as const)(
    "retains failed cleanup until a %s confirms termination",
    (confirmation) => {
      const messages: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const fake = yield* makeFakeClient;
          const voice = yield* makeCodexVoice(fake.client, yield* Effect.scope);
          const start = () =>
            voice
              .start({ providerThreadId: PROVIDER_THREAD, offerSdp: "offer" })
              .pipe(Stream.runCollect, Effect.forkChild);
          const first = yield* start();
          yield* Deferred.await(fake.startRequested);
          const stopFailure = new CodexErrors.CodexAppServerRequestError({
            code: -32603,
            errorMessage: "stop failed",
            method: "thread/realtime/stop",
          });
          fake.setStop(Effect.fail(stopFailure));
          fake.setStart(
            Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "unexpected start",
              }),
            ),
          );
          yield* Fiber.interrupt(first);
          const replacementExit = yield* voice
            .start({ providerThreadId: PROVIDER_THREAD, offerSdp: "offer" })
            .pipe(Stream.runCollect, Effect.exit);
          NodeAssert.ok(Exit.isFailure(replacementExit));
          NodeAssert.deepEqual(
            fake.requests.map(({ method }) => method),
            ["thread/realtime/start", "thread/realtime/stop", "thread/realtime/stop"],
          );
          NodeAssert.ok(
            messages.flat().includes("Codex voice could not stop the realtime session"),
          );
          fake.setStop(Effect.void);
          fake.setStart(Effect.void);
          if (confirmation === "closed notification")
            yield* fake.emit("thread/realtime/closed", { threadId: PROVIDER_THREAD });
          const recovered = yield* start();
          yield* Deferred.await(fake.secondStartRequested);
          yield* fake.emit("thread/realtime/closed", { threadId: PROVIDER_THREAD });
          yield* Fiber.join(recovered);
          NodeAssert.deepEqual(
            fake.requests.map(({ method }) => method),
            [
              "thread/realtime/start",
              "thread/realtime/stop",
              "thread/realtime/stop",
              ...(confirmation === "stop response" ? ["thread/realtime/stop"] : []),
              "thread/realtime/start",
            ],
          );
        }),
      ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    },
  );

  it.effect("retries predecessor cleanup after an interrupted replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* makeFakeClient;
        const voice = yield* makeCodexVoice(fake.client, yield* Effect.scope);
        const start = () =>
          voice
            .start({ providerThreadId: PROVIDER_THREAD, offerSdp: "offer" })
            .pipe(Stream.runCollect, Effect.forkChild({ startImmediately: true }));
        const first = yield* start();
        yield* Deferred.await(fake.startRequested);
        const stopInterrupted = yield* Deferred.make<void>();
        const releaseStop = yield* Deferred.make<void>();
        fake.setStop(
          Deferred.await(releaseStop).pipe(
            Effect.onInterrupt(() => Deferred.succeed(stopInterrupted, undefined)),
          ),
        );
        const replacement = yield* start();
        yield* Deferred.await(fake.stopRequested);
        const interrupted = yield* Fiber.interrupt(replacement).pipe(Effect.forkChild);
        yield* Deferred.await(stopInterrupted);
        fake.setStop(Effect.void);
        yield* Deferred.succeed(releaseStop, undefined);
        yield* Fiber.join(interrupted);
        yield* Fiber.join(first);
        NodeAssert.deepEqual(
          fake.requests.map(({ method }) => method),
          ["thread/realtime/start", "thread/realtime/stop", "thread/realtime/stop"],
        );
        const recovered = yield* start();
        yield* Deferred.await(fake.secondStartRequested);
        yield* fake.emit("thread/realtime/closed", { threadId: PROVIDER_THREAD });
        yield* Fiber.join(recovered);
      }),
    ),
  );

  it.effect("stops the realtime session when the client unsubscribes", () =>
    Effect.gen(function* () {
      const voice = yield* startVoice;
      yield* Fiber.interrupt(voice.fiber);
      yield* Deferred.await(voice.stopRequested);
      NodeAssert.deepEqual(voice.requests.at(-1), {
        method: "thread/realtime/stop",
        params: { threadId: PROVIDER_THREAD },
      });
    }),
  );

  it.effect("fails the stream with Codex's realtime error", () =>
    Effect.gen(function* () {
      const voice = yield* startVoice;
      yield* voice.emit("thread/realtime/error", {
        threadId: PROVIDER_THREAD,
        message: "realtime unavailable",
      });
      const exit = yield* Fiber.await(voice.fiber);
      NodeAssert.ok(Exit.isFailure(exit));
      const error = exit.cause.reasons[0];
      NodeAssert.ok(error?._tag === "Fail" && isCodexVoiceSessionError(error.error));
      NodeAssert.equal(error.error.detail, "realtime unavailable");
    }),
  );

  it.effect("speaks the answer of a handoff the host resubmitted as its own turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeClient;
      const scope = yield* Scope.make();
      const voice = yield* makeCodexVoice(fake.client, scope);
      const fiber = yield* voice
        .start({ providerThreadId: PROVIDER_THREAD, offerSdp: "v=offer\r\n" })
        .pipe(Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(fake.startRequested);

      yield* voice.expectSpokenTurn("run the tests");
      yield* fake.emit("item/started", {
        threadId: PROVIDER_THREAD,
        turnId: "resubmitted",
        item: {
          type: "userMessage",
          id: "user-resubmitted",
          content: [{ type: "text", text: "<context/>\nrun the tests" }],
        },
      });
      yield* fake.emit("item/completed", {
        threadId: PROVIDER_THREAD,
        turnId: "resubmitted",
        item: { type: "agentMessage", id: "answer", text: "All green.", phase: "final_answer" },
      });
      yield* fake.emit("turn/completed", {
        threadId: PROVIDER_THREAD,
        turn: { id: "resubmitted", status: "completed" },
      });

      yield* Deferred.await(fake.speechRequested);
      NodeAssert.deepEqual(fake.requests.at(-1), {
        method: "thread/realtime/appendSpeech",
        params: { threadId: PROVIDER_THREAD, text: "All green." },
      });
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("speaks the final answer of a voice-delegated turn, not typed turns", () =>
    Effect.gen(function* () {
      const voice = yield* startVoice;
      const userMessage = (turnId: string, text: string) =>
        voice.emit("item/started", {
          threadId: PROVIDER_THREAD,
          turnId,
          item: { type: "userMessage", id: `user-${turnId}`, content: [{ type: "text", text }] },
        });
      const agentMessage = (turnId: string, text: string, phase: string) =>
        voice.emit("item/completed", {
          threadId: PROVIDER_THREAD,
          turnId,
          item: { type: "agentMessage", id: `agent-${turnId}-${phase}`, text, phase },
        });
      const complete = (turnId: string) =>
        voice.emit("turn/completed", {
          threadId: PROVIDER_THREAD,
          turn: { id: turnId, status: "completed" },
        });

      yield* userMessage("typed", "fix the build");
      yield* agentMessage("typed", "Fixed it.", "final_answer");
      yield* complete("typed");

      yield* userMessage("voice", delegation("run the tests"));
      yield* agentMessage("voice", "Running them now.", "commentary");
      yield* agentMessage("voice", "All 42 tests pass.", "final_answer");
      yield* complete("voice");

      yield* Deferred.await(voice.speechRequested);
      NodeAssert.deepEqual(
        voice.requests.filter((request) => request.method === "thread/realtime/appendSpeech"),
        [
          {
            method: "thread/realtime/appendSpeech",
            params: { threadId: PROVIDER_THREAD, text: "All 42 tests pass." },
          },
        ],
      );
      yield* Fiber.interrupt(voice.fiber);
    }),
  );
});
