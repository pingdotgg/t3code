/**
 * The `OpenRouterConfig` module lets a workflow temporarily customize the HTTP
 * client used by generated OpenRouter request methods. `OpenRouterClient` reads
 * this scoped transform when generated client operations execute, so callers can
 * add middleware or instrumentation without rebuilding the client layer.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import type { HttpClient } from "effect/unstable/http/HttpClient"

/**
 * Context service for scoped OpenRouter provider configuration used by client
 * operations.
 *
 * **When to use**
 *
 * Use as the context service tag when manually providing or reading scoped
 * OpenRouter provider configuration in an Effect context.
 *
 * @see {@link withClientTransform} for scoping an HTTP client transformation
 *
 * @category services
 * @since 4.0.0
 */
export class OpenRouterConfig extends Context.Service<
  OpenRouterConfig,
  OpenRouterConfig.Service
>()("@effect/ai-openrouter/OpenRouterConfig") {
  /**
   * Gets the configured OpenRouter service from the current context when present.
   *
   * @since 4.0.0
   */
  static readonly getOrUndefined: Effect.Effect<typeof OpenRouterConfig.Service | undefined> = Effect.map(
    Effect.context<never>(),
    (services) => services.mapUnsafe.get(OpenRouterConfig.key)
  )
}

/**
 * Types associated with the `OpenRouterConfig` context service.
 *
 * @since 4.0.0
 */
export declare namespace OpenRouterConfig {
  /**
   * Configuration values read by OpenRouter provider operations when resolving
   * the generated HTTP client.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Service {
    readonly transformClient?: ((client: HttpClient) => HttpClient) | undefined
  }
}

/**
 * Provides a scoped transform for the OpenRouter HTTP client used by provider
 * operations.
 *
 * **When to use**
 *
 * Use when you need temporary OpenRouter HTTP client customization for a
 * single effect or workflow without rebuilding the client layer.
 *
 * **Details**
 *
 * Supports both data-first and data-last forms. The transform is stored in the
 * scoped `OpenRouterConfig` service and read by generated OpenRouter request
 * operations while running the supplied effect.
 *
 * **Gotchas**
 *
 * If a transform is already present in the scoped config, this helper replaces
 * it. Compose transforms manually when both should apply. Streaming chat
 * completion requests are sent directly by `OpenRouterClient.make` and do not
 * read this scoped transform.
 *
 * @category configuration
 * @since 4.0.0
 */
export const withClientTransform: {
  (transform: (client: HttpClient) => HttpClient): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Effect.Effect<A, E, R>, transform: (client: HttpClient) => HttpClient): Effect.Effect<A, E, R>
} = dual<
  (transform: (client: HttpClient) => HttpClient) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  <A, E, R>(self: Effect.Effect<A, E, R>, transform: (client: HttpClient) => HttpClient) => Effect.Effect<A, E, R>
>(
  2,
  (self, transformClient) =>
    Effect.flatMap(
      OpenRouterConfig.getOrUndefined,
      (config) => Effect.provideService(self, OpenRouterConfig, { ...config, transformClient })
    )
)
