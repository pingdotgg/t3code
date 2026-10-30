import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { responsePayloads } from "./mcpResponsePayloads.ts";

class McpResponseTestError extends Data.TaggedError("McpResponseTestError")<{ cause: unknown }> {}

describe("responsePayloads", () => {
  it.effect.each([
    "text/event-stream",
    "text/event-stream; charset=utf-8",
    "Text/Event-Stream; Charset=UTF-8",
    "TEXT/EVENT-STREAM",
  ])("reads SSE payloads with Content-Type %s", (contentType) =>
    Effect.gen(function* () {
      const response = new Response(
        'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n' +
          'data: {"jsonrpc":"2.0","id":7,"result":{"text":"Keep This Case"}}\n\n',
        { headers: { "content-type": contentType } },
      );
      const payloads = yield* Stream.runCollect(
        responsePayloads(response, (cause) => new McpResponseTestError({ cause })),
      );

      expect(payloads).toEqual([
        { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
        { jsonrpc: "2.0", id: 7, result: { text: "Keep This Case" } },
      ]);
    }),
  );

  it.effect.each(["application/json", 'application/json; profile="TEXT/EVENT-STREAM"'])(
    "reads a JSON response with Content-Type %s",
    (contentType) =>
      Effect.gen(function* () {
        const response = new Response('{"jsonrpc":"2.0","id":7,"result":{}}', {
          headers: { "content-type": contentType },
        });
        const payloads = yield* Stream.runCollect(
          responsePayloads(response, (cause) => new McpResponseTestError({ cause })),
        );

        expect(payloads).toEqual([{ jsonrpc: "2.0", id: 7, result: {} }]);
      }),
  );
});
