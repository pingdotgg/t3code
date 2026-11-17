import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { responsePayloads } from "./mcpResponsePayloads.ts";

it.effect("reads SSE line endings across byte-chunk boundaries without splitting CRLF", () =>
  Effect.gen(function* () {
    for (const separator of [
      "\n\n",
      "\r\r",
      "\r\n\r\n",
      "\r\n\n",
      "\n\r",
      "\n\r\n",
      "\r\r\n",
      "\r\n\r",
    ]) {
      for (const dataLineSeparator of ["\n", "\r", "\r\n"]) {
        const bytes = new TextEncoder().encode(
          `: keep-alive${separator}data: {"id":1,${dataLineSeparator}data: "result":{"text":"café😀"}}${separator}` +
            'data: {"id":2,"result":{}}\n\ndata: {"id":3}',
        );
        for (let cut = 0; cut <= bytes.length; cut += 1) {
          const response = new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.subarray(0, cut));
                controller.enqueue(bytes.subarray(cut));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
          const payloads = yield* Stream.runCollect(
            responsePayloads(response, (cause) => ({
              _tag: "ResponsePayloadError" as const,
              cause,
              separator,
              dataLineSeparator,
              cut,
            })),
          );
          expect(
            Array.from(payloads),
            JSON.stringify({ separator, dataLineSeparator, cut }),
          ).toEqual([
            { id: 1, result: { text: "café😀" } },
            { id: 2, result: {} },
          ]);
        }
      }
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: {"id":4}${separator}`));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      const payloads = yield* Stream.runCollect(
        responsePayloads(response, (cause) => ({
          _tag: "ResponsePayloadError" as const,
          cause,
          separator,
        })).pipe(Stream.take(1)),
      );
      expect(Array.from(payloads)).toEqual([{ id: 4 }]);
    }
  }),
);

it.effect("reads a multi-megabyte SSE event delivered in small chunks", () =>
  Effect.gen(function* () {
    const text = "x".repeat(8 * 1024 * 1024);
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ id: 1, result: { text } })}\n\n`,
    );
    let offset = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) return controller.close();
          controller.enqueue(bytes.subarray(offset, offset + 256));
          offset = Math.min(offset + 256, bytes.length);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const payloads = yield* Stream.runCollect(
      responsePayloads(response, (cause) => ({ _tag: "ResponsePayloadError" as const, cause })),
    );
    expect(Array.from(payloads)).toEqual([{ id: 1, result: { text } }]);
  }),
);

it.effect("reads a 32 MiB SSE event delivered in 256-byte chunks", () =>
  Effect.gen(function* () {
    const text = "x".repeat(32 * 1024 * 1024);
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ id: 1, result: { text } })}\n\n`,
    );
    let offset = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) return controller.close();
          controller.enqueue(bytes.subarray(offset, offset + 256));
          offset = Math.min(offset + 256, bytes.length);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const payloads = yield* Stream.runCollect(
      responsePayloads(response, (cause) => ({ _tag: "ResponsePayloadError" as const, cause })),
    );
    expect(Array.from(payloads)).toEqual([{ id: 1, result: { text } }]);
  }),
);

it.effect("picks the SSE reader from the media type alone, whatever its case", () =>
  Effect.gen(function* () {
    const response = new Response('data: {"id":1}\n\n', {
      headers: { "content-type": "Text/Event-Stream; charset=utf-8" },
    });
    const payloads = yield* Stream.runCollect(
      responsePayloads(response, (cause) => ({ _tag: "ResponsePayloadError" as const, cause })),
    );
    expect(Array.from(payloads)).toEqual([{ id: 1 }]);

    const json = new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
      headers: {
        "content-type": 'application/json; profile="https://example.com/Text/Event-Stream"',
      },
    });
    const jsonPayloads = yield* Stream.runCollect(
      responsePayloads(json, (cause) => ({ _tag: "ResponsePayloadError" as const, cause })),
    );
    expect(Array.from(jsonPayloads)).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  }),
);

it.effect.each(["text/event-stream", "application/json"])(
  "releases a stalled %s response body when its consumer is interrupted",
  (contentType) =>
    Effect.gen(function* () {
      const reading = Promise.withResolvers<void>();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
          pull() {
            reading.resolve();
          },
        },
        { highWaterMark: 0 },
      );
      const response = new Response(body, { headers: { "content-type": contentType } });
      const consumer = yield* Stream.runDrain(responsePayloads(response, String)).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => reading.promise);
      yield* Fiber.interrupt(consumer);
      try {
        expect(
          () => controller.enqueue(new TextEncoder().encode("late response bytes")),
          "interrupted MCP response must stop accepting body bytes",
        ).toThrow(TypeError);
        expect(body.locked, "interrupted MCP response must release its body").toBe(false);
      } finally {
        if (body.locked) controller.close();
      }
    }),
);
