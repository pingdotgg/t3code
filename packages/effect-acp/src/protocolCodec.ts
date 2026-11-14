import * as Schema from "effect/Schema";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import * as AcpSchema from "./schema.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import * as AcpError from "./errors.ts";

export const decodeSessionUpdate = Schema.decodeUnknownEffect(
  Schema.Union([
    // Claude ACP v2 reports prompt failures on idle; alpha.3 omits that field.
    Schema.Struct({
      ...AcpSchema.UpdateSessionNotification.fields,
      update: Schema.Struct({
        sessionUpdate: Schema.Literal("state_update"),
        state: Schema.Literal("idle"),
        stopReason: Schema.optionalKey(Schema.NullOr(AcpSchema.StopReason)),
        usage: Schema.optionalKey(Schema.NullOr(AcpSchema.Usage)),
        error: Schema.optionalKey(Schema.NullOr(AcpSchema.Error)),
        _meta: AcpSchema.UpdateSessionNotification.fields._meta,
      }),
    }),
    AcpSchema.UpdateSessionNotification,
    AcpSchemaV1.SessionNotification,
  ]),
);
export const decodeElicitationComplete = Schema.decodeUnknownEffect(
  AcpSchema.CompleteElicitationNotification,
);
export const parserFactory = RpcSerialization.ndJsonRpc();
// ndJsonRpc skips lines that are not JSON. A malformed agent line has to end the
// session, so frames are split here and each one goes through the strict codec.
export const makeStrictNdJsonRpcParser = () => {
  const codec = RpcSerialization.jsonRpc().makeUnsafe();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    decode: (bytes: Uint8Array | string): ReadonlyArray<unknown> => {
      const chunk = typeof bytes === "string" ? bytes : decoder.decode(bytes, { stream: true });
      const lastNewline = chunk.lastIndexOf("\n");
      // Splitting the whole buffer per chunk is quadratic for multi-megabyte lines.
      if (lastNewline === -1) {
        buffer += chunk;
        return [];
      }
      const lines = (buffer + chunk.slice(0, lastNewline)).split("\n");
      buffer = chunk.slice(lastNewline + 1);
      return lines.flatMap((line) => codec.decode(line));
    },
    // A truncated final line is left to the exit status, which explains a crash better.
    end: (): ReadonlyArray<unknown> => {
      const line = buffer + decoder.decode();
      buffer = "";
      try {
        return line.trim() === "" ? [] : codec.decode(line);
      } catch {
        return [];
      }
    },
    encode: (response: Parameters<typeof codec.encode>[0]) => {
      const encoded = codec.encode(response);
      return encoded === undefined ? undefined : `${encoded}\n`;
    },
  };
};
export const MAX_BUFFERED_RAW_NOTIFICATIONS = 32;

export const decodeFailureDiagnostics = (error: AcpError.AcpProtocolParseError) => ({
  operation: error.operation,
  ...(error.method === undefined ? {} : { method: error.method }),
  ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
  ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
  ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
  ...(error.maximumPathDepth === undefined ? {} : { maximumPathDepth: error.maximumPathDepth }),
  ...(error.issueSummary === undefined ? {} : { issueSummary: error.issueSummary }),
});
export const encodeJsonRpcNotification = Schema.encodeUnknownExit(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      method: Schema.String,
      params: Schema.Unknown,
    }),
  ),
);

export const isEffectRpcRequestId = (requestId: AcpError.AcpRequestId): boolean =>
  typeof requestId === "number" && Number.isSafeInteger(requestId);
export const isProtocolError = Schema.is(AcpSchema.Error);
/**
 * Effect RPC's JSON-RPC codec treats a standard JSON-RPC error object as a
 * defect unless it carries Effect's private `_tag: "Cause"` envelope.
 */
export function normalizeAcpJsonRpcError(
  message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
): RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded {
  if (message._tag !== "Exit" || message.exit._tag !== "Failure") return message;
  const [failure] = message.exit.cause;
  if (
    message.exit.cause.length !== 1 ||
    failure?._tag !== "Die" ||
    !isProtocolError(failure.defect)
  ) {
    return message;
  }
  return {
    ...message,
    exit: {
      _tag: "Failure",
      cause: [{ _tag: "Fail", error: failure.defect }],
    },
  };
}
