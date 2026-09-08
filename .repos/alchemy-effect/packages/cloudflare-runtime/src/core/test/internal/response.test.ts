import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  decodeResponse,
  makeErrorEnvelope,
  makeErrorResponse,
} from "../../internal/response.shared.ts";
import { ConfigError, SystemError } from "../../RuntimeError.shared.ts";

describe("response.shared", () => {
  it("makeErrorEnvelope encodes a ConfigError", () => {
    const error = new ConfigError({ subtag: "Bad", message: "nope" });
    const envelope = makeErrorEnvelope(error);
    expect(envelope).toMatchObject({
      ok: false,
      error: { _tag: "ConfigError", subtag: "Bad", message: "nope" },
    });
  });

  it("makeErrorResponse builds a JSON Response with the envelope", async () => {
    const error = new SystemError({ subtag: "Boom", message: "boom" });
    const response = makeErrorResponse(error, { status: 502 });
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as {
      ok: boolean;
      error: { subtag: string };
    };
    expect(body).toMatchObject({
      ok: false,
      error: { _tag: "SystemError", subtag: "Boom", message: "boom" },
    });
  });

  it.effect("decodeResponse returns the result for an ok envelope", () =>
    Effect.gen(function* () {
      const response = Response.json({ ok: true, result: { hello: "world" } });
      const result = yield* Effect.promise(() =>
        decodeResponse<{ hello: string }>(response),
      );
      expect(result).toEqual({ hello: "world" });
    }),
  );

  it.effect("decodeResponse throws the encoded RuntimeError", () =>
    Effect.gen(function* () {
      const response = new Response(
        JSON.stringify(
          makeErrorEnvelope(
            new ConfigError({ subtag: "X", message: "thrown" }),
          ),
        ),
        { status: 500 },
      );
      const error = yield* Effect.tryPromise(() =>
        decodeResponse(response),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        cause: { _tag: "ConfigError", subtag: "X", message: "thrown" },
      });
    }),
  );

  it.effect("decodeResponse wraps invalid JSON as a SystemError", () =>
    Effect.gen(function* () {
      const response = new Response("<<not json>>", { status: 503 });
      const error = yield* Effect.tryPromise(() =>
        decodeResponse(response),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        cause: {
          _tag: "SystemError",
          subtag: "InvalidResponse",
        },
      });
    }),
  );
});
