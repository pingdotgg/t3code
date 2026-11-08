import { isSecretReference } from "@t3tools/contracts";
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
    operation: Schema.Literal("post-processing"),
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
    operation: "post-processing",
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        (cause) => new SpeechCleanupApiError({ operation, reason: "configuration", cause }),
      ),
    );
    const provider = settings.speechPostProcessingProvider;
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
    return { settings, key };
  });

  return SpeechCleanupApi.of({
    postProcess: Effect.fn("SpeechCleanupApi.postProcess")(function* (prompt) {
      const { settings, key } = yield* credential("post-processing");
      const provider = settings.speechPostProcessingProvider;
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
            ...(anthropic ? { max_tokens: 16384 } : {}),
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
          }),
        ),
        "responses",
      );
    }),
  });
});

export const layer = Layer.effect(SpeechCleanupApi, make);
