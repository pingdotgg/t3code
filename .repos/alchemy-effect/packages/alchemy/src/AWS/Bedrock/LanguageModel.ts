import type * as bedrock from "@distilled.cloud/aws/bedrock-runtime";
import * as Context from "effect/Context";
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
import * as Binding from "../../Binding.ts";
import type { ConverseRequest } from "./Converse.ts";
import type { ConverseStreamRequest } from "./ConverseStream.ts";

/**
 * Inference parameters applied to every request made through the
 * {@link LanguageModel}. They translate to the Converse API's
 * `inferenceConfig` (plus `additionalModelRequestFields` for
 * model-specific extensions like `top_k` or reasoning budgets).
 */
export interface LanguageModelParameters {
  /**
   * Maximum number of tokens the model may generate in the response.
   */
  maxTokens?: number;
  /**
   * Sampling temperature. Lower values make the output more deterministic.
   */
  temperature?: number;
  /**
   * Nucleus-sampling probability mass.
   */
  topP?: number;
  /**
   * Sequences that stop generation when the model emits them.
   */
  stopSequences?: string[];
  /**
   * Model-specific request fields passed through verbatim as the Converse
   * API's `additionalModelRequestFields` — e.g. `{ top_k: 50 }` for
   * Anthropic models or `{ inferenceConfig: { topK: 5 } }` for Amazon Nova.
   */
  additionalModelRequestFields?: unknown;
}

/**
 * Options for constructing a Bedrock-backed Effect AI `LanguageModel`.
 */
export interface LanguageModelOptions {
  /**
   * Default inference parameters. Every field can be overridden per call
   * with {@link withModelParameters}.
   */
  parameters?: LanguageModelParameters;
}

/**
 * Per-call overrides applied with {@link withModelParameters}: any
 * {@link LanguageModelParameters} field plus the model to run the call on.
 */
export interface LanguageModelCallParameters extends LanguageModelParameters {
  /**
   * The model to run inference on for this call. Must be one of the model
   * ids the {@link LanguageModel} binding was created with (IAM is scoped to
   * exactly those).
   * @default the first bound model id
   */
  modelId?: string;
}

/**
 * Fiber-scoped {@link LanguageModelCallParameters} consulted on every
 * generateText / streamText call made through a Bedrock-backed
 * `LanguageModel`. Set it for a region of your program with
 * {@link withModelParameters}.
 */
export const CurrentModelParameters =
  Context.Reference<LanguageModelCallParameters>(
    "AWS.Bedrock.CurrentModelParameters",
    {
      defaultValue: () => ({}),
    },
  );

/**
 * Scope per-call inference parameters (and optionally the target model)
 * onto an Effect or Stream that talks to a Bedrock-backed `LanguageModel`.
 * Defined fields override the binding's construction-time `parameters`;
 * everything else falls through to those defaults.
 *
 * ```typescript
 * const response = yield* LanguageModel.generateText({ prompt }).pipe(
 *   Bedrock.withModelParameters({ temperature: 0, maxTokens: 64 }),
 * );
 * ```
 */
export const withModelParameters =
  (parameters: LanguageModelCallParameters) =>
  <S extends Effect.Effect<any, any, any> | Stream.Stream<any, any, any>>(
    self: S,
  ): S =>
    (Effect.isEffect(self)
      ? Effect.provideService(CurrentModelParameters, parameters)(self)
      : Stream.provideService(
          CurrentModelParameters,
          parameters,
        )(self as Stream.Stream<any, any, any>)) as S;

