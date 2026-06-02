/**
 * The `AnthropicConfig` module provides contextual configuration for the
 * Anthropic AI provider integration. It is used to customize the generated
 * Anthropic HTTP client without changing individual request code.
 *
 * **Common tasks**
 *
 * - Provide a shared `HttpClient` transformation for Anthropic requests
 * - Add provider-specific concerns such as request instrumentation, proxying,
 *   retries, or header manipulation
 * - Scope a client transformation to a single effect with {@link withClientTransform}
 *
 * **Gotchas**
 *
 * - Configuration is read from the Effect context, so overrides only apply to
 *   effects run inside the configured scope
 * - `withClientTransform` replaces the current `transformClient` value while
 *   preserving any other Anthropic configuration fields
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import type { HttpClient } from "effect/unstable/http/HttpClient"

/**
 * Service tag for Anthropic client configuration overrides, such as transformations applied to the generated HTTP client.
 *
 * **When to use**
 *
 * Use when a layer or integration needs to provide or read Anthropic client
 * configuration through Effect's context.
 *
 * @see {@link withClientTransform} for scoping an HTTP client transformation
 *
 * @category services
 * @since 4.0.0
 */
export class AnthropicConfig extends Context.Service<
  AnthropicConfig,
  AnthropicConfig.Service
>()("@effect/ai-anthropic/AnthropicConfig") {
  /**
   * Gets the configured Anthropic service from the current context when present.
   *
   * @since 4.0.0
   */
  static readonly getOrUndefined: Effect.Effect<typeof AnthropicConfig.Service | undefined> = Effect.map(
    Effect.context<never>(),
    (services) => services.mapUnsafe.get(AnthropicConfig.key)
  )
}

/**
 * Namespace containing types associated with the `AnthropicConfig` service.
 *
 * @since 4.0.0
 */
export declare namespace AnthropicConfig {
  /**
   * Configuration provided through `AnthropicConfig`.
   *
   * **Details**
   *
   * Use `transformClient` to wrap or replace the `HttpClient` used by generated Anthropic API requests.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Service {
    readonly transformClient?: ((client: HttpClient) => HttpClient) | undefined
  }
}

/**
 * Runs an effect with an `AnthropicConfig` override that transforms the underlying `HttpClient` used by generated Anthropic requests.
 *
 * **When to use**
 *
 * Use when you need to apply a temporary `HttpClient` transformation, such as adding middleware or logging, to a
 * specific scope of an effectful program.
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
    AnthropicConfig.getOrUndefined,
    (config) => Effect.provideService(self, AnthropicConfig, { ...config, transformClient })
  ))
