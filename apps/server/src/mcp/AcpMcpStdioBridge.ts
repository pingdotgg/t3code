// Relay JSON-RPC verbatim; schema decoding would reject foreign payloads.
// @effect-diagnostics globalJsonInEffect:off
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";
import {
  AcpMcpBridgeError,
  asEnvelope,
  bridgeError,
  mcpToolSession as makeMcpToolSession,
  protocolVersionOf,
  type JsonRpcEnvelope,
  type McpToolSessionOptions,
  type McpToolSession as SharedMcpToolSession,
} from "@t3tools/shared/mcpToolSession";

export { AcpMcpBridgeError, type McpToolSessionOptions };
export type McpToolSession = Pick<SharedMcpToolSession, "call">;
export const mcpToolSession = (
  options: McpToolSessionOptions,
): Effect.Effect<McpToolSession, AcpMcpBridgeError, Scope.Scope> => makeMcpToolSession(options);

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

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
          try: (signal) =>
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
              signal,
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
      const parsed = decodeJsonLine(line);
      if (Option.isNone(parsed)) {
        return yield* respondWithError(null, "Parse error", -32700);
      }
      const envelope = asEnvelope(parsed.value);
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

    // node:readline also splits on U+2028/U+2029, which JSON.stringify leaves raw inside strings.
    yield* Stream.fromAsyncIterable(options.input, bridgeError).pipe(
      Stream.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(dispatch),
      Effect.ignoreCause,
    );
    yield* Fiber.awaitAll(running);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  const [tool, argumentsArg] = args;
  if (tool === undefined || argumentsArg === undefined) {
    process.stderr.write(
      "acp-mcp-call requires <tool> and <arguments-json>, or - to read it from stdin.\n",
    );
    process.exitCode = 2;
    return;
  }
  // Windows PowerShell 5.1 strips the quotes from JSON passed as an argument; stdin keeps them.
  const argumentsJson = argumentsArg === "-" ? await readStdin() : argumentsArg;
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
  let result = await Effect.runPromise(
    callAcpMcpTool({
      endpoint,
      authorization,
      tool,
      arguments: parsed as Record<string, unknown>,
    }),
  );
  // Terminal callers see both fields, unlike native MCP clients that choose one.
  if (
    typeof result === "object" &&
    result !== null &&
    "structuredContent" in result &&
    result.structuredContent !== undefined &&
    "content" in result &&
    Array.isArray(result.content)
  ) {
    const encoded = JSON.stringify(result.structuredContent);
    result = {
      ...result,
      content: result.content.filter(
        (part: unknown) =>
          !(
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            part.text === encoded
          ),
      ),
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