/**
 * Runtime binding that turns an Amazon Bedrock model into an
 * `effect/unstable/ai` {@link AiLanguageModel.LanguageModel} `Layer`, so any
 * Effect AI program (`LanguageModel.generateText`, `streamText`, `Chat`,
 * toolkits, ...) runs against Bedrock without code changes.
 *
 * Calls are translated to the Bedrock Converse API — Bedrock's unified
 * messages API that works across all conversational foundation models
 * (Amazon Nova, Anthropic Claude, Meta Llama, Mistral, ...) — so one binding
 * covers every model. Bind one model or a list of models: the function is
 * granted `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`
 * scoped to exactly those models, the first is the default, and runtime code
 * picks between them (and tunes inference parameters) per call with
 * {@link withModelParameters}. A model reference may be a foundation-model
 * id, a cross-region inference profile id (e.g. `us.amazon.nova-micro-v1:0`),
 * or a full Bedrock ARN.
 *
 * Model access is an account entitlement — enable the model in the Bedrock
 * console (Model access) before invoking, otherwise calls fail with
 * `AccessDeniedException`. Many newer models are only invocable through a
 * cross-region inference profile id, not their bare foundation-model id.
 *
 * ### Effect AI on Bedrock
 * **Example:** Generate Text
 * ```typescript
 * import { LanguageModel } from "effect/unstable/ai";
 *
 * // init: bind the model and get a LanguageModel Layer
 * const model = yield* Bedrock.LanguageModel("us.amazon.nova-micro-v1:0", {
 *   parameters: { maxTokens: 1024, temperature: 0.7 },
 * });
 *
 * // runtime: any Effect AI program works against Bedrock
 * const response = yield* LanguageModel.generateText({
 *   prompt: "Say hello.",
 * }).pipe(Effect.provide(model));
 * ```
 *
 * **Example:** Stream Text
 * ```typescript
 * const parts = LanguageModel.streamText({ prompt }).pipe(
 *   Stream.provide(model),
 * );
 * // parts is a Stream of text-start / text-delta / ... / finish parts
 * ```
 *
 * ### Runtime Configuration
 * **Example:** Override Parameters Per Call
 * The binding's `parameters` are only defaults — scope overrides onto any
 * call with `withModelParameters`.
 * ```typescript
 * const response = yield* LanguageModel.generateText({ prompt }).pipe(
 *   Bedrock.withModelParameters({ temperature: 0, maxTokens: 64 }),
 * );
 * ```
 *
 * **Example:** Bind Multiple Models and Pick Per Call
 * IAM access is fixed at deploy time (scoped to the bound list); which of
 * those models serves a given request is a runtime decision.
 * ```typescript
 * // init: one Layer, IAM for both models, Nova Micro is the default
 * const model = yield* Bedrock.LanguageModel([
 *   "us.amazon.nova-micro-v1:0",
 *   "us.anthropic.claude-sonnet-4-20250514-v1:0",
 * ]);
 *
 * // runtime: route this call to Claude
 * const response = yield* LanguageModel.generateText({ prompt }).pipe(
 *   Bedrock.withModelParameters({
 *     modelId: "us.anthropic.claude-sonnet-4-20250514-v1:0",
 *   }),
 * );
 * ```
 *
 * ### Tool Calling
 * **Example:** Call Tools with a Toolkit
 * ```typescript
 * import { Tool, Toolkit } from "effect/unstable/ai";
 * import * as Schema from "effect/Schema";
 *
 * const GetWeather = Tool.make("get_weather", {
 *   description: "Get the current weather for a city.",
 *   parameters: Schema.Struct({ city: Schema.String }),
 *   success: Schema.Struct({ temperatureF: Schema.Number }),
 * });
 * const WeatherToolkit = Toolkit.make(GetWeather);
 *
 * const response = yield* LanguageModel.generateText({
 *   prompt: "What's the weather in Seattle?",
 *   toolkit: WeatherToolkit,
 * }).pipe(
 *   Effect.provide(WeatherToolkit.toLayer({
 *     get_weather: ({ city }) => Effect.succeed({ temperatureF: 72 }),
 *   })),
 *   Effect.provide(model),
 * );
 * ```
 *
 * @binding
 */
export interface LanguageModel extends Binding.Service<
  LanguageModel,
  "AWS.Bedrock.LanguageModel",
  (
    model: string | readonly [string, ...string[]],
    options?: LanguageModelOptions,
  ) => Effect.Effect<Layer.Layer<AiLanguageModel.LanguageModel>>
