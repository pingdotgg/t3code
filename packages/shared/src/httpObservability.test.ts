import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as HttpObservability from "./httpObservability.ts";

describe("HttpObservability.layer", () => {
  it.effect("redacts credential query parameters on HTTP client spans", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
    );
    return Effect.gen(function* () {
      yield* client.get("https://example.com/ws?wsTicket=secret&clientOs=linux&dpop=proof");
      const span = spans.find((candidate) => candidate.kind === "client")!;
      expect(span.attributes.get("url.full")).toBe(
        "https://example.com/ws?wsTicket=REDACTED&clientOs=linux&dpop=REDACTED",
      );
      expect(span.attributes.get("url.query")).toBe(
        "wsTicket=REDACTED&clientOs=linux&dpop=REDACTED",
      );
    }).pipe(Effect.provide(HttpObservability.layer), Effect.withTracer(tracer));
  });
});
