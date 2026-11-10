import type { TextGeneratorKind, TextGeneratorModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

/** Where a text generator is reached, with its key already read from wherever settings keep it. */
export interface TextGeneratorConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Names the generator in errors, such as its label or host. */
  readonly label: string;
}

/** Why a model API call failed, worded for the person who configured it. */
export class TextGeneratorRequestError extends Schema.TaggedError<TextGeneratorRequestError>()(
  "TextGeneratorRequestError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface TextGeneratorDriver {
  readonly kind: TextGeneratorKind;
  readonly generate: (
    connection: TextGeneratorConnection,
    model: string,
    prompt: string,
  ) => Effect.Effect<string, TextGeneratorRequestError, HttpClient.HttpClient>;
  readonly listModels: (
    connection: TextGeneratorConnection,
  ) => Effect.Effect<
    ReadonlyArray<TextGeneratorModel>,
    TextGeneratorRequestError,
    HttpClient.HttpClient
  >;
}

const GENERATE_TIMEOUT = "2 minutes";
const LIST_MODELS_TIMEOUT = "25 seconds";
const MAX_MODEL_PAGES = 10;

const ApiErrorBody = Schema.Struct({
  error: Schema.Struct({ message: Schema.String }),
});
const decodeApiErrorBody = Schema.decodeUnknownOption(ApiErrorBody);

const describeStatus = (label: string, status: number, message: string | undefined) => {
  const reason =
    status === 401 || status === 403
      ? "rejected the API key"
      : status === 404
        ? "couldn't find that model or endpoint"
        : status === 429
          ? "is rate-limiting requests"
          : `returned HTTP ${status}`;
  const detail = message?.trim().slice(0, 300);
  return `${label} ${reason}${detail ? `: ${detail}` : "."}`;
};

const endpoint = (connection: TextGeneratorConnection, path: string) =>
  `${connection.baseUrl.replace(/\/+$/, "")}${path}`;

/** Sends a request and decodes a 2xx JSON body; anything else becomes a readable error. */
const sendJson = Effect.fn("TextGenerator.sendJson")(function* <S extends Schema.Top>(
  label: string,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) {
  const http = yield* HttpClient.HttpClient;
  const response: HttpClientResponse.HttpClientResponse = yield* http.execute(request).pipe(
    // A redirect could carry the key to another origin.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.mapError(
      (cause) =>
        new TextGeneratorRequestError({
          detail: `Couldn't reach ${label}. Check the base URL and your connection.`,
          cause,
        }),
    ),
  );
  const body = yield* response.json.pipe(Effect.orElseSucceed((): unknown => undefined));
  if (response.status < 200 || response.status >= 300) {
    const message = decodeApiErrorBody(body).pipe((option) =>
      option._tag === "Some" ? option.value.error.message : undefined,
    );
    return yield* new TextGeneratorRequestError({
      detail: describeStatus(label, response.status, message),
    });
  }
  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (cause) =>
        new TextGeneratorRequestError({
          detail: `${label} returned a reply T3 Code couldn't read.`,
          cause,
        }),
    ),
  );
});

const withTimeout =
  (label: string, duration: typeof GENERATE_TIMEOUT | typeof LIST_MODELS_TIMEOUT) =>
  <A, R>(effect: Effect.Effect<A, TextGeneratorRequestError, R>) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () =>
          Effect.fail(
            new TextGeneratorRequestError({ detail: `${label} took too long to respond.` }),
          ),
      }),
    );

const sortModels = (models: Iterable<TextGeneratorModel>) =>
  [...models].sort((left, right) => left.id.localeCompare(right.id));

const readModel = (entry: { readonly id: string; readonly name?: string | undefined }) => {
  const id = entry.id.trim();
  return id ? { id, name: entry.name?.trim() || id } : undefined;
};

const ChatCompletion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      finish_reason: Schema.NullOr(Schema.String),
      message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
    }),
  ),
});
const OpenAIModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.String) })),
});

