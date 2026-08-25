/// <reference types="@cloudflare/workers-types" />

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  AiError,
  LanguageModel as AiLanguageModel,
  IdGenerator,
  Prompt,
  Response,
  Tool,
} from "effect/unstable/ai";
import * as Sse from "effect/unstable/encoding/Sse";
import type { RuntimeContext } from "../../RuntimeContext.ts";

/**
 * The slice of an AI client the LanguageModel adapter needs: the raw Workers
 * AI handle plus, when routed through an AI Gateway, the gateway id.
 *
 * Both `Cloudflare.AI.QueryGateway(gateway)` (gateway-routed) and
 * `Cloudflare.Workers.AI()` (plain Workers AI binding) clients satisfy it.
 */
export interface LanguageModelClient {
  /** Effect resolving to the raw Workers AI runtime binding. */
  readonly raw: Effect.Effect<Ai, never, RuntimeContext>;
  /**
   * Effect resolving to the AI Gateway id to route `ai.run` calls through.
   * Omit for a plain Workers AI binding — requests then go directly to
   * Workers AI without a gateway.
   */
  readonly id?: Effect.Effect<string, never, RuntimeContext>;
}

/**
 * Options for constructing a Workers AI-backed LanguageModel.
 */
export interface LanguageModelOptions {
  /**
   * Already-bound AI client — from `Cloudflare.AI.QueryGateway(gateway)`
   * (routed through the gateway) or `Cloudflare.Workers.AI()` (direct).
   */
  readonly client: LanguageModelClient;
  /** Workers AI model id, e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. */
  readonly model: string;
  /** Optional per-call defaults; overridable per request via `providerOptions`. */
  readonly parameters?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly topP?: number;
    readonly topK?: number;
    readonly seed?: number;
    readonly frequencyPenalty?: number;
    readonly presencePenalty?: number;
  };
}

/**
 * Provide a {@link AiLanguageModel.LanguageModel} layer backed by the supplied
 * AI Gateway client and Workers AI model.
 */
export const makeLanguageModelLayer = (
  options: LanguageModelOptions,
): Layer.Layer<AiLanguageModel.LanguageModel, never, RuntimeContext> =>
  Layer.effect(AiLanguageModel.LanguageModel, makeLanguageModel(options));

/**
 * Build a {@link AiLanguageModel.Service} that proxies generateText/streamText
 * through the supplied AI Gateway client to a Workers AI model.
 */
export const makeLanguageModel = ({
  client,
  model,
  parameters,
}: LanguageModelOptions): Effect.Effect<
  AiLanguageModel.Service,
  never,
  RuntimeContext
> =>
  Effect.gen(function* () {
    const ai = yield* client.raw;
    const gatewayId = client.id === undefined ? undefined : yield* client.id;

    const callRaw = (
      body: WorkersAiInputs,
      method: "generateText" | "streamText",
    ): Effect.Effect<Response, AiError.AiError> =>
      Effect.tryPromise({
        try: () =>
          ai.run(
            model as keyof AiModels,
            body as unknown as AiModels[keyof AiModels]["inputs"],
            {
              ...(gatewayId === undefined
                ? {}
                : { gateway: { id: gatewayId } }),
              returnRawResponse: true,
            },
          ),
        catch: (cause) => toAiError(cause, method),
      });

    return yield* AiLanguageModel.make({
      generateText: (options) =>
        Effect.gen(function* () {
          const body = toRequestBody({ options, parameters, stream: false });
          const resp = yield* callRaw(body, "generateText");
          const json = yield* Effect.tryPromise({
            try: () => resp.json() as Promise<Record<string, unknown>>,
            catch: (cause) => toAiError(cause, "generateText"),
          });
          return yield* parseGenerateText(json);
        }),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const idGen = yield* IdGenerator.IdGenerator;
            const body = toRequestBody({ options, parameters, stream: true });
            const resp = yield* callRaw(body, "streamText");
            const hasTools =
              options.tools.length > 0 && options.toolChoice !== "none";
            return parseStreamText(resp, idGen, hasTools);
          }),
        ),
    });
  });

