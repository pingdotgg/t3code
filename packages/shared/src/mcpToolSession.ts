// Relay JSON-RPC verbatim; schema decoding would reject foreign payloads.
// @effect-diagnostics globalJsonInEffect:off
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { discardResponseBody, responsePayloads } from "./mcpResponsePayloads.ts";

const JsonRpcError = Schema.Struct({ code: Schema.Number, message: Schema.String });

export class AcpMcpBridgeError extends Schema.TaggedError<AcpMcpBridgeError>()(
  "AcpMcpBridgeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    /** The JSON-RPC error the server answered with, when it answered. */
    rpcError: Schema.optional(JsonRpcError),
  },
) {}

const decodeRpcError = Schema.decodeUnknownOption(JsonRpcError);

const isAcpMcpBridgeError = Schema.is(AcpMcpBridgeError);

export const bridgeError = (cause: unknown): AcpMcpBridgeError =>
  isAcpMcpBridgeError(cause)
    ? cause
    : new AcpMcpBridgeError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

export interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

export function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function replyToServerRequest(envelope: JsonRpcEnvelope): unknown {
  return envelope.method === "ping"
    ? { jsonrpc: "2.0", id: envelope.id, result: {} }
    : { jsonrpc: "2.0", id: envelope.id, error: { code: -32601, message: "Method not found" } };
}

export interface McpToolSessionOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly clientName: string;
  readonly exposure?: "deferred";
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface McpToolSession {
  readonly listTools: () => Effect.Effect<ReadonlyArray<unknown>, AcpMcpBridgeError>;
  /** Resolves to the JSON-RPC `result` of `tools/call`, a `CallToolResult`. */
  readonly call: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, AcpMcpBridgeError>;
}

/**
 * One initialized MCP session over T3 Code's HTTP endpoint, terminated when
 * the scope closes. Used by the ACP terminal fallback and `t3 thread`.
 */
export const mcpToolSession = (
  options: McpToolSessionOptions,
): Effect.Effect<McpToolSession, AcpMcpBridgeError, Scope.Scope> => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;

  const headers = () => ({
    accept: "application/json, text/event-stream",
    authorization: options.authorization,
    ...(options.exposure === undefined ? {} : { "t3-tool-exposure": options.exposure }),
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
  });

  const send = Effect.fn("AcpMcpStdioBridge.send")(function* (
    message: unknown,
  ): Effect.fn.Return<ReadonlyArray<unknown>, AcpMcpBridgeError> {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchImplementation(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers() },
          body: JSON.stringify(message),
          redirect: "error",
          signal,
        }),
      catch: bridgeError,
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      yield* discardResponseBody(response);
      return yield* new AcpMcpBridgeError({
        message: `T3 Code MCP endpoint responded with HTTP ${response.status}.`,
      });
    }
    const payloads: Array<unknown> = [];
    yield* Stream.runForEach(responsePayloads(response, bridgeError), (payload) => {
      protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
      const envelope = asEnvelope(payload);
      if (envelope?.id !== undefined && typeof envelope.method === "string") {
        return send(replyToServerRequest(envelope)).pipe(Effect.asVoid);
      }
      payloads.push(payload);
      return Effect.void;
    });
    return payloads;
  });

  const request = Effect.fn("AcpMcpStdioBridge.request")(function* (
    method: string,
    params: unknown,
  ): Effect.fn.Return<JsonRpcEnvelope, AcpMcpBridgeError> {
    const id = `t3-cli-${nextId++}`;
    const responses = yield* send({ jsonrpc: "2.0", id, method, params });
    const envelope = asEnvelope(responses.find((entry) => asEnvelope(entry)?.id === id));
    if (envelope === null || envelope.error !== undefined) {
      const rpcError = Option.getOrUndefined(decodeRpcError(envelope?.error));
      return yield* new AcpMcpBridgeError({
        message: `T3 Code MCP ${method} failed${envelope?.error === undefined ? "." : `: ${JSON.stringify(envelope.error)}`}`,
        ...(rpcError === undefined ? {} : { rpcError }),
      });
    }
    return envelope;
  });

  const terminate = Effect.suspend(() =>
    sessionId === null
      ? Effect.void
      : Effect.tryPromise({
          try: () =>
            fetchImplementation(options.endpoint, {
              method: "DELETE",
              headers: headers(),
              redirect: "error",
            }),
          catch: bridgeError,
        }).pipe(Effect.flatMap(discardResponseBody), Effect.ignore),
  );

  // Registered before the handshake so a session the server opened is ended
  // even when the handshake fails, and the handshake stays interruptible.
  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() => terminate);
    yield* request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: options.clientName, version: "0.0.0" },
    });
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listTools = Effect.fn("McpToolSession.listTools")(function* () {
      const tools: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const reply = yield* request("tools/list", cursor ? { cursor } : {});
        const page = reply.result as { tools?: unknown; nextCursor?: unknown } | undefined;
        if (Array.isArray(page?.tools)) tools.push(...page.tools);
        cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
        if (cursor === undefined || cursors.has(cursor) || cursors.size >= 64) break;
        cursors.add(cursor);
      } while (cursor !== undefined);
      return tools;
    });
    return {
      listTools,
      call: (tool, args) =>
        request("tools/call", { name: tool, arguments: args }).pipe(
          Effect.map((envelope) => envelope.result),
        ),
    } satisfies McpToolSession;
  });
};