const openAICompatible: TextGeneratorDriver = {
  kind: "openaiCompatible",
  generate: (connection, model, prompt) => {
    const { label } = connection;
    let request = HttpClientRequest.post(endpoint(connection, "/chat/completions")).pipe(
      HttpClientRequest.bodyJsonUnsafe({ model, messages: [{ role: "user", content: prompt }] }),
    );
    if (connection.apiKey) request = HttpClientRequest.bearerToken(request, connection.apiKey);
    return sendJson(label, request, ChatCompletion).pipe(
      Effect.flatMap((completion) => {
        const choice = completion.choices[0];
        const text = choice?.message.content?.trim();
        if (choice?.finish_reason === "length") {
          return Effect.fail(
            new TextGeneratorRequestError({ detail: `${label} reached its output limit.` }),
          );
        }
        return text
          ? Effect.succeed(text)
          : Effect.fail(new TextGeneratorRequestError({ detail: `${label} returned no text.` }));
      }),
      withTimeout(label, GENERATE_TIMEOUT),
    );
  },
  listModels: (connection) => {
    const { label } = connection;
    let request = HttpClientRequest.get(endpoint(connection, "/models"));
    if (connection.apiKey) request = HttpClientRequest.bearerToken(request, connection.apiKey);
    return sendJson(label, request, OpenAIModelList).pipe(
      Effect.map((list) => sortModels(list.data.flatMap((entry) => readModel(entry) ?? []))),
      withTimeout(label, LIST_MODELS_TIMEOUT),
    );
  },
};

const ANTHROPIC_VERSION = "2023-06-01";
const AnthropicMessage = Schema.Struct({
  stop_reason: Schema.NullOr(Schema.String),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});
const AnthropicModelPage = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, display_name: Schema.optional(Schema.String) }),
  ),
  has_more: Schema.optional(Schema.Boolean),
  last_id: Schema.optional(Schema.NullOr(Schema.String)),
});

const anthropicRequest = (request: HttpClientRequest.HttpClientRequest, apiKey: string) =>
  request.pipe(
    HttpClientRequest.setHeader("x-api-key", apiKey),
    HttpClientRequest.setHeader("anthropic-version", ANTHROPIC_VERSION),
  );

const anthropic: TextGeneratorDriver = {
  kind: "anthropic",
  generate: (connection, model, prompt) => {
    const { label } = connection;
    const request = anthropicRequest(
      HttpClientRequest.post(endpoint(connection, "/messages")).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          model,
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        }),
      ),
      connection.apiKey,
    );
    return sendJson(label, request, AnthropicMessage).pipe(
      Effect.flatMap((message) => {
        if (message.stop_reason === "max_tokens") {
          return Effect.fail(
            new TextGeneratorRequestError({ detail: `${label} reached its output limit.` }),
          );
        }
        const text = message.content
          .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
          .join("")
          .trim();
        return text
          ? Effect.succeed(text)
          : Effect.fail(new TextGeneratorRequestError({ detail: `${label} returned no text.` }));
      }),
      withTimeout(label, GENERATE_TIMEOUT),
    );
  },
  listModels: Effect.fn("TextGenerator.anthropic.listModels")(
    function* (connection) {
      const { label } = connection;
      const models = new Map<string, TextGeneratorModel>();
      let after: string | undefined;
      for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        let request = HttpClientRequest.get(endpoint(connection, "/models")).pipe(
          HttpClientRequest.setUrlParam("limit", "1000"),
        );
        if (after) request = HttpClientRequest.setUrlParam(request, "after_id", after);
        const result = yield* sendJson(
          label,
          anthropicRequest(request, connection.apiKey),
          AnthropicModelPage,
        );
        for (const entry of result.data) {
          const model = readModel({ id: entry.id, name: entry.display_name });
          if (model) models.set(model.id, model);
        }
        if (!result.has_more || !result.last_id || result.last_id === after) break;
        after = result.last_id;
      }
      return sortModels(models.values());
    },
    (effect, connection) => effect.pipe(withTimeout(connection.label, LIST_MODELS_TIMEOUT)),
  ),
};

export const TEXT_GENERATOR_DRIVERS: Readonly<
  Record<Exclude<TextGeneratorKind, "opencode">, TextGeneratorDriver>
> = {
  openaiCompatible: openAICompatible,
  anthropic,
};
