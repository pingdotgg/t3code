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

describe("Ollama adapter", () => {
  it.effect("publishes streamed content.delta events followed by turn.completed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("ollama-stream-thread");
      const adapter = yield* makeAdapter(async () =>
        streamingResponse(
          '{"message":{"content":"hello"}}\n',
          '{"message":{"content":" world"}}\n',
        ),
      );

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
      const events = yield* Fiber.join(eventsFiber);

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
    }),
  );

  it.effect("ignores a model selection bound to a different provider instance", () =>
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

  it.effect("aborts an in-flight Ollama request when interrupted", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined;
      const threadId = ThreadId.make("ollama-cancellation-thread");
      const adapter = yield* makeAdapter(async (_input, init) => {
        requestSignal = init?.signal as AbortSignal;
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
      const send = yield* adapter
        .sendTurn({ threadId, input: "keep waiting" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* adapter.interruptTurn(threadId);

      expect(requestSignal?.aborted).toBe(true);
      yield* Fiber.interrupt(send);
    }),
  );
});
