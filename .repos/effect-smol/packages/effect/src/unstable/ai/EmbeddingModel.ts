/**
 * The `EmbeddingModel` module defines the provider-neutral service for turning
 * text into embedding vectors. It exposes single-input `embed` and ordered
 * batch `embedMany` operations, and keeps provider failures represented as
 * `AiError` values.
 *
 * **Mental model**
 *
 * Providers supply one batch embedding function through `make`. The module
 * derives single-input `embed` calls from a request resolver, so concurrent
 * single-input requests can be batched into one provider call. Provider
 * vectors are wrapped as `EmbedResponse` values, while `EmbedManyResponse`
 * preserves input order and carries token usage when the provider reports it.
 *
 * **Common tasks**
 *
 * - Build an `EmbeddingModel` service from a provider implementation.
 * - Use `embed` for one query or document, and `embedMany` when the caller
 *   already has a batch.
 * - Read `Dimensions` when downstream code needs the configured vector size.
 *
 * **Example** (Building a small embedding model)
 *
 * ```ts
 * import { Effect } from "effect"
 * import { EmbeddingModel } from "effect/unstable/ai"
 *
 * const program = Effect.gen(function*() {
 *   const model = yield* EmbeddingModel.make({
 *     embedMany: ({ inputs }) =>
 *       Effect.succeed({
 *         results: inputs.map((input) => [input.length]),
 *         usage: { inputTokens: inputs.join(" ").length }
 *       })
 *   })
 *
 *   const response = yield* model.embed("hello")
 *   return response.vector
 * })
 * ```
 *
 * **Gotchas**
 *
 * - `embedMany([])` returns an empty response without invoking the provider.
 * - Provider batch responses must contain exactly one vector for each input,
 *   in the same order as the input array.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Request from "../../Request.ts"
import * as RequestResolver from "../../RequestResolver.ts"
import * as Schema from "../../Schema.ts"
import * as AiError from "./AiError.ts"

/**
 * Service tag for embedding model operations.
 *
 * **When to use**
 *
 * Use to retrieve or provide an `EmbeddingModel.Service` when an `Effect`
 * program needs to embed text into vectors.
 *
 * @see {@link Service} for the service contract provided by this tag
 * @see {@link make} for constructing an embedding model service from a provider
 * @see {@link Dimensions} for the current embedding vector size service
 *
 * @category services
 * @since 4.0.0
 */
export class EmbeddingModel extends Context.Service<EmbeddingModel, Service>()(
  "effect/unstable/ai/EmbeddingModel"
) {}

/**
 * Service tag that provides the current embedding dimensions.
 *
 * **When to use**
 *
 * Use to retrieve or provide the configured embedding vector size through
 * context.
 *
 * @see {@link EmbeddingModel} for the embedding service that uses these dimensions
 *
 * @category services
 * @since 4.0.0
 */
export class Dimensions extends Context.Service<Dimensions, number>()(
  "effect/unstable/ai/EmbeddingModel/Dimensions"
) {}

/**
 * Represents token usage metadata for embedding operations.
 *
 * **Details**
 *
 * Contains optional provider-reported `inputTokens`. The value may be
 * `undefined` when the provider does not report usage or when `embedMany([])`
 * bypasses the provider.
 *
 * @category models
 * @since 4.0.0
 */
export class EmbeddingUsage extends Schema.Class<EmbeddingUsage>(
  "effect/ai/EmbeddingModel/EmbeddingUsage"
)({
  inputTokens: Schema.UndefinedOr(Schema.Finite)
}) {}

/**
 * Response for a single embedding request.
 *
 * @category models
 * @since 4.0.0
 */
export class EmbedResponse extends Schema.Class<EmbedResponse>(
  "effect/ai/EmbeddingModel/EmbedResponse"
)({
  vector: Schema.Array(Schema.Finite)
}) {}

/**
 * Response for batch embedding requests containing per-input embeddings and usage
 * metadata.
 *
 * **Details**
 *
 * `embeddings` preserves batch order, and `usage` carries token metadata for
 * the operation.
 *
 * @see {@link EmbedResponse} for individual embedding responses
 * @see {@link EmbeddingUsage} for token usage metadata
 *
 * @category models
 * @since 4.0.0
 */
export class EmbedManyResponse extends Schema.Class<EmbedManyResponse>(
  "effect/ai/EmbeddingModel/EmbedManyResponse"
)({
  embeddings: Schema.Array(EmbedResponse),
  usage: EmbeddingUsage
}) {}

/**
 * Provider input options for embedding requests.
 *
 * @category models
 * @since 4.0.0
 */
export interface ProviderOptions {
  readonly inputs: ReadonlyArray<string>
}

/**
 * Provider response for batch embedding requests.
 *
 * @category models
 * @since 4.0.0
 */