// ---------------------------------------------------------------------------
// Wire format types (Workers AI request)
//
// Workers AI returns two response shapes depending on the model:
//   - Native:  { response: "...", tool_calls: [...] , usage }
//   - OpenAI:  { choices: [{ message: { content, tool_calls, reasoning_content } }], usage }
//
// We accept both defensively — schemas would over-constrain.
// ---------------------------------------------------------------------------

interface WorkersAiMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content?: unknown;
  readonly name?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly reasoning?: string;
}

interface WorkersAiToolDef {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: unknown;
  };
}

type WorkersAiToolChoice =
  | "auto"
  | "required"
  | "none"
  | { readonly type: "function"; readonly function: { readonly name: string } };

interface WorkersAiInputs {
  readonly messages: ReadonlyArray<WorkersAiMessage>;
  readonly tools?: ReadonlyArray<WorkersAiToolDef>;
  readonly tool_choice?: WorkersAiToolChoice;
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage: boolean };
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly random_seed?: number;
  readonly frequency_penalty?: number;
  readonly presence_penalty?: number;
}

// ---------------------------------------------------------------------------
// Prompt → Workers AI messages (pure, no .push mutation)
// ---------------------------------------------------------------------------

const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const fileToImageUrl = (
  data: string | Uint8Array | URL,
  mediaType: string,
): string => {
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) {
    return `data:${mediaType};base64,${uint8ArrayToBase64(data)}`;
  }
  if (data.startsWith("data:") || data.startsWith("http")) return data;
  return `data:${mediaType};base64,${data}`;
};

const convertPromptToMessages = (
  prompt: Prompt.Prompt,
): ReadonlyArray<WorkersAiMessage> =>
  prompt.content.flatMap((m): ReadonlyArray<WorkersAiMessage> => {
    switch (m.role) {
      case "system":
        return [{ role: "system", content: m.content }];
      case "user":
        return [toUserMessage(m.content)];
      case "assistant":
        return [toAssistantMessage(m.content)];
      case "tool":
        return m.content.flatMap(toToolMessage);
    }
  });

const toUserMessage = (
  parts: Prompt.UserMessage["content"],
): WorkersAiMessage => {
  const text = parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("\n");
  const images = parts.flatMap((p) =>
    p.type === "file"
      ? [
          {
            type: "image_url" as const,
            image_url: { url: fileToImageUrl(p.data, p.mediaType) },
          },
        ]
      : [],
  );
  if (images.length === 0) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
      ...images,
    ],
  };
};