> {}
export const LanguageModel = Binding.Service<LanguageModel>(
  "AWS.Bedrock.LanguageModel",
);

/**
 * The already-bound Converse callables the adapter drives. Produced by
 * `yield* Bedrock.Converse(model)` / `yield* Bedrock.ConverseStream(model)`
 * (or any function of the same shape).
 */
export interface MakeLanguageModelOptions {
  /** Non-streaming Converse callable (modelId already bound). */
  readonly converse: (
    request: ConverseRequest,
  ) => Effect.Effect<bedrock.ConverseResponse, bedrock.ConverseError>;
  /** Streaming Converse callable (modelId already bound). */
  readonly converseStream: (
    request: ConverseStreamRequest,
  ) => Effect.Effect<
    bedrock.ConverseStreamResponse,
    bedrock.ConverseStreamError
  >;
  /** Default inference parameters for every call. */
  readonly parameters?: LanguageModelParameters;
}

/**
 * Provide an {@link AiLanguageModel.LanguageModel} layer backed by the
 * supplied Bedrock Converse callables.
 */
export const makeLanguageModelLayer = (
  options: MakeLanguageModelOptions,
): Layer.Layer<AiLanguageModel.LanguageModel> =>
  Layer.effect(AiLanguageModel.LanguageModel, makeLanguageModel(options));

/**
 * Build an {@link AiLanguageModel.Service} that proxies generateText /
 * streamText through the Bedrock Converse API.
 */
export const makeLanguageModel = ({
  converse,
  converseStream,
  parameters,
}: MakeLanguageModelOptions): Effect.Effect<AiLanguageModel.Service> =>
  AiLanguageModel.make({
    generateText: (options) =>
      Effect.gen(function* () {
        // Read the fiber-scoped per-call overrides (withModelParameters)
        // and merge them over the binding's construction-time defaults.
        const call = yield* CurrentModelParameters;
        const request = toConverseRequest({
          options,
          parameters: mergeParameters(parameters, call),
          modelId: call.modelId,
        });
        const response = yield* converse(request).pipe(
          Effect.mapError((cause) => toAiError(cause, "generateText")),
        );
        return toResponseParts(response);
      }),
    streamText: (options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const idGen = yield* IdGenerator.IdGenerator;
          const call = yield* CurrentModelParameters;
          const request = toConverseRequest({
            options,
            parameters: mergeParameters(parameters, call),
            modelId: call.modelId,
          });
          const response = yield* converseStream(request).pipe(
            Effect.mapError((cause) => toAiError(cause, "streamText")),
          );
          return parseStream(response, idGen);
        }),
      ),
  });

// ---------------------------------------------------------------------------
// Prompt → Converse messages
//
// The Converse API separates system prompts from the message list, requires
// strict user/assistant alternation, and carries tool results inside *user*
// messages — so conversion merges consecutive same-role messages after
// mapping.
// ---------------------------------------------------------------------------

const IMAGE_FORMATS: Record<string, bedrock.ImageFormat> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const base64ToUint8Array = (data: string): Uint8Array => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const fileToImageBlock = (
  data: string | Uint8Array | URL,
  mediaType: string,
): bedrock.ContentBlock | undefined => {
  const format = IMAGE_FORMATS[mediaType];
  // Converse only accepts inline bytes (or S3 locations) — remote URLs and
  // non-image documents are not representable, so they are dropped.
  if (format === undefined || data instanceof URL) return undefined;
  const bytes =
    data instanceof Uint8Array
      ? data
      : base64ToUint8Array(
          data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data,
        );
  return { image: { format, source: { bytes } } };
};

const toolCallInput = (params: unknown): unknown => {
  if (typeof params !== "string") return params ?? {};
  try {
    return JSON.parse(params);
  } catch {
    return {};
  }
};

interface ConverseMessages {
  readonly system: bedrock.SystemContentBlock[];
  readonly messages: bedrock.Message[];
}