export interface ProviderResponse {
  readonly results: Array<Array<number>>
  readonly usage: {
    readonly inputTokens: number | undefined
  }
}

/**
 * Represents a tagged request used by request resolvers for embedding operations.
 *
 * **When to use**
 *
 * Use when building or calling a low-level embedding request resolver and you
 * need a typed request for one input that resolves to `EmbedResponse`.
 *
 * @see {@link Service} for the resolver-bearing service contract
 * @see {@link make} for constructing the request resolver from a provider implementation
 * @see {@link EmbedResponse} for the response produced by this request
 *
 * @category constructors
 * @since 4.0.0
 */
export class EmbeddingRequest extends Request.TaggedClass("EmbeddingRequest")<
  { readonly input: string },
  EmbedResponse,
  AiError.AiError
> {}

/**
 * Defines the service interface for embedding operations.
 *
 * @category models
 * @since 4.0.0
 */
export interface Service {
  readonly resolver: RequestResolver.RequestResolver<EmbeddingRequest>
  readonly embed: (input: string) => Effect.Effect<EmbedResponse, AiError.AiError>
  readonly embedMany: (input: ReadonlyArray<string>) => Effect.Effect<EmbedManyResponse, AiError.AiError>
}

const invalidProviderResponse = (description: string): AiError.AiError =>
  AiError.make({
    module: "EmbeddingModel",
    method: "embedMany",
    reason: new AiError.InvalidOutputError({ description })
  })

/**
 * Creates an EmbeddingModel service from a provider embedMany implementation.
 *
 * **When to use**
 *
 * Use to adapt a provider's batch embedding implementation into an
 * `EmbeddingModel.Service` that offers single-input and batch embedding
 * operations.
 *
 * **Details**
 *
 * The returned service builds single-input `embed` calls through a request
 * resolver, so concurrent `embed` requests can be batched into one provider
 * `embedMany` call. Direct `embedMany` calls pass the input array to the
 * provider, while `embedMany([])` returns an empty response without calling the
 * provider.
 *
 * **Gotchas**
 *
 * Provider responses are interpreted positionally and must contain exactly one
 * result for each requested input. If the provider returns a different number
 * of results, `embed` and `embedMany` fail with `AiError.InvalidOutputError`.
 *
 * @see {@link Service} for the service shape returned by this constructor
 * @see {@link ProviderOptions} for the input passed to the provider implementation
 * @see {@link ProviderResponse} for the provider response contract consumed by this constructor
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (params: {
  readonly embedMany: (options: ProviderOptions) => Effect.Effect<ProviderResponse, AiError.AiError>
}) => Effect.Effect<Service> = Effect.fnUntraced(function*(params) {
  const resolver = RequestResolver.make<EmbeddingRequest>((entries) =>
    Effect.flatMap(
      params.embedMany({
        inputs: entries.map((entry) => entry.request.input)
      }),
      (response) =>
        Effect.map(mapProviderResults(entries.length, response.results), (embeddings) => {
          for (let i = 0; i < entries.length; i++) {
            entries[i].completeUnsafe(Exit.succeed(embeddings[i]))
          }
        })
    )
  ).pipe(
    RequestResolver.withSpan("EmbeddingModel.resolver")
  )

  return EmbeddingModel.of({
    resolver,
    embed: (input) =>
      Effect.request(new EmbeddingRequest({ input }), resolver).pipe(
        Effect.withSpan("EmbeddingModel.embed")
      ),
    embedMany: (input) =>
      (input.length === 0
        ? Effect.succeed(
          new EmbedManyResponse({
            embeddings: [],
            usage: new EmbeddingUsage({ inputTokens: undefined })
          })
        )
        : params.embedMany({ inputs: input }).pipe(
          Effect.flatMap((response) =>
            mapProviderResults(input.length, response.results).pipe(
              Effect.map((embeddings) =>
                new EmbedManyResponse({
                  embeddings,
                  usage: new EmbeddingUsage({
                    inputTokens: response.usage.inputTokens
                  })
                })
              )
            )
          )
        )).pipe(Effect.withSpan("EmbeddingModel.embedMany"))
  })
})

const mapProviderResults = (
  inputLength: number,
  results: Array<Array<number>>
): Effect.Effect<Array<EmbedResponse>, AiError.AiError> => {
  const embeddings = new Array<EmbedResponse>(inputLength)
  if (results.length !== inputLength) {
    return Effect.fail(
      invalidProviderResponse(
        `Provider returned ${results.length} embeddings but expected ${inputLength}`
      )
    )
  }
  for (let i = 0; i < results.length; i++) {
    const vector = results[i]
    embeddings[i] = new EmbedResponse({ vector })
  }
  return Effect.succeed(embeddings)
}
