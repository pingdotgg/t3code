import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { callRpc } from "./_internal/shared.ts";
import * as AcpError from "./errors.ts";

describe("effect-acp errors", () => {
  it.effect("retains RPC method and cause without deriving the message from the cause", () => {
    const rootCause = new Error("connection details that must not become the public message");
    const failure = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: rootCause.message,
        cause: rootCause,
      }),
    });

    return Effect.gen(function* () {
      const error = yield* callRpc("session/new", Effect.fail(failure)).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpTransportError",
        operation: "call-rpc",
        method: "session/new",
        cause: failure,
      });
      expect(error.message).toBe("ACP transport operation call-rpc failed for method session/new.");
      expect(error.message).not.toContain(rootCause.message);
    });
  });

  it.effect("preserves protocol request errors as request errors", () => {
    const failure = AcpSchema.Error.make({
      code: -32602,
      message: "Invalid params",
      data: { field: "sessionId" },
    });

    return Effect.gen(function* () {
      const error = yield* callRpc("session/load", Effect.fail(failure)).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "AcpRequestError",
        code: -32602,
        errorMessage: "Invalid params",
        data: { field: "sessionId" },
      });
    });
  });

  it("does not expose legacy diagnostic detail as the transport message", () => {
    const cause = new Error("connection refused at a private endpoint");
    const error = new AcpError.AcpTransportError({
      detail: cause.message,
      cause,
    });

    expect(error.message).toBe("ACP transport operation failed.");
    expect(error.cause).toBe(cause);
  });
});