const toUserContent = (
  parts: Prompt.UserMessage["content"],
): bedrock.ContentBlock[] =>
  parts.flatMap((p): bedrock.ContentBlock[] => {
    if (p.type === "text") return p.text.length > 0 ? [{ text: p.text }] : [];
    if (p.type === "file") {
      const block = fileToImageBlock(p.data, p.mediaType);
      return block === undefined ? [] : [block];
    }
    return [];
  });

const toAssistantContent = (
  parts: Prompt.AssistantMessage["content"],
): bedrock.ContentBlock[] =>
  parts.flatMap((p): bedrock.ContentBlock[] => {
    // Reasoning parts are not replayed: Bedrock requires the original
    // cryptographic signature alongside replayed reasoning, which the
    // framework does not round-trip. Models tolerate its absence.
    if (p.type === "text") return p.text.length > 0 ? [{ text: p.text }] : [];
    if (p.type === "tool-call") {
      return [
        {
          toolUse: {
            toolUseId: p.id,
            name: p.name,
            input: toolCallInput(p.params),
          },
        },
      ];
    }
    return [];
  });

const toToolResultContent = (
  parts: Prompt.ToolMessage["content"],
): bedrock.ContentBlock[] =>
  parts.flatMap((p): bedrock.ContentBlock[] =>
    p.type === "tool-result"
      ? [
          {
            toolResult: {
              toolUseId: p.id,
              content:
                typeof p.result === "string"
                  ? [{ text: p.result }]
                  : [{ json: p.result ?? {} }],
              ...(p.isFailure ? { status: "error" as const } : {}),
            },
          },
        ]
      : [],
  );

const convertPrompt = (prompt: Prompt.Prompt): ConverseMessages => {
  const system: bedrock.SystemContentBlock[] = [];
  const messages: bedrock.Message[] = [];

  const append = (
    role: bedrock.ConversationRole,
    content: bedrock.ContentBlock[],
  ) => {
    if (content.length === 0) return;
    const last = messages[messages.length - 1];
    // Converse requires user/assistant alternation; merge consecutive
    // same-role messages (tool results become user messages, so a tool
    // message followed by a user message must fuse).
    if (last !== undefined && last.role === role) {
      last.content.push(...content);
    } else {
      messages.push({ role, content });
    }
  };

  for (const message of prompt.content) {
    switch (message.role) {
      case "system":
        if (message.content.length > 0) system.push({ text: message.content });
        break;
      case "user":
        append("user", toUserContent(message.content));
        break;
      case "assistant":
        append("assistant", toAssistantContent(message.content));
        break;
      case "tool":
        append("user", toToolResultContent(message.content));
        break;
    }
  }

  return { system, messages };
};

// ---------------------------------------------------------------------------
// Tools / toolChoice
// ---------------------------------------------------------------------------

const toToolSpec = (tool: Tool.Any): bedrock.Tool => ({
  toolSpec: {
    name: tool.name,
    description: Tool.getDescription(tool),
    inputSchema: { json: Tool.getJsonSchema(tool) },
  },
});

const hasToolBlocks = (messages: ReadonlyArray<bedrock.Message>): boolean =>
  messages.some((m) =>
    m.content.some(
      (block) => block.toolUse !== undefined || block.toolResult !== undefined,
    ),
  );

const toToolConfig = (
  tools: ReadonlyArray<Tool.Any>,
  toolChoice: AiLanguageModel.ProviderOptions["toolChoice"],
  messages: ReadonlyArray<bedrock.Message>,
): bedrock.ToolConfiguration | undefined => {
  if (tools.length === 0) return undefined;
  const mapped = tools.map(toToolSpec);

  if (toolChoice === "none") {
    // Converse has no "none" mode. Omit toolConfig entirely — unless the
    // conversation already contains toolUse/toolResult blocks, which the API
    // rejects without a toolConfig; then send the tools with auto choice.
    return hasToolBlocks(messages)
      ? { tools: mapped, toolChoice: { auto: {} } }
      : undefined;
  }
  if (toolChoice === "required") {
    return { tools: mapped, toolChoice: { any: {} } };
  }
  if (typeof toolChoice === "object" && "tool" in toolChoice) {
    return {
      tools: mapped,
      toolChoice: { tool: { name: toolChoice.tool } },
    };
  }
  if (typeof toolChoice === "object" && "oneOf" in toolChoice) {
    const allowed = new Set(toolChoice.oneOf);
    return {
      tools: mapped.filter(
        (t) => t.toolSpec !== undefined && allowed.has(t.toolSpec.name),
      ),
      toolChoice: toolChoice.mode === "required" ? { any: {} } : { auto: {} },
    };
  }
  return { tools: mapped, toolChoice: { auto: {} } };
};

