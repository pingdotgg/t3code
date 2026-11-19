import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as RpcClientError from "effect/rpc/RpcClientError";

import { callRpc } from "./_internal/shared.ts";
import * as AcpError from "./errors.ts";

const decodeNestedNumberPayload = Schema.decodeUnknownEffect(
  Schema.Struct({ profile: Schema.Struct({ token: Schema.Number }) }),
);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

  it.effect("preserves typed ACP failures carried by the RPC protocol", () => {
    const original = new AcpError.AcpTransportError({
      detail: "Sign in to the agent.",
      cause: undefined,
    });
    const failure = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "ACP protocol terminated.",
        cause: original,
      }),
    });

    return Effect.gen(function* () {
      const error = yield* callRpc("initialize", Effect.fail(failure)).pipe(Effect.flip);
      expect(error).toBe(original);
    });
  });

  it("includes the authored detail but not the cause in the transport message", () => {
    const cause = new Error("connection refused at a private endpoint");
    const error = new AcpError.AcpTransportError({
      detail: "ACP replay did not consume all frames",
      cause,
    });

    expect(error.message).toBe(
      "ACP transport operation failed: ACP replay did not consume all frames.",
    );
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

  it.effect("summarizes schema issues by path without payload values", () =>
    Effect.gen(function* () {
      const secret = "acp-summary-secret";
      const decodeStruct = Schema.decodeUnknownEffect(
        Schema.Struct({
          update: Schema.Struct({ used: Schema.Number, size: Schema.Number }),
          env: Schema.Record(Schema.String, Schema.Number),
        }),
      );

      const cause = yield* decodeStruct(
        { update: { size: secret }, env: { [`${secret} key`]: secret } },
        { errors: "all" },
      ).pipe(Effect.flip);
      const error = AcpError.AcpProtocolParseError.fromSchemaError(
        "decode-notification-payload",
        "session/update",
        cause,
      );

      expect(error.issueSummary).toBe(
        "update.used missing, update.size wrong type, env.* wrong type",
      );
      expect(error.message).toBe(
        "ACP protocol operation 'decode-notification-payload' failed for method 'session/update': update.used missing, update.size wrong type, env.* wrong type.",
      );
      expect(error.message).not.toContain(secret);
    }),
  );
});
