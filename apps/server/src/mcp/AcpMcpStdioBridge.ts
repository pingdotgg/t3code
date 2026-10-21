// Relay JSON-RPC verbatim; schema decoding would reject foreign payloads.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeReadline from "node:readline";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";

/** ACP mandates stdio MCP support; HTTP/SSE support varies. */

export class AcpMcpBridgeError extends Error {
  readonly _tag = "AcpMcpBridgeError";
}

const bridgeError = (cause: unknown): AcpMcpBridgeError =>
  cause instanceof AcpMcpBridgeError
    ? cause
    : new AcpMcpBridgeError(cause instanceof Error ? cause.message : String(cause), { cause });

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

export interface McpToolSessionOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly clientName: string;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface McpToolSession {
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
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
  });

  const send = Effect.fn("AcpMcpStdioBridge.send")(function* (
    message: unknown,
  ): Effect.fn.Return<ReadonlyArray<unknown>, AcpMcpBridgeError> {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchImplementation(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers() },
          body: JSON.stringify(message),
        }),
      catch: bridgeError,
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      yield* discardResponseBody(response);
      return yield* Effect.fail(
        new AcpMcpBridgeError(`T3 Code MCP endpoint responded with HTTP ${response.status}.`),
      );
    }
    const payloads = yield* Stream.runCollect(responsePayloads(response, bridgeError));
    for (const payload of payloads) {
      protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
    }
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
      return yield* Effect.fail(
        new AcpMcpBridgeError(
          `T3 Code MCP ${method} failed${envelope?.error === undefined ? "." : `: ${JSON.stringify(envelope.error)}`}`,
        ),
      );
    }
    return envelope;
  });

  const terminate = Effect.suspend(() =>
    sessionId === null
      ? Effect.void
      : Effect.tryPromise(() =>
          fetchImplementation(options.endpoint, { method: "DELETE", headers: headers() }),
        ).pipe(Effect.flatMap(discardResponseBody), Effect.ignore),
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
    return {
      call: (tool, args) =>
        request("tools/call", { name: tool, arguments: args }).pipe(
          Effect.map((envelope) => envelope.result),
        ),
    } satisfies McpToolSession;
  });
};

/**
 * This is the terminal fallback for ACP agents that accept `mcpServers` in
 * `session/new` but fail to expose those tools to their model. Compliant ACP
 * agents continue to use the stdio bridge above.
 */
function callAcpMcpTool(options: {
  readonly endpoint: string;
  readonly authorization: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}): Effect.Effect<unknown, AcpMcpBridgeError> {
  return mcpToolSession({ ...options, clientName: "t3-code-acp-cli" }).pipe(
    Effect.flatMap((session) => session.call(options.tool, options.arguments)),
    Effect.scoped,
  );
}

