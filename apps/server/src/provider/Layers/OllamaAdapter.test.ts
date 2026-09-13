import { describe, expect, it } from "@effect/vitest";
import { OllamaSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderAdapterValidationError } from "../Errors.ts";
import { makeOllamaAdapter } from "./OllamaAdapter.ts";
import type { OllamaFetch } from "./OllamaProvider.ts";

const decodeSettings = Schema.decodeSync(OllamaSettings);
const settings = decodeSettings({
  enabled: true,
  host: "http://ollama.test",
  defaultModel: "llama3.2",
});

const makeAdapter = (fetchImpl: OllamaFetch) =>
  makeOllamaAdapter(settings, {
    instanceId: ProviderInstanceId.make("ollama-test"),
    fetch: fetchImpl,
  });

const streamingResponse = (...chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );

const controllableStreamingResponse = () => {
  const encoder = new TextEncoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    }),
    { status: 200 },
  );
  return {
    response,
    write: (chunk: string) => streamController.enqueue(encoder.encode(chunk)),
    close: () => streamController.close(),
  };
};

describe("Ollama adapter", () => {
  it.effect("publishes streamed content.delta events followed by turn.completed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("ollama-stream-thread");
      const stream = controllableStreamingResponse();
      let requestSignal: AbortSignal | undefined;
      const adapter = yield* makeAdapter(async (_input, init) => {
        requestSignal = init?.signal as AbortSignal;
        return stream.response;
      });

      const eventsFiber = yield* Stream.runCollect(adapter.streamEvents.pipe(Stream.take(5))).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.startSession({
        threadId,
        cwd: "/tmp",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({ threadId, input: "say hello" });
      expect(yield* adapter.listSessions()).toMatchObject([
        { threadId, status: "running", activeTurnId: turn.turnId },
      ]);

      stream.write('{"message":{"content":"hello"}}\n');
      stream.write('{"message":{"content":" world"}}\n');
      stream.close();
      const events = yield* Fiber.join(eventsFiber);
      yield* Effect.yieldNow;

      expect(turn.threadId).toBe(threadId);
      expect(events.map((event) => event.type)).toEqual([
        "session.started",
        "turn.started",
        "content.delta",
        "content.delta",
        "turn.completed",
      ]);
      expect(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta),
      ).toEqual(["hello", " world"]);

      expect(events.at(-1)?.type).toBe("turn.completed");
      expect(requestSignal?.aborted).toBe(true);
      expect(yield* adapter.listSessions()).toMatchObject([{ threadId, status: "ready" }]);
      expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
    }),
  );

  it.effect("rejects a model selection bound to a different provider instance", () =>
    Effect.gen(function* () {
      const calls: Request[] = [];
      const threadId = ThreadId.make("ollama-instance-binding-thread");
      const adapter = yield* makeAdapter(async (input, init) => {
        calls.push(new Request(String(input), init));
        return streamingResponse('{"message":{"content":"ok"}}\n');
      });

      yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "test binding",
          modelSelection: {
            instanceId: ProviderInstanceId.make("different-ollama"),
            model: "wrong-model",
          },
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProviderAdapterValidationError);
      expect(error).toMatchObject({
        provider: "ollama",
        operation: "sendTurn",
      });
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect("rejects a session bound to a different provider instance", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(async () => streamingResponse());
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("ollama-session-instance-binding-thread"),
          providerInstanceId: ProviderInstanceId.make("different-ollama"),
          cwd: "/tmp",
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProviderAdapterValidationError);
      expect(error).toMatchObject({ provider: "ollama", operation: "startSession" });
    }),
  );

  it.effect("does not carry a cancelled partial reply into later prompts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("ollama-cancelled-history-thread");
      const firstStream = controllableStreamingResponse();
      const requestBodies: Array<{
        messages?: Array<{ role?: string; content?: string }>;
      }> = [];
      let requestCount = 0;
      const adapter = yield* makeAdapter(async (input, init) => {
        requestBodies.push(
          (await new Request(String(input), init).json()) as {
            messages?: Array<{ role?: string; content?: string }>;
          },
        );
        requestCount += 1;
        return requestCount === 1
          ? firstStream.response
          : streamingResponse('{"message":{"content":"finished"}}\n');
      });

      yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "first prompt" });
      const firstDelta = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "content.delta" && event.turnId === first.turnId),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      firstStream.write('{"message":{"content":"partial"}}\n');
      yield* Fiber.join(firstDelta);

      const secondCompleted = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "completed",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({ threadId, input: "second prompt" });
      yield* Fiber.join(secondCompleted);

      firstStream.close();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const thirdCompleted = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "turn.completed" && event.payload.state === "completed",
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.sendTurn({ threadId, input: "third prompt" });
      yield* Fiber.join(thirdCompleted);

      expect(requestBodies[2]?.messages).toEqual([
        { role: "user", content: "first prompt" },
        { role: "user", content: "second prompt" },
        { role: "assistant", content: "finished" },
        { role: "user", content: "third prompt" },
      ]);
    }),
  );

  it.effect("stops the previous request before replacing a session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("ollama-session-replacement-thread");
      const firstStream = controllableStreamingResponse();
      let requestSignal: AbortSignal | undefined;
      let markRequestStarted!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      const adapter = yield* makeAdapter(async (_input, init) => {
        requestSignal = init?.signal as AbortSignal;
        markRequestStarted();
        return firstStream.response;
      });

      yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "old prompt" });
      yield* Effect.promise(() => requestStarted);

      const exited = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "session.exited"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });

      expect(requestSignal?.aborted).toBe(true);
      expect((yield* Fiber.join(exited))._tag).toBe("Some");

      const staleDelta = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "content.delta"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      firstStream.write('{"message":{"content":"stale"}}\n');
      firstStream.close();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(staleDelta.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(staleDelta);
    }),
  );

  it.effect("aborts an in-flight Ollama request when interrupted", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined;
      let markRequestStarted!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      const threadId = ThreadId.make("ollama-cancellation-thread");
      const adapter = yield* makeAdapter(async (_input, init) => {
        requestSignal = init?.signal as AbortSignal;
        markRequestStarted();
        return new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
          }),
          { status: 200 },
        );
      });

      yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "keep waiting" });
      yield* Effect.promise(() => requestStarted);
      yield* adapter.interruptTurn(threadId);

      expect(requestSignal?.aborted).toBe(true);
    }),
  );
});
