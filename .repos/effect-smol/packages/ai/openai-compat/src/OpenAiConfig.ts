/**
 * The `OpenAiConfig` module provides shared configuration for clients that
 * talk to OpenAI-compatible APIs. It is used to customize the HTTP client
 * wiring around a provider without changing the higher-level model,
 * embeddings, or tool-calling APIs that consume the client.
 *
 * **Common tasks**
 *
 * - Install a client transform with {@link withClientTransform}
 * - Add provider-specific HTTP behavior, such as headers, retries, proxies, or
 *   instrumentation
 * - Read the active configuration from the Effect context when implementing
 *   OpenAI-compatible integrations
 *
 * **Gotchas**
 *
 * - The transform receives and returns an `HttpClient`, so it should preserve
 *   the existing client behavior unless it intentionally replaces it
 * - Configuration is provided through Effect context and is scoped to the
 *   effect that receives the service
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import type { HttpClient } from "effect/unstable/http/HttpClient"

/**
 * Context service for OpenAI-compatible client configuration in the current
 * Effect scope.
 *
 * **When to use**
 *
 * Use as the context service for OpenAI-compatible client configuration when you
 * need to provide or read scoped HTTP client transforms through Effect context.
 *
 * @see {@link withClientTransform} for scoping an HTTP client transformation
 *
 * @category services
 * @since 4.0.0
 */
export class OpenAiConfig extends Context.Service<
  OpenAiConfig,
  OpenAiConfig.Service
>()("@effect/ai-openai-compat/OpenAiConfig") {
  /**
   * Gets the configured OpenAI-compatible service from the current context when present.
   *
   * @since 4.0.0
   */
  static readonly getOrUndefined: Effect.Effect<typeof OpenAiConfig.Service | undefined> = Effect.map(
    Effect.context<never>(),
    (context) => context.mapUnsafe.get(OpenAiConfig.key)
  )
}

/**
 * Types associated with the `OpenAiConfig` context service.
 *
 * @since 4.0.0
 */
export declare namespace OpenAiConfig {
  /**
   * Configuration consumed by OpenAI-compatible clients when they build or
   * resolve the underlying HTTP client.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Service {
    readonly transformClient?: ((client: HttpClient) => HttpClient) | undefined
  }
}

/**
 * Provides an HTTP client transform for the supplied effect.
 *
 * **When to use**
 *
 * Use to add provider-specific OpenAI-compatible HTTP behavior, such as
 * headers, retries, instrumentation, or proxy routing.
 *
 * **Details**
 *
 * OpenAI-compatible provider services read the transform from the
 * `OpenAiConfig` context.
 *
 * @category configuration
 * @since 4.0.0
 */
export const withClientTransform: {
  (transform: (client: HttpClient) => HttpClient): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  <A, E, R>(self: Effect.Effect<A, E, R>, transform: (client: HttpClient) => HttpClient): Effect.Effect<A, E, R>
} = dual(2, <A, E, R>(
  self: Effect.Effect<A, E, R>,
  transformClient: (client: HttpClient) => HttpClient
) =>
  Effect.flatMap(
    OpenAiConfig.getOrUndefined,
    (config) => Effect.provideService(self, OpenAiConfig, { ...config, transformClient })
  ))