export function runAcpMcpStdioBridge(options: AcpMcpStdioBridgeOptions): Effect.Effect<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Effect.gen(function* () {
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    const running = new Set<Fiber.Fiber<void>>();

    const writeMessage = (message: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        options.output.write(`${JSON.stringify(message)}\n`);
      });

    const handleServerPayload = Effect.fn("AcpMcpStdioBridge.handleServerPayload")(function* (
      payload: unknown,
    ): Effect.fn.Return<void> {
      for (const entry of Array.isArray(payload) ? payload : [payload]) {
        protocolVersion = protocolVersionOf(entry) ?? protocolVersion;
        yield* writeMessage(entry);
      }
    });

    const respondWithError = (
      requestId: unknown,
      message: string,
      code = -32603,
    ): Effect.Effect<void> =>
      writeMessage({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code, message },
      });

    const forward: (line: string, envelope: JsonRpcEnvelope) => Effect.Effect<void> = Effect.fn(
      "AcpMcpStdioBridge.forward",
    )(
      function* (line: string, envelope: JsonRpcEnvelope) {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: line,
            }),
          catch: bridgeError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          if (envelope.id !== undefined) {
            yield* respondWithError(
              envelope.id,
              `T3 Code MCP endpoint responded with HTTP ${response.status}.`,
            );
          }
          return yield* discardResponseBody(response);
        }
        yield* Stream.runForEach(responsePayloads(response, bridgeError), handleServerPayload);
      },
      (effect, _line, envelope) =>
        effect.pipe(
          Effect.catchCause((cause) => {
            if (envelope.id === undefined) return Effect.void;
            const error = Cause.squash(cause);
            return respondWithError(
              envelope.id,
              `T3 Code MCP bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
        ),
    );

    // Order only session establishment; SSE responses must bypass it to avoid deadlock. Calls remain concurrent after initialization.
    let sessionBarrier: Effect.Effect<void> = Effect.void;
    let sessionBarrierPending = false;

    const launch = Effect.fn("AcpMcpStdioBridge.launch")(function* (
      task: Effect.Effect<void>,
    ): Effect.fn.Return<void> {
      const fiber = yield* Effect.forkChild(task);
      running.add(fiber);
      yield* Effect.forkChild(
        Fiber.await(fiber).pipe(
          Effect.andThen(
            Effect.sync(() => {
              running.delete(fiber);
            }),
          ),
        ),
      );
    });

    const dispatch = Effect.fn("AcpMcpStdioBridge.dispatch")(function* (
      line: string,
    ): Effect.fn.Return<void> {
      if (line.trim().length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return yield* respondWithError(null, "Parse error", -32700);
      }
      const envelope = asEnvelope(parsed);
      if (envelope === null) return;
      const isResponse = envelope.id !== undefined && ("result" in envelope || "error" in envelope);
      const isSessionHandshake =
        envelope.method === "initialize" || envelope.method === "notifications/initialized";
      if (isResponse) {
        return yield* launch(forward(line, envelope));
      }
      if (isSessionHandshake) {
        const prior = sessionBarrier;
        const fiber = yield* Effect.forkChild(prior.pipe(Effect.andThen(forward(line, envelope))));
        running.add(fiber);
        const barrier = Fiber.await(fiber).pipe(Effect.asVoid);
        sessionBarrier = barrier;
        sessionBarrierPending = true;
        yield* Effect.forkChild(
          Fiber.await(fiber).pipe(
            Effect.andThen(
              Effect.sync(() => {
                running.delete(fiber);
                if (sessionBarrier === barrier) sessionBarrierPending = false;
              }),
            ),
          ),
        );
        return;
      }
      const task = sessionBarrierPending
        ? sessionBarrier.pipe(Effect.andThen(forward(line, envelope)))
        : forward(line, envelope);
      return yield* launch(task);
    });

    const reader = NodeReadline.createInterface({ input: options.input });
    yield* Stream.runForEach(Stream.fromAsyncIterable(reader, bridgeError), dispatch).pipe(
      Effect.catchCause(() => Effect.void),
    );
    yield* Fiber.awaitAll(running);
  });
}

/** Avoid heavy imports on the ACP first-message path. */
export async function runAcpMcpCliFastPath(
  command: "acp-mcp-bridge" | "acp-mcp-call",
  args: ReadonlyArray<string>,
): Promise<void> {
  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) {
    process.stderr.write(`${command} requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.\n`);
    process.exitCode = 2;
    return;
  }
  if (command === "acp-mcp-bridge") {
    await Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint,
        authorization,
        input: process.stdin,
        output: process.stdout,
      }),
    );
    return;
  }
  const [tool, argumentsJson] = args;
  if (tool === undefined || argumentsJson === undefined) {
    process.stderr.write("acp-mcp-call requires <tool> and <arguments-json>.\n");
    process.exitCode = 2;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    process.stderr.write("acp-mcp-call arguments must be valid JSON.\n");
    process.exitCode = 2;
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("acp-mcp-call arguments must be a JSON object.\n");
    process.exitCode = 2;
    return;
  }
  const result = await Effect.runPromise(
    callAcpMcpTool({
      endpoint,
      authorization,
      tool,
      arguments: parsed as Record<string, unknown>,
    }),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
