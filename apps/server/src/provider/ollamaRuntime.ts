/**
 * Ollama runtime utilities — HTTP helpers for the Ollama REST API.
 *
 * All HTTP calls use native `fetch` wrapped in Effect.gen. Chat
 * streaming pipes the response body through an async generator for
 * SSE parsing.
 *
 * @module provider/ollamaRuntime
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// ── Types ──────────────────────────────────────────────────────────────

export type OllamaChatRole = "system" | "user" | "assistant" | "tool";

export interface OllamaToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface OllamaToolCall {
  readonly function: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  };
}

export interface OllamaChatMessage {
  readonly role: OllamaChatRole;
  readonly content: string;
  readonly tool_calls?: readonly OllamaToolCall[];
}

export interface OllamaChatResponse {
  readonly model: string;
  readonly createdAt: string;
  readonly message: OllamaChatMessage;
  readonly done: boolean;
  readonly doneReason?: string;
  readonly totalDuration?: number;
}

export interface OllamaChatChunk {
  readonly model: string;
  readonly createdAt: string;
  readonly message: { readonly role: OllamaChatRole; readonly content: string; readonly tool_calls?: readonly OllamaToolCall[] };
  readonly done: boolean;
  readonly doneReason?: string;
}

export interface OllamaModelInfo {
  readonly name: string;
  readonly modifiedAt: string;
  readonly size: number;
  readonly digest: string;
}

// ── Error ──────────────────────────────────────────────────────────────

const RUNTIME_ERROR_TAG = "OllamaRuntimeError";

export class OllamaRuntimeError extends Data.TaggedError(RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  static readonly is = (u: unknown): u is OllamaRuntimeError =>
    typeof u === "object" && u !== null && (u as Record<string, unknown>)._tag === RUNTIME_ERROR_TAG;
}

function fail(operation: string, detail: string, cause?: unknown): Effect.Effect<never, OllamaRuntimeError> {
  return Effect.fail(new OllamaRuntimeError({ operation, detail, cause }));
}

// ── Headers helper ─────────────────────────────────────────────────────

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey && apiKey.trim().length > 0) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

// ── Non-streaming chat ─────────────────────────────────────────────────

export const ollamaChat = (input: {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly messages: ReadonlyArray<OllamaChatMessage>;
  readonly tools?: ReadonlyArray<OllamaToolDefinition>;
  readonly options?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}) =>
  Effect.gen(function* () {
    const body = {
      model: input.model,
      messages: [...input.messages],
      stream: false,
      ...(input.tools && input.tools.length > 0 ? { tools: [...input.tools] } : {}),
      ...(input.options ? { options: input.options } : {}),
    };
    let response: Response;
    try {
      response = yield* Effect.promise(() =>
        fetch(`${input.baseUrl}/api/chat`, {
          method: "POST",
          headers: buildHeaders(input.apiKey),
          body: JSON.stringify(body),
          signal: input.signal ?? null,
        }),
      );
    } catch (cause) {
      return yield* fail("ollamaChat", String(cause), cause);
    }
    if (!response.ok) {
      const text = yield* Effect.promise(() => response.text());
      return yield* fail("ollamaChat", `Ollama /api/chat returned status ${response.status}: ${text}`);
    }
    const json = (yield* Effect.promise(() => response.json())) as Record<string, unknown>;
    if (
      typeof json.model !== "string" ||
      typeof json.message !== "object" || !json.message ||
      typeof (json.message as Record<string, unknown>).role !== "string" ||
      typeof json.done !== "boolean"
    ) {
      return yield* fail("ollamaChat", "Ollama /api/chat returned unexpected response shape.", json);
    }
    const msgObj = json.message as Record<string, unknown>;
    const createdAt = (json.created_at ?? json.createdAt ?? "") as string;
    const doneReason = (json.done_reason ?? json.doneReason) as string | undefined;
    const totalDuration = (json.total_duration ?? json.totalDuration) as number | undefined;
    return {
      model: json.model as string,
      createdAt,
      message: {
        role: msgObj.role as OllamaChatRole,
        content: (msgObj.content ?? "") as string,
        ...(Array.isArray(msgObj.tool_calls) ? { tool_calls: msgObj.tool_calls as readonly OllamaToolCall[] } : {}),
      },
      done: json.done as boolean,
      ...(typeof doneReason === "string" ? { doneReason } : {}),
      ...(typeof totalDuration === "number" ? { totalDuration } : {}),
    } satisfies OllamaChatResponse;
  });

// ── Streaming chat (SSE via fetch) ─────────────────────────────────────

export const ollamaChatStream = (input: {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly model: string;
  readonly messages: ReadonlyArray<OllamaChatMessage>;
  readonly tools?: ReadonlyArray<OllamaToolDefinition>;
  readonly options?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}): Stream.Stream<OllamaChatChunk, OllamaRuntimeError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const body = {
        model: input.model,
        messages: [...input.messages],
        stream: true,
        ...(input.tools && input.tools.length > 0 ? { tools: [...input.tools] } : {}),
        ...(input.options ? { options: input.options } : {}),
      };
      let responseBody: ReadableStream<Uint8Array>;
      try {
        const response = yield* Effect.promise(() =>
          fetch(`${input.baseUrl}/api/chat`, {
            method: "POST",
            headers: buildHeaders(input.apiKey),
            body: JSON.stringify(body),
            signal: input.signal ?? null,
          }),
        );
        if (!response.ok) {
          const text = yield* Effect.promise(() => response.text());
          return yield* fail("ollamaChatStream", `Ollama /api/chat stream returned status ${response.status}: ${text}`);
        }
        if (!response.body) {
          return yield* fail("ollamaChatStream", "Ollama response body is null.");
        }
        responseBody = response.body;
      } catch (cause) {
        return yield* fail("ollamaChatStream", String(cause), cause);
      }
      return Stream.fromAsyncIterable(
        lineByLine(responseBody),
        (cause) =>
          new OllamaRuntimeError({
            operation: "ollamaChatStream.parse",
            detail: String(cause),
            cause,
          }),
      ).pipe(
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Effect.try({
            try: () => JSON.parse(line) as OllamaChatChunk,
            catch: (cause) =>
              new OllamaRuntimeError({
                operation: "ollamaChatStream.parse",
                detail: `Failed to parse SSE line: ${line.slice(0, 200)}`,
                cause,
              }),
          }),
        ),
      );
    }),
  );

async function* lineByLine(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.length > 0) yield buffer;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        yield line;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Model listing ──────────────────────────────────────────────────────

export const ollamaListModels = (baseUrl: string, apiKey?: string) =>
  Effect.gen(function* () {
    let response: Response;
    try {
      response = yield* Effect.promise(() =>
        fetch(`${baseUrl}/api/tags`, { headers: buildHeaders(apiKey) }),
      );
    } catch (cause) {
      return yield* fail("ollamaListModels", String(cause), cause);
    }
    if (!response.ok) {
      const text = yield* Effect.promise(() => response.text());
      return yield* fail("ollamaListModels", `Ollama /api/tags returned status ${response.status}: ${text}`);
    }
    const json = (yield* Effect.promise(() => response.json())) as Record<string, unknown>;
    if (!json || typeof json !== "object" || !Array.isArray(json.models)) {
      return yield* fail("ollamaListModels", "Ollama /api/tags returned unexpected response shape.", json);
    }
    return (json.models as Array<Record<string, unknown>>).map((m) => ({
      name: String(m.name ?? ""),
      modifiedAt: String(m.modifiedAt ?? ""),
      size: typeof m.size === "number" ? m.size : 0,
      digest: String(m.digest ?? ""),
    })) satisfies ReadonlyArray<OllamaModelInfo>;
  });

// ── Version check ──────────────────────────────────────────────────────

export const ollamaVersion = (baseUrl: string, apiKey?: string) =>
  Effect.gen(function* () {
    try {
      const response = yield* Effect.promise(() =>
        fetch(`${baseUrl}/api/version`, { headers: buildHeaders(apiKey) }),
      );
      if (!response.ok) return "";
      const json = (yield* Effect.promise(() => response.json())) as Record<string, unknown>;
      return typeof json.version === "string" ? json.version : "";
    } catch {
      return "";
    }
  });
