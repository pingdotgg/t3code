/// <reference types="@cloudflare/workers-types" />

import type { RuntimeContext } from "alchemy/RuntimeContext";
import {
  AiError,
  LanguageModel as AiLanguageModel,
  IdGenerator,
  Prompt,
  Response,
  Tool,
} from "effect/ai";
import * as Effect from "effect/Effect";
import * as Sse from "effect/encoding/Sse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
 * Build a {@link AiLanguageModel.LanguageModel} that proxies generateText/streamText
 * through the supplied AI Gateway client to a Workers AI model.
 */
export const makeLanguageModel = ({
  client,
  model,
  parameters,
}: LanguageModelOptions): Effect.Effect<AiLanguageModel.LanguageModel, never, RuntimeContext> =>
  Effect.gen(function* () {
    const ai = yield* client.raw;
    const gatewayId = client.id === undefined ? undefined : yield* client.id;
    const startsInThink = THINK_PREFILLED_MODELS.has(model);

    const callRaw = (
      body: WorkersAiInputs,
      method: "generateText" | "streamText",
    ): Effect.Effect<Response, AiError.AiError> =>
      Effect.tryPromise({
        try: () =>
          ai.run(model as keyof AiModels, body as unknown as AiModels[keyof AiModels]["inputs"], {
            ...(gatewayId === undefined ? {} : { gateway: { id: gatewayId } }),
            returnRawResponse: true,
          }),
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
          return yield* parseGenerateText(json, startsInThink);
        }),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const idGen = yield* IdGenerator.IdGenerator;
            const body = toRequestBody({ options, parameters, stream: true });
            const resp = yield* callRaw(body, "streamText");
            const hasTools = options.tools.length > 0 && options.toolChoice !== "none";
            return parseStreamText(resp, idGen, hasTools, startsInThink);
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
  // Keep older Workers and no_nodejs_compat deployments working without a
  // Node import. The native web API encodes only this view's byte range.
  const toBase64 = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof toBase64 === "function") return toBase64.call(bytes);

  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const fileToImageUrl = (data: string | Uint8Array | URL, mediaType: string): string => {
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) {
    return `data:${mediaType};base64,${uint8ArrayToBase64(data)}`;
  }
  if (data.startsWith("data:") || data.startsWith("http")) return data;
  return `data:${mediaType};base64,${data}`;
};

const convertPromptToMessages = (prompt: Prompt.Prompt): ReadonlyArray<WorkersAiMessage> =>
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

const toUserMessage = (parts: Prompt.UserMessage["content"]): WorkersAiMessage => {
  const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
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
    content: [...(text.length > 0 ? [{ type: "text" as const, text }] : []), ...images],
  };
};