const toAssistantMessage = (
  parts: Prompt.AssistantMessage["content"],
): WorkersAiMessage => {
  const text = parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("");
  const reasoning = parts
    .flatMap((p) => (p.type === "reasoning" ? [p.text] : []))
    .join("");
  const toolCalls = parts.flatMap((p) =>
    p.type === "tool-call"
      ? [
          {
            id: p.id,
            type: "function" as const,
            function: {
              name: p.name,
              arguments:
                typeof p.params === "string"
                  ? p.params
                  : JSON.stringify(p.params ?? {}),
            },
          },
        ]
      : [],
  );
  return {
    role: "assistant",
    content: text,
    ...(reasoning ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
};

const toToolMessage = (
  part: Prompt.ToolMessage["content"][number],
): ReadonlyArray<WorkersAiMessage> =>
  part.type === "tool-result"
    ? [
        {
          role: "tool",
          name: part.name,
          tool_call_id: part.id,
          content:
            typeof part.result === "string"
              ? part.result
              : JSON.stringify(part.result),
        },
      ]
    : [];

// ---------------------------------------------------------------------------
// Tools / tool_choice
// ---------------------------------------------------------------------------

const prepareTools = (
  tools: ReadonlyArray<Tool.Any>,
  toolChoice: AiLanguageModel.ProviderOptions["toolChoice"],
): {
  tools?: ReadonlyArray<WorkersAiToolDef>;
  tool_choice?: WorkersAiToolChoice;
} => {
  if (tools.length === 0) return {};
  const mapped: ReadonlyArray<WorkersAiToolDef> = tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: Tool.getDescription(tool),
      parameters: Tool.getJsonSchema(tool),
    },
  }));

  if (toolChoice === "auto" || toolChoice == null) {
    return { tools: mapped, tool_choice: "auto" };
  }
  if (toolChoice === "none") return { tools: mapped, tool_choice: "none" };
  if (toolChoice === "required") {
    return { tools: mapped, tool_choice: "required" };
  }
  if (typeof toolChoice === "object" && "tool" in toolChoice) {
    return {
      tools: mapped.filter((t) => t.function.name === toolChoice.tool),
      tool_choice: "required",
    };
  }
  if (typeof toolChoice === "object" && "oneOf" in toolChoice) {
    const allowed = new Set(toolChoice.oneOf);
    return {
      tools: mapped.filter((t) => allowed.has(t.function.name)),
      tool_choice: toolChoice.mode === "required" ? "required" : "auto",
    };
  }
  return { tools: mapped, tool_choice: "auto" };
};

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const toRequestBody = ({
  options,
  parameters,
  stream,
}: {
  readonly options: AiLanguageModel.ProviderOptions;
  readonly parameters: LanguageModelOptions["parameters"];
  readonly stream: boolean;
}): WorkersAiInputs => {
  const messages = convertPromptToMessages(options.prompt);
  const { tools, tool_choice } = prepareTools(
    options.tools,
    options.toolChoice,
  );
  return {
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(tool_choice !== undefined ? { tool_choice } : {}),
    // `stream_options.include_usage` is the OpenAI-compatible opt-in for
    // usage tokens to appear in the final streamed chunk. Without it most
    // Workers AI models omit `usage` from the stream entirely, leaving the
    // `finish` part with zeroed counts.
    ...(stream
      ? { stream: true, stream_options: { include_usage: true } }
      : {}),
    ...(parameters?.maxTokens !== undefined
      ? { max_tokens: parameters.maxTokens }
      : {}),
    ...(parameters?.temperature !== undefined
      ? { temperature: parameters.temperature }
      : {}),
    ...(parameters?.topP !== undefined ? { top_p: parameters.topP } : {}),
    ...(parameters?.topK !== undefined ? { top_k: parameters.topK } : {}),
    ...(parameters?.seed !== undefined ? { random_seed: parameters.seed } : {}),
    ...(parameters?.frequencyPenalty !== undefined
      ? { frequency_penalty: parameters.frequencyPenalty }
      : {}),
    ...(parameters?.presencePenalty !== undefined
      ? { presence_penalty: parameters.presencePenalty }
      : {}),
  };
};

// ---------------------------------------------------------------------------
// Finish reason / usage mapping
// ---------------------------------------------------------------------------

const mapFinishReason = (raw: unknown): Response.FinishReason => {
  switch (raw) {
    case "stop":
      return "stop";
    case "length":
    case "model_length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    case "content_filter":
    case "content-filter":
      return "content-filter";
    case "error":
      return "error";
    case undefined:
    case null:
      return "unknown";
    default:
      return "other";
  }
};

const mapUsage = (raw: Record<string, unknown> | undefined): Response.Usage => {
  const usage = (raw?.usage as Record<string, unknown> | undefined) ?? {};
  const promptTokens = (usage.prompt_tokens as number | undefined) ?? 0;
  const completionTokens = (usage.completion_tokens as number | undefined) ?? 0;
  const cached = (
    usage.prompt_tokens_details as { cached_tokens?: number } | undefined
  )?.cached_tokens;
  // Construct an actual `Response.Usage` instance — `Schema.Class<Usage>`
  // encodes by going through the class constructor / `isInstance` check, so a
  // plain struct that "matches" the encoded shape isn't enough.
  return new Response.Usage({
    inputTokens: {
      uncached:
        cached !== undefined
          ? Math.max(0, promptTokens - cached)
          : promptTokens,
      total: promptTokens,
      cacheRead: cached ?? 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: completionTokens,
      text: 0,
      reasoning: 0,
    },
  });
};

