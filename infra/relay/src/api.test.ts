import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  isDpopAuthorizationHeader,
  relayCorsPreflightHeaders,
  traceRelayHttpRequest,
} from "./api.ts";

function splitHeaderTokens(value: string): ReadonlyArray<string> {
  return value.split(",").map((token) => token.trim());
}

describe("relay CORS", () => {
  it("allows Effect trace propagation headers from browser clients", () => {
    expect(splitHeaderTokens(relayCorsPreflightHeaders["access-control-allow-headers"])).toEqual([
      "authorization",
      "b3",
      "traceparent",
      "content-type",
      "dpop",
    ]);
  });
});

describe("relay DPoP authentication", () => {
  it("requires the HTTP DPoP authorization scheme", () => {
    expect(isDpopAuthorizationHeader("DPoP access-token")).toBe(true);
    expect(isDpopAuthorizationHeader("dpop access-token")).toBe(true);
    expect(isDpopAuthorizationHeader("Bearer access-token")).toBe(false);
    expect(isDpopAuthorizationHeader("access-token")).toBe(false);
  });
});

describe("relay request tracing", () => {
  it.effect("adds a server request span around endpoint spans in the worker adapter path", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const endpoint = Effect.fn("relay.test.endpoint")(() =>
        Effect.succeed(HttpServerResponse.empty({ status: 204 })),
      );
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/v1/mobile/devices?client=mobile", {
          method: "POST",
        }),
      );

      yield* traceRelayHttpRequest(endpoint(), tracer).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      );
      yield* Effect.yieldNow;

      expect(spans.map((span) => span.name)).toEqual(["http.server POST", "relay.test.endpoint"]);
      expect(spans[0]?.kind).toBe("server");
      expect(spans[0]?.attributes.get("url.path")).toBe("/v1/mobile/devices");
      expect(spans[0]?.attributes.get("http.response.status_code")).toBe(204);
      expect(Option.getOrUndefined(spans[1]!.parent)?.spanId).toBe(spans[0]?.spanId);
    }),
  );
});