// ---------------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------------

/**
 * Merge per-call overrides over construction-time defaults, field by field —
 * an undefined override field never clobbers a configured default.
 */
const mergeParameters = (
  defaults: LanguageModelParameters | undefined,
  overrides: LanguageModelCallParameters,
): LanguageModelParameters => ({
  maxTokens: overrides.maxTokens ?? defaults?.maxTokens,
  temperature: overrides.temperature ?? defaults?.temperature,
  topP: overrides.topP ?? defaults?.topP,
  stopSequences: overrides.stopSequences ?? defaults?.stopSequences,
  additionalModelRequestFields:
    overrides.additionalModelRequestFields ??
    defaults?.additionalModelRequestFields,
});

const toConverseRequest = ({
  options,
  parameters,
  modelId,
}: {
  readonly options: AiLanguageModel.ProviderOptions;
  readonly parameters: LanguageModelParameters | undefined;
  readonly modelId?: string | undefined;
}): ConverseRequest & ConverseStreamRequest => {
  const { system, messages } = convertPrompt(options.prompt);
  const toolConfig = toToolConfig(options.tools, options.toolChoice, messages);
  const inferenceConfig: bedrock.InferenceConfiguration = {
    ...(parameters?.maxTokens !== undefined
      ? { maxTokens: parameters.maxTokens }
      : {}),
    ...(parameters?.temperature !== undefined
      ? { temperature: parameters.temperature }
      : {}),
    ...(parameters?.topP !== undefined ? { topP: parameters.topP } : {}),
    ...(parameters?.stopSequences !== undefined
      ? { stopSequences: parameters.stopSequences }
      : {}),
  };
  return {
    messages,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(system.length > 0 ? { system } : {}),
    ...(Object.keys(inferenceConfig).length > 0 ? { inferenceConfig } : {}),
    ...(toolConfig !== undefined ? { toolConfig } : {}),
    ...(parameters?.additionalModelRequestFields !== undefined
      ? {
          additionalModelRequestFields: parameters.additionalModelRequestFields,
        }
      : {}),
  };
};

// ---------------------------------------------------------------------------
// Finish reason / usage mapping
// ---------------------------------------------------------------------------

const mapStopReason = (
  raw: bedrock.StopReason | undefined,
): Response.FinishReason => {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool-calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "guardrail_intervened":
    case "content_filtered":
      return "content-filter";
    case "malformed_model_output":
    case "malformed_tool_use":
      return "error";
    case undefined:
      return "unknown";
    default:
      return "other";
  }
};

const mapUsage = (usage: bedrock.TokenUsage | undefined): Response.Usage => {
  // Bedrock's `inputTokens` excludes cache reads/writes, which are reported
  // separately — so `total` is the sum of all three.
  const input = usage?.inputTokens ?? 0;
  const cacheRead = usage?.cacheReadInputTokens ?? 0;
  const cacheWrite = usage?.cacheWriteInputTokens ?? 0;
  return new Response.Usage({
    inputTokens: {
      uncached: input,
      total: input + cacheRead + cacheWrite,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: usage?.outputTokens ?? 0,
      text: 0,
      reasoning: 0,
    },
  });
};

// ---------------------------------------------------------------------------
// generateText: ConverseResponse → Response.PartEncoded[]
// ---------------------------------------------------------------------------