// ---------------------------------------------------------------------------
// generateText: JSON → Response.PartEncoded[]
//
// Normalize the dual-shape (native + OpenAI) response into a single
// `DecodedResponse` once, then build the part list with pure spreads.
// ---------------------------------------------------------------------------

interface DecodedToolCall {
  readonly rawId: string;
  readonly name: string;
  readonly arguments: unknown;
}

interface DecodedResponse {
  readonly text: string | undefined;
  readonly reasoning: string | undefined;
  readonly toolCalls: ReadonlyArray<DecodedToolCall>;
  readonly finishReason: string | undefined;
}

const decodeResponse = (raw: Record<string, unknown>): DecodedResponse => {
  const choice = (
    raw.choices as
      | Array<{
          message?: {
            content?: string | null;
            reasoning_content?: string;
            reasoning?: string;
            tool_calls?: ReadonlyArray<Record<string, unknown>>;
          };
          finish_reason?: string;
        }>
      | undefined
  )?.[0];
  const message = choice?.message;

  const openAiText = message?.content;
  const text =
    typeof openAiText === "string" && openAiText.length > 0
      ? openAiText
      : nativeTextOf(raw.response);
  const reasoning = message?.reasoning_content ?? message?.reasoning;
  const rawToolCalls =
    message?.tool_calls ??
    (Array.isArray(raw.tool_calls)
      ? (raw.tool_calls as ReadonlyArray<Record<string, unknown>>)
      : []);

  return {
    text,
    reasoning: reasoning && reasoning.length > 0 ? reasoning : undefined,
    toolCalls: rawToolCalls.flatMap(decodeToolCall),
    finishReason:
      choice?.finish_reason ?? (raw.finish_reason as string | undefined),
  };
};

const nativeTextOf = (raw: unknown): string | undefined => {
  if (raw == null) return undefined;
  if (typeof raw === "object") return JSON.stringify(raw);
  const text = String(raw);
  return text.length > 0 ? text : undefined;
};

const decodeToolCall = (
  tc: Record<string, unknown>,
): ReadonlyArray<DecodedToolCall> => {
  const fn = tc.function as { name?: string; arguments?: unknown } | undefined;
  const rawId = (tc.id as string | undefined) ?? "";
  if (fn?.name) {
    return [{ rawId, name: fn.name, arguments: fn.arguments ?? "" }];
  }
  const flatName = tc.name as string | undefined;
  if (flatName) {
    return [{ rawId, name: flatName, arguments: tc.arguments ?? "" }];
  }
  return [];
};

const tryParseJsonArgs = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    // Leave as raw string; the framework's tool-result decoder will fail loudly.
    return raw;
  }
};

const parseGenerateText = Effect.fn(function* (raw: Record<string, unknown>) {
  const idGen = yield* IdGenerator.IdGenerator;
  const decoded = decodeResponse(raw);

  const toolCallParts = yield* Effect.forEach(decoded.toolCalls, (tc) =>
    Effect.gen(function* () {
      const id = tc.rawId || (yield* idGen.generateId());
      return {
        type: "tool-call" as const,
        id,
        name: tc.name,
        params: tryParseJsonArgs(tc.arguments),
      };
    }),
  );

  const finish = mapFinishReason(
    decoded.finishReason ??
      (decoded.toolCalls.length > 0 ? "tool_calls" : "stop"),
  );

  return [
    ...(decoded.reasoning !== undefined
      ? [{ type: "reasoning" as const, text: decoded.reasoning }]
      : []),
    ...(decoded.text !== undefined && decoded.text.length > 0
      ? [{ type: "text" as const, text: decoded.text }]
      : []),
    ...toolCallParts,
    {
      type: "finish" as const,
      reason: finish,
      usage: mapUsage(raw),
      response: undefined,
    },
  ] satisfies ReadonlyArray<Response.PartEncoded>;
});

// ---------------------------------------------------------------------------
// streamText: SSE byte stream → Stream<Response.StreamPartEncoded>
//
// Immutable `StreamState` is threaded through `Stream.mapAccumEffect`. The
// per-chunk output buffer (`parts: Array<StreamPartEncoded>`) is mutable for
// performance — it's scoped to one chunk, never escapes the handler, and lets
// us avoid the O(n²) array-spread that pure threading would force in the hot
// path. This matches the pattern Effect's own `@effect/ai-*` adapters use.
// ---------------------------------------------------------------------------

