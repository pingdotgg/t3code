import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