const toResponseParts = (
  response: bedrock.ConverseResponse,
): Array<Response.PartEncoded> => {
  const content = response.output.message?.content ?? [];
  const parts = content.flatMap((block): Response.PartEncoded[] => {
    if (block.text !== undefined && block.text.length > 0) {
      return [{ type: "text", text: block.text }];
    }
    if (block.reasoningContent?.reasoningText !== undefined) {
      const text = block.reasoningContent.reasoningText.text;
      return text.length > 0 ? [{ type: "reasoning", text }] : [];
    }
    if (block.toolUse !== undefined) {
      return [
        {
          type: "tool-call",
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          params: block.toolUse.input ?? {},
        },
      ];
    }
    return [];
  });
  return [
    ...parts,
    {
      type: "finish",
      reason: mapStopReason(response.stopReason),
      usage: mapUsage(response.usage),
      response: undefined,
    },
  ];
};

// ---------------------------------------------------------------------------
// streamText: ConverseStreamOutput events → Stream<Response.StreamPartEncoded>
//
// Bedrock's stream is fully structured: content blocks are opened by index
// (`contentBlockStart` for tool use; text/reasoning open implicitly on the
// first delta), advanced by `contentBlockDelta`, and closed by
// `contentBlockStop`. `messageStop` carries the stop reason and `metadata`
// carries usage. State threads through `Stream.mapAccumEffect`; the
// per-event `parts` buffer is mutable but scoped to one event.
// ---------------------------------------------------------------------------

interface OpenBlock {
  readonly kind: "text" | "reasoning" | "tool";
  readonly id: string;
}

interface StreamState {
  readonly blocks: ReadonlyMap<number, OpenBlock>;
  readonly usage: bedrock.TokenUsage | undefined;
  readonly stopReason: bedrock.StopReason | undefined;
}

const initialStreamState: StreamState = {
  blocks: new Map(),
  usage: undefined,
  stopReason: undefined,
};

type StreamParts = Array<Response.StreamPartEncoded>;

// Text/reasoning blocks open implicitly on their first delta; tool blocks
// are opened by handleBlockStart (Bedrock names them via contentBlockStart).
const openBlock = (
  state: StreamState,
  index: number,
  block: OpenBlock & { readonly kind: "text" | "reasoning" },
  parts: StreamParts,
): StreamState => {
  parts.push(
    block.kind === "text"
      ? { type: "text-start", id: block.id }
      : { type: "reasoning-start", id: block.id },
  );
  const blocks = new Map(state.blocks);
  blocks.set(index, block);
  return { ...state, blocks };
};

const closeBlock = (
  state: StreamState,
  index: number,
  parts: StreamParts,
): StreamState => {
  const block = state.blocks.get(index);
  if (block === undefined) return state;
  parts.push(
    block.kind === "text"
      ? { type: "text-end", id: block.id }
      : block.kind === "reasoning"
        ? { type: "reasoning-end", id: block.id }
        : { type: "tool-params-end", id: block.id },
  );
  const blocks = new Map(state.blocks);
  blocks.delete(index);
  return { ...state, blocks };
};

const handleBlockStart = (
  state: StreamState,
  event: bedrock.ContentBlockStartEvent,
  parts: StreamParts,
): StreamState => {
  const toolUse = event.start.toolUse;
  if (toolUse === undefined) return state;
  parts.push({
    type: "tool-params-start",
    id: toolUse.toolUseId,
    name: toolUse.name,
  });
  const blocks = new Map(state.blocks);
  blocks.set(event.contentBlockIndex, { kind: "tool", id: toolUse.toolUseId });
  return { ...state, blocks };
};