interface StreamState {
  readonly textId: string | undefined;
  readonly reasoningId: string | undefined;
  readonly toolCalls: ReadonlyMap<
    number,
    { readonly id: string; readonly name: string; readonly arguments: string }
  >;
  readonly lastToolIndex: number | undefined;
  readonly closedToolIndices: ReadonlySet<number>;
  readonly usage: Record<string, unknown> | undefined;
  readonly finishReason: string | undefined;
  readonly receivedAnyData: boolean;
  readonly receivedDone: boolean;
  // Workers AI's *native* streaming for function-calling models (e.g.
  // `@cf/meta/llama-3.3-70b`) does not emit structured `tool_calls` deltas
  // — it streams the call as a JSON document inside the `response` text
  // field (`{"name":"get_weather","parameters":{...}}`). When tools were
  // requested we buffer that text here instead of emitting it as
  // text-delta, then parse it into tool-params parts on finalize.
  readonly nativeToolBuffer: string;
  readonly nativeToolId: string | undefined;
}

const initialStreamState = (): StreamState => ({
  textId: undefined,
  reasoningId: undefined,
  toolCalls: new Map(),
  lastToolIndex: undefined,
  closedToolIndices: new Set(),
  usage: undefined,
  finishReason: undefined,
  receivedAnyData: false,
  receivedDone: false,
  nativeToolBuffer: "",
  nativeToolId: undefined,
});

type StreamParts = Array<Response.StreamPartEncoded>;

