import {
  isSecretReference,
  SpeechCleanupReasoning,
  type SpeechCleanupModels,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";

export class SpeechCleanupApiError extends Schema.TaggedError<SpeechCleanupApiError>()(
  "SpeechCleanupApiError",
  {
    operation: Schema.Literals(["post-processing", "models"]),
    reason: Schema.Literals(["configuration", "credential", "http", "response", "unavailable"]),
    status: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return `Speech ${this.operation} API failed (${this.reason}${this.status ? ` ${this.status}` : ""}).`;
  }
}

export class SpeechCleanupApi extends Context.Service<
  SpeechCleanupApi,
  {
    readonly postProcess: (prompt: string) => Effect.Effect<string, SpeechCleanupApiError>;
    readonly models: Effect.Effect<SpeechCleanupModels, SpeechCleanupApiError>;
  }
>()("t3/speech/SpeechCleanupApi") {}

const OpenAIResponse = Schema.Struct({
  status: Schema.String,
  output: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      content: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            text: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    }),
  ),
});
const ChatCompletion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: Schema.NullOr(Schema.String),
      message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
    }),
  ),
});
const AnthropicMessage = Schema.Struct({
  stop_reason: Schema.NullOr(Schema.String),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
  ),
});
const ModelPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optionalKey(Schema.String),
      display_name: Schema.optionalKey(Schema.String),
      capabilities: Schema.optionalKey(
        Schema.Struct({
          effort: Schema.optionalKey(
            Schema.Record(
              Schema.String,
              Schema.Union([Schema.Boolean, Schema.Struct({ supported: Schema.Boolean })]),
            ),
          ),
        }),
      ),
    }),
  ),
  has_more: Schema.optionalKey(Schema.Boolean),
  last_id: Schema.optionalKey(Schema.String),
});

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const resolver = yield* SecretResolver.SecretResolver;
  const http = yield* HttpClient.HttpClient;
  const requestText = Effect.fn("SpeechCleanupApi.request")(
    function* (
      operation: "post-processing",
      request: HttpClientRequest.HttpClientRequest,
      format: "responses" | "chat" | "anthropic",
    ) {
      const fail = (reason: "http" | "response" | "unavailable", status?: number) =>
        new SpeechCleanupApiError({
          operation,
          reason,
          ...(status === undefined ? {} : { status }),
        });
      const response = yield* http.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.mapError(
          (cause) => new SpeechCleanupApiError({ operation, reason: "unavailable", cause }),
        ),
      );
      if (response.status < 200 || response.status >= 300)
        return yield* fail("http", response.status);
      if (format === "chat") {
        const result = yield* HttpClientResponse.schemaBodyJson(ChatCompletion)(response).pipe(
          Effect.mapError(
            (cause) => new SpeechCleanupApiError({ operation, reason: "response", cause }),
          ),
        );
        const choice = result.choices[0];
        const text = choice?.message.content?.trim();
        if (choice?.finish_reason !== "stop" || !text) return yield* fail("response");
        return text;
      }
      if (format === "anthropic") {
        const result = yield* HttpClientResponse.schemaBodyJson(AnthropicMessage)(response).pipe(
          Effect.mapError(
            (cause) => new SpeechCleanupApiError({ operation, reason: "response", cause }),
          ),
        );
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("")
          .trim();
        if (result.stop_reason !== "end_turn" || !text) return yield* fail("response");
        return text;
      }
      const result = yield* HttpClientResponse.schemaBodyJson(OpenAIResponse)(response).pipe(
        Effect.mapError(
          (cause) => new SpeechCleanupApiError({ operation, reason: "response", cause }),
        ),
      );
      if (result.status !== "completed") return yield* fail("response");
      const text = result.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === "output_text")
        .map((item) => item.text ?? "")
        .join("")
        .trim();
      if (!text) return yield* fail("response");
      return text;
    },
    (effect, operation) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: "2 minutes",
          orElse: () =>
            Effect.fail(new SpeechCleanupApiError({ operation, reason: "unavailable" })),
        }),
      ),
  );

  const credential = Effect.fn("SpeechCleanupApi.credential")(function* (
    operation: "post-processing" | "models",
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) => new SpeechCleanupApiError({ operation, reason: "configuration", cause }),
      ),
    );
    const selected = settings.speechPostProcessingProvider;
    const provider =
      selected === "compatible" && settings.speechPostProcessingCompatiblePreset === "openrouter"
        ? "openrouter"
        : selected;
    const slot =
      provider === "compatible"
        ? "compatiblePostProcessing"
        : provider === "anthropic"
          ? "anthropicPostProcessing"
          : provider === "openrouter"
            ? "openrouterPostProcessing"
            : "openaiPostProcessing";
    const source = settings.voiceApiCredentials[slot];
    if (isSecretReference(source)) yield* resolver.invalidate([source]);
    const key = yield* requireSettingsSecret(resolver, source).pipe(
      Effect.mapError(
        (cause) => new SpeechCleanupApiError({ operation, reason: "credential", cause }),
      ),
    );
    return { settings, key, provider };
  });

  return SpeechCleanupApi.of({
    postProcess: Effect.fn("SpeechCleanupApi.postProcess")(function* (prompt) {
      const { settings, key, provider } = yield* credential("post-processing");
      if (!key && provider !== "compatible")
        return yield* new SpeechCleanupApiError({
          operation: "post-processing",
          reason: "credential",
        });
      if (provider === "compatible" || provider === "anthropic" || provider === "openrouter") {
        const config = settings.speechPostProcessingApiEndpoints[provider];
        if (!config.endpoint || !config.model)
          return yield* new SpeechCleanupApiError({
            operation: "post-processing",
            reason: "configuration",
          });
        const anthropic = provider === "anthropic";
        const endpoint = config.endpoint.replace(/\/+$/, "");
        let request = HttpClientRequest.post(
          `${endpoint}${anthropic ? "/messages" : "/chat/completions"}`,
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            model: config.model,
            messages: [{ role: "user", content: prompt }],
            ...(anthropic
              ? {
                  max_tokens: 16384,
                  ...(settings.speechPostProcessingAnthropicReasoning === null
                    ? {}
                    : {
                        output_config: { effort: settings.speechPostProcessingAnthropicReasoning },
                      }),
                }
              : {}),
          }),
        );
        if (anthropic) {
          request = request.pipe(
            HttpClientRequest.setHeader("x-api-key", key),
            HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
          );
        } else if (key) request = HttpClientRequest.bearerToken(request, Redacted.make(key));
        return yield* requestText("post-processing", request, anthropic ? "anthropic" : "chat");
      }
      return yield* requestText(
        "post-processing",
        HttpClientRequest.post("https://api.openai.com/v1/responses").pipe(
          HttpClientRequest.bearerToken(Redacted.make(key)),
          HttpClientRequest.bodyJsonUnsafe({
            model: settings.speechPostProcessingOpenAIModel,
            input: prompt,
            store: false,
            ...(settings.speechPostProcessingOpenAIReasoning === null
              ? {}
              : {
                  reasoning: { effort: settings.speechPostProcessingOpenAIReasoning },
                }),
          }),
        ),
        "responses",
      );
    }),
    models: Effect.gen(function* () {
      const operation = "models";
      const { settings, key, provider } = yield* credential(operation);
      if (provider === "agent" || provider === "opencode")
        return yield* new SpeechCleanupApiError({ operation, reason: "configuration" });
      if (!key && provider !== "compatible")
        return yield* new SpeechCleanupApiError({ operation, reason: "credential" });
      const endpoint =
        provider === "openai"
          ? "https://api.openai.com/v1"
          : settings.speechPostProcessingApiEndpoints[provider].endpoint.replace(/\/+$/, "");
      if (!endpoint)
        return yield* new SpeechCleanupApiError({ operation, reason: "configuration" });
      const models = new Map<string, SpeechCleanupModels["models"][number]>();
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        let request = HttpClientRequest.get(`${endpoint}/models`);
        if (provider === "anthropic") {
          request = request.pipe(
            HttpClientRequest.setHeader("x-api-key", key),
            HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
            HttpClientRequest.setUrlParam("limit", "1000"),
          );
          if (cursor) request = HttpClientRequest.setUrlParam(request, "after_id", cursor);
        } else if (key) request = HttpClientRequest.bearerToken(request, Redacted.make(key));
        const response = yield* http.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.mapError(() => new SpeechCleanupApiError({ operation, reason: "unavailable" })),
        );
        if (response.status < 200 || response.status >= 300)
          return yield* new SpeechCleanupApiError({
            operation,
            reason: "http",
            status: response.status,
          });
        const result = yield* HttpClientResponse.schemaBodyJson(ModelPage)(response).pipe(
          Effect.mapError(() => new SpeechCleanupApiError({ operation, reason: "response" })),
        );
        for (const model of result.data) {
          if (!model.id.trim() || model.id.length > 200) continue;
          const effort = model.capabilities?.effort;
          models.set(model.id, {
            id: model.id,
            name: model.display_name ?? model.name ?? model.id,
            ...(effort
              ? {
                  reasoningLevels: SpeechCleanupReasoning.literals.filter((level) => {
                    const capability = effort[level];
                    return typeof capability === "object" && capability.supported;
                  }),
                }
              : {}),
          });
        }
        if (!result.has_more)
          return { models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)) };
        if (provider !== "anthropic" || !result.last_id || result.last_id === cursor) break;
        cursor = result.last_id;
      }
      return yield* new SpeechCleanupApiError({ operation, reason: "response" });
    }).pipe(
      Effect.withSpan("SpeechCleanupApi.models"),
      Effect.timeoutOrElse({
        duration: "25 seconds",
        orElse: () =>
          Effect.fail(new SpeechCleanupApiError({ operation: "models", reason: "unavailable" })),
      }),
    ),
  });
});

export const layer = Layer.effect(SpeechCleanupApi, make);