const handleBlockDelta = (
  state: StreamState,
  event: bedrock.ContentBlockDeltaEvent,
  parts: StreamParts,
  idGen: IdGenerator.Service,
): Effect.Effect<StreamState> =>
  Effect.gen(function* () {
    const index = event.contentBlockIndex;
    const delta = event.delta;
    let s = state;

    if (delta.text !== undefined) {
      let block = s.blocks.get(index);
      if (block === undefined) {
        const opened = {
          kind: "text",
          id: yield* idGen.generateId(),
        } as const;
        s = openBlock(s, index, opened, parts);
        block = opened;
      }
      if (delta.text.length > 0) {
        parts.push({ type: "text-delta", id: block.id, delta: delta.text });
      }
      return s;
    }

    if (delta.reasoningContent !== undefined) {
      const text = delta.reasoningContent.text;
      // Signature / redacted-content deltas carry no displayable text.
      if (text === undefined) return s;
      let block = s.blocks.get(index);
      if (block === undefined) {
        const opened = {
          kind: "reasoning",
          id: yield* idGen.generateId(),
        } as const;
        s = openBlock(s, index, opened, parts);
        block = opened;
      }
      if (text.length > 0) {
        parts.push({ type: "reasoning-delta", id: block.id, delta: text });
      }
      return s;
    }

    if (delta.toolUse !== undefined) {
      const block = s.blocks.get(index);
      if (block !== undefined && delta.toolUse.input.length > 0) {
        parts.push({
          type: "tool-params-delta",
          id: block.id,
          delta: delta.toolUse.input,
        });
      }
      return s;
    }

    return s;
  });

const streamExceptionOf = (event: bedrock.ConverseStreamOutput): unknown =>
  event.internalServerException ??
  event.modelStreamErrorException ??
  event.validationException ??
  event.throttlingException ??
  event.serviceUnavailableException;

const handleStreamEvent = (
  state: StreamState,
  event: bedrock.ConverseStreamOutput,
  idGen: IdGenerator.Service,
): Effect.Effect<
  readonly [StreamState, ReadonlyArray<Response.StreamPartEncoded>],
  AiError.AiError
> =>
  Effect.gen(function* () {
    const exception = streamExceptionOf(event);
    if (exception !== undefined) {
      return yield* Effect.fail(toAiError(exception, "streamText"));
    }
    const parts: StreamParts = [];
    let s = state;
    if (event.contentBlockStart !== undefined) {
      s = handleBlockStart(s, event.contentBlockStart, parts);
    } else if (event.contentBlockDelta !== undefined) {
      s = yield* handleBlockDelta(s, event.contentBlockDelta, parts, idGen);
    } else if (event.contentBlockStop !== undefined) {
      s = closeBlock(s, event.contentBlockStop.contentBlockIndex, parts);
    } else if (event.messageStop !== undefined) {
      s = { ...s, stopReason: event.messageStop.stopReason };
    } else if (event.metadata !== undefined) {
      s = { ...s, usage: event.metadata.usage };
    }
    return [s, parts] as const;
  });

const finalizeStream = (
  state: StreamState,
): ReadonlyArray<Response.StreamPartEncoded> => {
  const parts: StreamParts = [];
  let s = state;
  for (const index of [...s.blocks.keys()].sort((a, b) => a - b)) {
    s = closeBlock(s, index, parts);
  }
  parts.push({
    type: "finish",
    reason: mapStopReason(s.stopReason),
    usage: mapUsage(s.usage),
    response: undefined,
  });
  return parts;
};

const parseStream = (
  response: bedrock.ConverseStreamResponse,
  idGen: IdGenerator.Service,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => {
  const events = response.stream;
  if (events === undefined) {
    return Stream.fromIterable(finalizeStream(initialStreamState));
  }
  return events.pipe(
    Stream.mapError((cause) => toAiError(cause, "streamText")),
    Stream.mapAccumEffect(
      () => initialStreamState,
      (state, event) => handleStreamEvent(state, event, idGen),
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
): AiError.AiError => {
  const tagged = cause as { _tag?: string; message?: string } | undefined;
  const description = [
    tagged?._tag ?? (cause instanceof Error ? cause.name : undefined),
    tagged?.message ?? "Bedrock Converse request failed",
  ]
    .filter((s): s is string => s !== undefined && s.length > 0)
    .join(": ");
  return AiError.AiError.make({
    module: "AWS.Bedrock.LanguageModel",
    method,
    reason: new AiError.UnknownError({ description }),
  });
};