const tryParseJson = (data: string): Record<string, unknown> | undefined => {
  try {
    const v = JSON.parse(data);
    return v && typeof v === "object"
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const isNullFinalizationToolCall = (tc: Record<string, unknown>): boolean => {
  const fn = tc.function as Record<string, unknown> | undefined;
  const name = fn?.name ?? tc.name ?? null;
  const args = fn?.arguments ?? tc.arguments ?? null;
  const id = tc.id ?? null;
  return !id && !name && (!args || args === "");
};

const closeReasoning = (
  state: StreamState,
  parts: StreamParts,
): StreamState => {
  if (state.reasoningId === undefined) return state;
  parts.push({ type: "reasoning-end", id: state.reasoningId });
  return { ...state, reasoningId: undefined };
};

const closeToolCall = (
  state: StreamState,
  index: number,
  parts: StreamParts,
): StreamState => {
  if (state.closedToolIndices.has(index)) return state;
  const tc = state.toolCalls.get(index);
  if (!tc) return state;
  parts.push({ type: "tool-params-end", id: tc.id });
  const closed = new Set(state.closedToolIndices);
  closed.add(index);
  return { ...state, closedToolIndices: closed };
};

const emitTextDelta = (
  state: StreamState,
  delta: string,
  parts: StreamParts,
  idGen: IdGenerator.Service,
): Effect.Effect<StreamState> =>
  Effect.gen(function* () {
    let s = closeReasoning(state, parts);
    if (s.textId === undefined) {
      const id = yield* idGen.generateId();
      parts.push({ type: "text-start", id });
      s = { ...s, textId: id };
    }
    parts.push({ type: "text-delta", id: s.textId!, delta });
    return s;
  });

const emitReasoningDelta = (
  state: StreamState,
  delta: string,
  parts: StreamParts,
  idGen: IdGenerator.Service,
): Effect.Effect<StreamState> =>
  Effect.gen(function* () {
    let s = state;
    if (s.reasoningId === undefined) {
      const id = yield* idGen.generateId();
      parts.push({ type: "reasoning-start", id });
      s = { ...s, reasoningId: id };
    }
    parts.push({ type: "reasoning-delta", id: s.reasoningId!, delta });
    return s;
  });

const handleToolDeltas = (
  state: StreamState,
  deltas: ReadonlyArray<Record<string, unknown>>,
  parts: StreamParts,
  idGen: IdGenerator.Service,
): Effect.Effect<StreamState> =>
  Effect.gen(function* () {
    let s = state;
    for (const d of deltas) {
      if (isNullFinalizationToolCall(d)) {
        if (s.lastToolIndex !== undefined) {
          s = closeToolCall(s, s.lastToolIndex, parts);
        }
        continue;
      }
      const idx = (d.index as number | undefined) ?? 0;
      const fn = d.function as
        | { name?: string; arguments?: string }
        | undefined;
      const name = fn?.name ?? (d.name as string | undefined) ?? "";
      const args = fn?.arguments ?? (d.arguments as string | undefined) ?? "";
      const rawId = (d.id as string | undefined) ?? "";

      const existing = s.toolCalls.get(idx);
      if (existing === undefined) {
        if (s.lastToolIndex !== undefined && s.lastToolIndex !== idx) {
          s = closeToolCall(s, s.lastToolIndex, parts);
        }
        const id = rawId || (yield* idGen.generateId());
        const entry = { id, name, arguments: args };
        const next = new Map(s.toolCalls);
        next.set(idx, entry);
        s = { ...s, toolCalls: next, lastToolIndex: idx };
        parts.push({ type: "tool-params-start", id, name });
        if (args.length > 0) {
          parts.push({ type: "tool-params-delta", id, delta: args });
        }
      } else {
        // OpenAI-compatible providers stream argument fragments, while
        // Workers AI can resend the complete accumulated JSON on every
        // chunk. Normalize both shapes to incremental deltas.
        const delta = args.startsWith(existing.arguments)
          ? args.slice(existing.arguments.length)
          : args;
        const accumulated = args.startsWith(existing.arguments)
          ? args
          : existing.arguments + args;
        const next = new Map(s.toolCalls);
        next.set(idx, { ...existing, arguments: accumulated });
        s = { ...s, toolCalls: next, lastToolIndex: idx };
        if (delta.length > 0) {
          parts.push({
            type: "tool-params-delta",
            id: existing.id,
            delta,
          });
        }
      }
    }
    return s;
  });

const hasNonZeroUsage = (raw: unknown): boolean => {
  if (raw == null || typeof raw !== "object") return false;
  const u = raw as Record<string, unknown>;
  const prompt = (u.prompt_tokens as number | undefined) ?? 0;
  const completion = (u.completion_tokens as number | undefined) ?? 0;
  const total = (u.total_tokens as number | undefined) ?? 0;
  return prompt > 0 || completion > 0 || total > 0;
};

const updateChunkMeta = (
  state: StreamState,
  chunk: Record<string, unknown>,
): StreamState => {
  let s = state;
  // Workers AI's native stream emits the real usage chunk, then a
  // "zero-valued terminator" chunk where every count is 0 (it also re-emits
  // `usage` with all zeros). Treat the zero chunk as a no-op so we keep the
  // meaningful counts.
  if (chunk.usage !== undefined && hasNonZeroUsage(chunk.usage)) {
    s = { ...s, usage: chunk };
  }
  const choices = chunk.choices as
    | Array<{ finish_reason?: string }>
    | undefined;
  const finish =
    choices?.[0]?.finish_reason ?? (chunk.finish_reason as string | undefined);
  if (finish != null) s = { ...s, finishReason: finish };
  return s;
};

const handleNativeText = (
  state: StreamState,
  chunk: Record<string, unknown>,
  parts: StreamParts,
  idGen: IdGenerator.Service,
  hasTools: boolean,
): Effect.Effect<StreamState> => {
  const native = chunk.response;
  if (native == null || native === "") return Effect.succeed(state);
  const text =
    typeof native === "object" ? JSON.stringify(native) : String(native);
  if (text.length === 0) return Effect.succeed(state);
  // When tools were requested, the native `response` stream is the
  // tool-call JSON, not prose — buffer it and decide on finalize. We
  // pre-allocate the tool id here (we're in an Effect, finalize is sync).
  if (hasTools) {
    return Effect.gen(function* () {
      const id = state.nativeToolId ?? (yield* idGen.generateId());
      return {
        ...state,
        nativeToolId: id,
        nativeToolBuffer: state.nativeToolBuffer + text,
      };
    });
  }
  return emitTextDelta(state, text, parts, idGen);
};

const handleNativeToolCalls = (
  state: StreamState,
  chunk: Record<string, unknown>,
  parts: StreamParts,
  idGen: IdGenerator.Service,
): Effect.Effect<StreamState> => {
  const openAiToolCalls = (
    chunk.choices as
      | Array<{ delta?: { tool_calls?: ReadonlyArray<unknown> } }>
      | undefined
  )?.[0]?.delta?.tool_calls;
  // Workers AI can mirror the same fragments in both its top-level native
  // field and the OpenAI-compatible delta. Prefer the latter so every
  // fragment is emitted exactly once.
  if (Array.isArray(openAiToolCalls)) return Effect.succeed(state);
  if (!Array.isArray(chunk.tool_calls)) return Effect.succeed(state);
  return Effect.gen(function* () {
    const s = closeReasoning(state, parts);
    return yield* handleToolDeltas(
      s,
      chunk.tool_calls as ReadonlyArray<Record<string, unknown>>,
      parts,
      idGen,
    );
  });
};

const handleOpenAiDelta = (
  state: StreamState,
  chunk: Record<string, unknown>,
  parts: StreamParts,
  idGen: IdGenerator.Service,
): Effect.Effect<StreamState> => {
  const delta = (
    chunk.choices as Array<{ delta?: Record<string, unknown> }> | undefined
  )?.[0]?.delta;
  if (!delta) return Effect.succeed(state);
  return Effect.gen(function* () {
    let s = state;
    const reasoning = (delta.reasoning_content ?? delta.reasoning) as
      | string
      | undefined;
    if (reasoning && reasoning.length > 0) {
      s = yield* emitReasoningDelta(s, reasoning, parts, idGen);
    }
    const text = delta.content as string | undefined;
    if (text && text.length > 0) {
      s = yield* emitTextDelta(s, text, parts, idGen);
    }
    const toolDeltas = delta.tool_calls as
      | ReadonlyArray<Record<string, unknown>>
      | undefined;
    if (Array.isArray(toolDeltas)) {
      s = closeReasoning(s, parts);
      s = yield* handleToolDeltas(s, toolDeltas, parts, idGen);
    }
    return s;
  });
};

const handleStreamChunk = (
  state: StreamState,
  data: string,
  idGen: IdGenerator.Service,
  hasTools: boolean,
): Effect.Effect<
  readonly [StreamState, ReadonlyArray<Response.StreamPartEncoded>]
> =>
  Effect.gen(function* () {
    if (data === "") return [state, []] as const;
    if (data === "[DONE]") {
      return [{ ...state, receivedDone: true }, []] as const;
    }
    const chunk = tryParseJson(data);
    if (chunk === undefined) return [state, []] as const;

    const parts: StreamParts = [];
    let s: StreamState = { ...state, receivedAnyData: true };
    s = updateChunkMeta(s, chunk);
    s = yield* handleNativeText(s, chunk, parts, idGen, hasTools);
    s = yield* handleNativeToolCalls(s, chunk, parts, idGen);
    s = yield* handleOpenAiDelta(s, chunk, parts, idGen);
    return [s, parts] as const;
  });

/**
 * Decode a buffered native-streaming tool call. Workers AI's native shape
 * for a function call is a JSON document with `name` plus `parameters` (or
 * `arguments`), optionally wrapped in an array. Returns one entry per call,
 * or `undefined` if the buffer isn't a tool-call document (so the caller
 * can fall back to treating it as plain text).
 */
const decodeNativeToolBuffer = (
  buffer: string,
): ReadonlyArray<{ name: string; args: string }> | undefined => {
  const trimmed = buffer.trim();
  if (trimmed.length === 0 || !(trimmed[0] === "{" || trimmed[0] === "[")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const calls = items.flatMap(
    (
      item,
    ): ReadonlyArray<{
      name: string;
      args: string;
    }> => {
      if (item == null || typeof item !== "object") return [];
      const rec = item as Record<string, unknown>;
      const fn = rec.function as Record<string, unknown> | undefined;
      const name = (fn?.name ?? rec.name) as string | undefined;
      if (typeof name !== "string" || name.length === 0) return [];
      const rawArgs = fn?.arguments ?? rec.arguments ?? rec.parameters ?? {};
      const args =
        typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
      return [{ name, args }];
    },
  );
  return calls.length > 0 ? calls : undefined;
};

const flushNativeToolBuffer = (
  state: StreamState,
  parts: StreamParts,
): StreamState => {
  if (state.nativeToolBuffer.length === 0) return state;
  const calls = decodeNativeToolBuffer(state.nativeToolBuffer);
  // Not a tool-call document — the model returned prose despite tools being
  // available; surface it as text so nothing is dropped.
  if (calls === undefined) {
    const id = state.nativeToolId ?? "text-0";
    parts.push({ type: "text-start", id });
    parts.push({ type: "text-delta", id, delta: state.nativeToolBuffer });
    parts.push({ type: "text-end", id });
    return { ...state, nativeToolBuffer: "", nativeToolId: undefined };
  }
  const baseId = state.nativeToolId ?? "tool-0";
  calls.forEach((call, i) => {
    const id = i === 0 ? baseId : `${baseId}-${i}`;
    parts.push({ type: "tool-params-start", id, name: call.name });
    if (call.args.length > 0) {
      parts.push({ type: "tool-params-delta", id, delta: call.args });
    }
    parts.push({ type: "tool-params-end", id });
  });
  return { ...state, nativeToolBuffer: "", nativeToolId: undefined };
};

const finalizeStream = (
  state: StreamState,
): ReadonlyArray<Response.StreamPartEncoded> => {
  const parts: StreamParts = [];
  let s = state;
  for (const [idx] of s.toolCalls) s = closeToolCall(s, idx, parts);
  s = closeReasoning(s, parts);
  if (s.textId !== undefined) parts.push({ type: "text-end", id: s.textId });
  // Emit any buffered native-streaming tool call (llama-style) before the
  // terminal finish part.
  s = flushNativeToolBuffer(s, parts);

  // Three cases for the final reason:
  //  1. The model emitted an explicit `finish_reason`           → map it.
  //  2. The stream ended cleanly (`[DONE]` seen) but no reason  → "stop".
  //     Workers AI's native shape never includes `finish_reason`,
  //     so without this rule every native-mode stream would report
  //     `unknown` despite completing successfully.
  //  3. The stream ended abnormally (no `[DONE]`, no reason)    → "error".
  const reason: Response.FinishReason =
    s.finishReason !== undefined
      ? mapFinishReason(s.finishReason)
      : s.receivedDone
        ? "stop"
        : s.receivedAnyData
          ? "error"
          : "unknown";

  parts.push({
    type: "finish",
    reason,
    usage: mapUsage(s.usage),
    response: undefined,
  });
  return parts;
};

const parseStreamText = (
  resp: Response,
  idGen: IdGenerator.Service,
  hasTools: boolean,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => {
  const body = resp.body;
  if (body === null) {
    return Stream.fromIterable<Response.StreamPartEncoded>(
      finalizeStream(initialStreamState()),
    );
  }
  return Stream.fromReadableStream<Uint8Array, AiError.AiError>({
    evaluate: () => body,
    onError: (cause) => toAiError(cause, "streamText"),
  }).pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode<AiError.AiError, unknown>()),
    Stream.catchTag("Retry", (retry) => Stream.die(retry)),
    Stream.mapAccumEffect(
      initialStreamState,
      (state, event) => handleStreamChunk(state, event.data, idGen, hasTools),
      { onHalt: (state) => finalizeStream(state) },
    ),
  );
};

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const toAiError = (
  cause: unknown,
  method: "generateText" | "streamText",
): AiError.AiError =>
  AiError.AiError.make({
    module: "Cloudflare.AI.LanguageModel",
    method,
    reason: new AiError.UnknownError({
      description:
        cause instanceof Error ? cause.message : "AI Gateway request failed",
    }),
  });
