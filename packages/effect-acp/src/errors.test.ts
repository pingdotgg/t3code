import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";

import * as AcpSchema from "./_generated/schema.gen.ts";
import { callRpc, runHandler } from "./_internal/shared.ts";
import * as AcpError from "./errors.ts";

const decodeNestedNumberPayload = Schema.decodeUnknownEffect(
  Schema.Struct({ profile: Schema.Struct({ token: Schema.Number }) }),
);
const encodeUnknownJson = Schema.encodeSync(Schema.UnknownFromJsonString);

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
        method: "session/load",
        operation: "receive-response",
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

  it("preserves structured extension handler failures behind stable request errors", () => {
    const cause = new AcpError.AcpTransportError({
      operation: "read-input-stream",
      cause: new Error("private transport diagnostics"),
    });
    const error = AcpError.AcpRequestError.fromExtensionHandlerError(cause, "x/test");

    expect(error).toMatchObject({
      code: -32603,
      method: "x/test",
      operation: "handle-extension-request",
      cause,
    });
    expect(error.message).toBe("ACP extension request handler failed for method 'x/test'");
    expect(error.message).not.toContain(cause.message);
  });

  it.effect("uses the structured mapper for core handler failures", () => {
    const cause = new AcpError.AcpTransportError({
      operation: "read-input-stream",
      cause: new Error("private transport diagnostics"),
    });

    return Effect.gen(function* () {
      const error = yield* runHandler(() => Effect.fail(cause), {}, "fs/read_text_file").pipe(
        Effect.flip,
      );

      expect(error).toMatchObject({
        code: -32603,
        message: "ACP request handler failed for method 'fs/read_text_file'",
      });
      expect(error.message).not.toContain(cause.message);
    });
  });

  it.effect("keeps invalid extension payload values only in the exact schema cause", () =>
    Effect.gen(function* () {
      const secret = "acp-schema-payload-secret";
      const cause = yield* decodeNestedNumberPayload({ profile: { token: secret } }).pipe(
        Effect.flip,
      );
      const error = AcpError.AcpRequestError.invalidExtensionPayload("x/private", cause);
      const { cause: directCause, ...directDiagnostics } = error;

      expect(directCause).toBe(cause);
      expect(error).toMatchObject({
        method: "x/private",
        operation: "decode-extension-request-payload",
        maximumPathDepth: 2,
      });
      expect(error.issueCount).toBeGreaterThan(0);
      expect(error.issueKinds).toContain("Pointer");
      expect(error.message).toBe("Invalid payload for ACP extension method 'x/private'.");
      expect(error.message).not.toContain(secret);
      expect(encodeUnknownJson(directDiagnostics)).not.toContain(secret);
      expect(encodeUnknownJson(error.toProtocolError())).not.toContain(secret);

      const protocolError = AcpError.AcpProtocolParseError.fromSchemaError(
        "decode-notification-payload",
        "x/private",
        cause,
      );
      const { cause: protocolCause, ...protocolDiagnostics } = protocolError;
      expect(protocolCause).toBe(cause);
      expect(protocolError).toMatchObject({
        method: "x/private",
        operation: "decode-notification-payload",
        maximumPathDepth: 2,
      });
      expect(protocolError.message).not.toContain(secret);
      expect(encodeUnknownJson(protocolDiagnostics)).not.toContain(secret);
      expect("detail" in protocolError).toBe(false);
    }),
  );
});