const toAssistantMessage = (parts: Prompt.AssistantMessage["content"]): WorkersAiMessage => {
  const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  const reasoning = parts.flatMap((p) => (p.type === "reasoning" ? [p.text] : [])).join("");
  const toolCalls = parts.flatMap((p) =>
    p.type === "tool-call"
      ? [
          {
            id: p.id,
            type: "function" as const,
            function: {
              name: p.name,
              arguments: typeof p.params === "string" ? p.params : JSON.stringify(p.params ?? {}),
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
          content: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
        },
      ]
    : [];

// ---------------------------------------------------------------------------
// Tools / tool_choice
// ---------------------------------------------------------------------------

type PreparedToolSchema = {
  readonly schema: Tool.Any["parametersSchema"];
  readonly ast: Tool.Any["parametersSchema"]["ast"];
  readonly json: ReturnType<typeof Tool.getJsonSchema>;
};

// Tools and Effect schemas expose immutable update methods. Still check both
// identities: JavaScript callers can replace a tool's schema in place. Dynamic
// JSON schemas remain caller-owned and may change without an identity change.
const preparedToolSchemas = new WeakMap<Tool.Any, PreparedToolSchema>();

const prepareTool = (tool: Tool.Any): WorkersAiToolDef => {
  let parameters: ReturnType<typeof Tool.getJsonSchema>;
  if (Tool.isDynamic(tool) && tool.jsonSchema !== undefined) {
    parameters = Tool.getJsonSchema(tool);
  } else {
    const schema = tool.parametersSchema;
    let cached = preparedToolSchemas.get(tool);
    if (cached === undefined || cached.schema !== schema || cached.ast !== schema.ast) {
      cached = { schema, ast: schema.ast, json: Tool.getJsonSchema(tool) };
      preparedToolSchemas.set(tool, cached);
    }
    // Each request previously owned its compiled schema. Keep that isolation
    // if the runtime client mutates request input, without recompiling it.
    parameters = structuredClone(cached.json);
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: Tool.getDescription(tool),
      parameters,
    },
  };
};

const prepareTools = (
  tools: ReadonlyArray<Tool.Any>,
  toolChoice: AiLanguageModel.ProviderOptions["toolChoice"],
): {
  tools?: ReadonlyArray<WorkersAiToolDef>;
  tool_choice?: WorkersAiToolChoice;
} => {
  if (tools.length === 0) return {};
  if (toolChoice != null && typeof toolChoice === "object" && "tool" in toolChoice) {
    return {
      tools: tools.filter((tool) => tool.name === toolChoice.tool).map(prepareTool),
      tool_choice: "required",
    };
  }
  if (toolChoice != null && typeof toolChoice === "object" && "oneOf" in toolChoice) {
    const allowed = new Set(toolChoice.oneOf);
    return {
      tools: tools.filter((tool) => allowed.has(tool.name)).map(prepareTool),
      tool_choice: toolChoice.mode === "required" ? "required" : "auto",
    };
  }
  return {
    tools: tools.map(prepareTool),
    tool_choice: toolChoice === "none" || toolChoice === "required" ? toolChoice : "auto",
  };
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
  const { tools, tool_choice } = prepareTools(options.tools, options.toolChoice);
  return {
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(tool_choice !== undefined ? { tool_choice } : {}),
    // `stream_options.include_usage` is the OpenAI-compatible opt-in for
    // usage tokens to appear in the final streamed chunk. Without it most
    // Workers AI models omit `usage` from the stream entirely, leaving the
    // `finish` part with zeroed counts.
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...(parameters?.maxTokens !== undefined ? { max_tokens: parameters.maxTokens } : {}),
    ...(parameters?.temperature !== undefined ? { temperature: parameters.temperature } : {}),
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

const finishMetadata = (
  raw: Record<string, unknown> | undefined,
): { readonly metadata?: Response.FinishPartMetadata } => {
  const neurons = (raw?.usage as Record<string, unknown> | undefined)?.neurons;
  return typeof neurons === "number" && Number.isFinite(neurons)
    ? { metadata: { cloudflare: { neurons } } }
    : {};
};

/**
 * The neurons Workers AI billed for a response, read from its finish part.
 * Workers AI reports this as `usage.neurons`; the adapter carries it on the
 * finish part as `metadata.cloudflare.neurons`. `undefined` when the model
 * did not report it.
 *
 * @example
 * ```typescript
 * const response = yield* LanguageModel.generateText({ prompt });
 * const finish = response.content.find((part) => part.type === "finish");
 * const neurons = finish ? Cloudflare.AI.finishNeurons(finish) : undefined;
 * ```
 */
export const finishNeurons = (part: {
  readonly metadata: Response.FinishPartMetadata;
}): number | undefined =>
  Option.getOrUndefined(Option.map(decodeNeurons(part.metadata), (m) => m.cloudflare.neurons));

const decodeNeurons = Schema.decodeUnknownOption(
  Schema.Struct({ cloudflare: Schema.Struct({ neurons: Schema.Number }) }),
);

const mapUsage = (raw: Record<string, unknown> | undefined): Response.Usage => {
  const usage = (raw?.usage as Record<string, unknown> | undefined) ?? {};
  const promptTokens = (usage.prompt_tokens as number | undefined) ?? 0;
  const completionTokens = (usage.completion_tokens as number | undefined) ?? 0;
  const cached = (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)
    ?.cached_tokens;
  // Construct an actual `Response.Usage` instance — `Schema.Class<Usage>`
  // encodes by going through the class constructor / `isInstance` check, so a
  // plain struct that "matches" the encoded shape isn't enough.
  return Response.Usage.make({
    inputTokens: {
      uncached: cached !== undefined ? Math.max(0, promptTokens - cached) : promptTokens,
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
// Inline reasoning
//
// Some models (e.g. `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`) write
// their chain of thought into the text itself, as `<think>…</think>`
// followed by the answer. Others (e.g. `@cf/qwen/qwq-32b`) have a chat
// template that pre-opens `<think>`, so only the closing tag is generated.
// `splitThink` incrementally routes text before `</think>` to reasoning and
// the rest to text, holding back any suffix that could be a split tag.
// ---------------------------------------------------------------------------

/**
 * Models whose chat template opens the `<think>` block in the prompt, so
 * their output starts inside reasoning and only `</think>` is generated.
 */
const THINK_PREFILLED_MODELS: ReadonlySet<string> = new Set(["@cf/qwen/qwq-32b"]);

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

interface ThinkState {
  /**
   * - `pending`: no non-whitespace text yet; a leading `<think>` opens reasoning
   * - `inside`: inside the `<think>` block
   * - `after`: just closed the block; drop the whitespace separating the answer
   * - `outside`: plain text
   */
  readonly mode: "pending" | "inside" | "after" | "outside";
  /** Held-back text that may be the start of a tag split across chunks. */
  readonly carry: string;
}

const initialThinkState = (startsInThink: boolean): ThinkState => ({
  mode: startsInThink ? "inside" : "pending",
  carry: "",
});

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
const partialTagSuffix = (s: string, tag: string): number => {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
};

const splitThink = (
  state: ThinkState,
  input: string,
): { readonly state: ThinkState; readonly reasoning: string; readonly text: string } => {
  let buf = state.carry + input;
  let mode = state.mode;
  let reasoning = "";
  while (true) {
    switch (mode) {
      case "pending": {
        const trimmed = buf.trimStart();
        if (trimmed.startsWith(THINK_OPEN)) {
          buf = trimmed.slice(THINK_OPEN.length);
          mode = "inside";
          continue;
        }
        if (THINK_OPEN.startsWith(trimmed)) {
          return { state: { mode, carry: buf }, reasoning, text: "" };
        }
        mode = "outside";
        continue;
      }
      case "inside": {
        const end = buf.indexOf(THINK_CLOSE);
        if (end >= 0) {
          reasoning += buf.slice(0, end);
          buf = buf.slice(end + THINK_CLOSE.length);
          mode = "after";
          continue;
        }
        const held = partialTagSuffix(buf, THINK_CLOSE);
        reasoning += buf.slice(0, buf.length - held);
        return { state: { mode, carry: buf.slice(buf.length - held) }, reasoning, text: "" };
      }
      case "after": {
        buf = buf.trimStart();
        if (buf.length === 0) return { state: { mode, carry: "" }, reasoning, text: "" };
        mode = "outside";
        continue;
      }
      case "outside":
        return { state: { mode, carry: "" }, reasoning, text: buf };
    }
  }
};

/**
 * Split a complete response text. A `</think>` with no opening tag means the
 * template pre-opened the block, so everything before it is reasoning.
 */
const splitThinkText = (
  text: string,
  startsInThink: boolean,
): { readonly reasoning: string; readonly text: string } => {
  const prefilled =
    startsInThink || (text.includes(THINK_CLOSE) && !text.trimStart().startsWith(THINK_OPEN));
  const split = splitThink(initialThinkState(prefilled), text);
  return split.state.mode === "inside"
    ? { reasoning: split.reasoning + split.state.carry, text: split.text }
    : { reasoning: split.reasoning, text: split.text + split.state.carry };
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
    finishReason: choice?.finish_reason ?? (raw.finish_reason as string | undefined),
  };
};

const nativeTextOf = (raw: unknown): string | undefined => {
  if (raw == null) return undefined;
  // Workers AI responses are JSON-decoded, so JSON.stringify matches
  // String() for every scalar and serializes objects/arrays.
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return text.length > 0 ? text : undefined;
};

const decodeToolCall = (tc: Record<string, unknown>): ReadonlyArray<DecodedToolCall> => {
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

const parseGenerateText = Effect.fn(function* (
  raw: Record<string, unknown>,
  startsInThink: boolean,
) {
  const idGen = yield* IdGenerator.IdGenerator;
  const decoded = decodeResponse(raw);
  const inline =
    decoded.text === undefined ? undefined : splitThinkText(decoded.text, startsInThink);
  const reasoning = [decoded.reasoning, inline?.reasoning]
    .filter((r): r is string => r !== undefined && r.length > 0)
    .join("");
  const text = inline?.text ?? decoded.text;

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
    decoded.finishReason ?? (decoded.toolCalls.length > 0 ? "tool_calls" : "stop"),
  );

  return [
    ...(reasoning.length > 0 ? [{ type: "reasoning" as const, text: reasoning }] : []),
    ...(text !== undefined && text.length > 0 ? [{ type: "text" as const, text }] : []),
    ...toolCallParts,
    {
      type: "finish" as const,
      reason: finish,
      usage: mapUsage(raw),
      response: undefined,
      ...finishMetadata(raw),
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
  readonly think: ThinkState;
}

const initialStreamState = (startsInThink: boolean): StreamState => ({
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
  think: initialThinkState(startsInThink),
});

type StreamParts = Array<Response.StreamPartEncoded>;

const tryParseJson = (data: string): Record<string, unknown> | undefined => {
  try {
    const v = JSON.parse(data);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
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

const closeReasoning = (state: StreamState, parts: StreamParts): StreamState => {
  if (state.reasoningId === undefined) return state;
  parts.push({ type: "reasoning-end", id: state.reasoningId });
  return { ...state, reasoningId: undefined };
};

const closeToolCall = (state: StreamState, index: number, parts: StreamParts): StreamState => {
  if (state.closedToolIndices.has(index)) return state;
  const tc = state.toolCalls.get(index);
  if (!tc) return state;
  parts.push({ type: "tool-params-end", id: tc.id });
  parts.push({
    type: "tool-call",
    id: tc.id,
    name: tc.name,
    params: tryParseJsonArgs(tc.arguments),
  });
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
      const fn = d.function as { name?: string; arguments?: string } | undefined;
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
        const accumulated = args.startsWith(existing.arguments) ? args : existing.arguments + args;
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

const updateChunkMeta = (state: StreamState, chunk: Record<string, unknown>): StreamState => {
  let s = state;
  // Workers AI's native stream emits the real usage chunk, then a
  // "zero-valued terminator" chunk where every count is 0 (it also re-emits
  // `usage` with all zeros). Treat the zero chunk as a no-op so we keep the
  // meaningful counts.
  if (chunk.usage !== undefined && hasNonZeroUsage(chunk.usage)) {
    s = { ...s, usage: chunk };
  }
  const choices = chunk.choices as Array<{ finish_reason?: string }> | undefined;
  const finish = choices?.[0]?.finish_reason ?? (chunk.finish_reason as string | undefined);
  if (finish != null) s = { ...s, finishReason: finish };
  return s;
};

/**
 * Route a text fragment through the inline-reasoning splitter, emitting any
 * reasoning it contains and returning the remaining answer text.
 */
const splitInlineReasoning = (
  state: StreamState,
  input: string,
  parts: StreamParts,
  idGen: IdGenerator.Service,
): Effect.Effect<readonly [StreamState, string]> =>
  Effect.gen(function* () {
    const split = splitThink(state.think, input);
    let s: StreamState = { ...state, think: split.state };
    if (split.reasoning.length > 0) {
      s = yield* emitReasoningDelta(s, split.reasoning, parts, idGen);
    }
    return [s, split.text] as const;
  });

const handleNativeText = (
  state: StreamState,
  chunk: Record<string, unknown>,
  parts: StreamParts,
  idGen: IdGenerator.Service,
  hasTools: boolean,
): Effect.Effect<StreamState> => {
  const native = chunk.response;
  if (native == null || native === "") return Effect.succeed(state);
  const text = typeof native === "string" ? native : JSON.stringify(native);
  if (text.length === 0) return Effect.succeed(state);
  // Some models (e.g. `@cf/meta/llama-3.3-70b`) mirror every text fragment
  // in both the native `response` field and the OpenAI-compatible delta of
  // the same chunk. Prefer the latter so the text is neither emitted nor
  // buffered twice.
  const openAiContent = (chunk.choices as Array<{ delta?: { content?: unknown } }> | undefined)?.[0]
    ?.delta?.content;
  if (openAiContent === text) return Effect.succeed(state);
  return Effect.gen(function* () {
    const [s, answer] = yield* splitInlineReasoning(state, text, parts, idGen);
    if (answer.length === 0) return s;
    // When tools were requested, the native `response` stream is the
    // tool-call JSON, not prose — buffer it and decide on finalize. We
    // pre-allocate the tool id here (we're in an Effect, finalize is sync).
    if (hasTools) {
      const id = s.nativeToolId ?? (yield* idGen.generateId());
      return {
        ...s,
        nativeToolId: id,
        nativeToolBuffer: s.nativeToolBuffer + answer,
      };
    }
    return yield* emitTextDelta(s, answer, parts, idGen);
  });
};

const handleNativeToolCalls = (
  state: StreamState,
  chunk: Record<string, unknown>,
  parts: StreamParts,
  idGen: IdGenerator.Service,
): Effect.Effect<StreamState> => {
  const openAiToolCalls = (
    chunk.choices as Array<{ delta?: { tool_calls?: ReadonlyArray<unknown> } }> | undefined
  )?.[0]?.delta?.tool_calls;
  // Workers AI can mirror the same fragments in both its top-level native
  // field and the OpenAI-compatible delta. Prefer the latter so every
  // fragment is emitted exactly once.
  if (Array.isArray(openAiToolCalls)) return Effect.succeed(state);
  // Workers AI attaches an empty `tool_calls: []` to ordinary chunks;
  // treating it as a tool delta would close the open reasoning block on
  // every chunk.
  if (!Array.isArray(chunk.tool_calls) || chunk.tool_calls.length === 0) {
    return Effect.succeed(state);
  }
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
  const delta = (chunk.choices as Array<{ delta?: Record<string, unknown> }> | undefined)?.[0]
    ?.delta;
  if (!delta) return Effect.succeed(state);
  return Effect.gen(function* () {
    let s = state;
    const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
    if (reasoning && reasoning.length > 0) {
      s = yield* emitReasoningDelta(s, reasoning, parts, idGen);
    }
    const text = delta.content as string | undefined;
    if (text && text.length > 0) {
      const [next, answer] = yield* splitInlineReasoning(s, text, parts, idGen);
      s = answer.length > 0 ? yield* emitTextDelta(next, answer, parts, idGen) : next;
    }
    const toolDeltas = delta.tool_calls as ReadonlyArray<Record<string, unknown>> | undefined;
    if (Array.isArray(toolDeltas) && toolDeltas.length > 0) {
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
): Effect.Effect<readonly [StreamState, ReadonlyArray<Response.StreamPartEncoded>]> =>
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
      const args = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
      return [{ name, args }];
    },
  );
  return calls.length > 0 ? calls : undefined;
};

const flushNativeToolBuffer = (state: StreamState, parts: StreamParts): StreamState => {
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
    parts.push({ type: "tool-call", id, name: call.name, params: tryParseJsonArgs(call.args) });
  });
  return { ...state, nativeToolBuffer: "", nativeToolId: undefined };
};

/**
 * Emit text the inline-reasoning splitter held back as a possible split tag
 * when the stream ended before it resolved.
 */
const flushThinkCarry = (state: StreamState, parts: StreamParts): StreamState => {
  const { mode, carry } = state.think;
  let s: StreamState = { ...state, think: { mode, carry: "" } };
  if (carry.length === 0) return s;
  if (mode === "inside") {
    if (s.reasoningId === undefined) {
      parts.push({ type: "reasoning-start", id: "reasoning-0" });
      s = { ...s, reasoningId: "reasoning-0" };
    }
    parts.push({ type: "reasoning-delta", id: s.reasoningId!, delta: carry });
    return s;
  }
  if (carry.trim().length === 0) return s;
  s = closeReasoning(s, parts);
  if (s.textId === undefined) {
    parts.push({ type: "text-start", id: "text-0" });
    s = { ...s, textId: "text-0" };
  }
  parts.push({ type: "text-delta", id: s.textId!, delta: carry });
  return s;
};

const finalizeStream = (state: StreamState): ReadonlyArray<Response.StreamPartEncoded> => {
  const parts: StreamParts = [];
  let s = flushThinkCarry(state, parts);
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
    ...finishMetadata(s.usage),
  });
  return parts;
};

const parseStreamText = (
  resp: Response,
  idGen: IdGenerator.Service,
  hasTools: boolean,
  startsInThink: boolean,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => {
  const body = resp.body;
  if (body === null) {
    return Stream.fromIterable<Response.StreamPartEncoded>(
      finalizeStream(initialStreamState(startsInThink)),
    );
  }
  return Stream.fromReadableStream<Uint8Array, AiError.AiError>({
    evaluate: () => body,
    onError: (cause) => toAiError(cause, "streamText"),
  }).pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode<AiError.AiError, unknown>()),
    Stream.catchTags({
      Retry: (retry) => Stream.die(retry),
      SseError: (error) => Stream.fail(toAiError(error, "streamText")),
    }),
    Stream.mapAccumEffect(
      () => initialStreamState(startsInThink),
      (state, event) => handleStreamChunk(state, event.data, idGen, hasTools),
      { onHalt: (state) => finalizeStream(state) },
    ),
  );
};

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const toAiError = (cause: unknown, method: "generateText" | "streamText"): AiError.AiError =>
  AiError.AiError.make({
    module: "Cloudflare.AI.LanguageModel",
    method,
    reason: AiError.UnknownError.make({
      description: cause instanceof Error ? cause.message : "AI Gateway request failed",
    }),
  });
