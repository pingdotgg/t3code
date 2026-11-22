/**
 * The `AmazonBedrockConfig` module provides contextual configuration for the
 * Amazon Bedrock AI provider integration. It is used to customize the
 * underlying HTTP client without changing individual request code.
 *
 * @stability unstable
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import type { HttpClient } from "effect/http/HttpClient"

/**
 * Service tag for Amazon Bedrock client configuration overrides, such as
 * transformations applied to the underlying HTTP client.
 *
 * @stability unstable
 * @category services
 * @since 4.0.0
 */
export class AmazonBedrockConfig extends Context.Service<
  AmazonBedrockConfig,
  AmazonBedrockConfig.Service
>()("@effect/ai-amazon-bedrock/AmazonBedrockConfig") {
  /**
   * Gets the configured Amazon Bedrock service from the current context when
   * present.
   *
   * @since 4.0.0
   */
  static readonly getOrUndefined: Effect.Effect<typeof AmazonBedrockConfig.Service | undefined> = Effect.map(
    Effect.context<never>(),
    Context.getOrUndefined(AmazonBedrockConfig)
  )
}

/**
 * Namespace containing types associated with the `AmazonBedrockConfig` service.
 *
 * @stability unstable
 * @since 4.0.0
 */
export declare namespace AmazonBedrockConfig {
  /**
   * Configuration provided through `AmazonBedrockConfig`.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Service {
    readonly transformClient?: ((client: HttpClient) => HttpClient) | undefined
  }
}

/**
 * Runs an effect with an `AmazonBedrockConfig` override that transforms the
 * underlying `HttpClient` used by Amazon Bedrock requests.
 *
 * @stability unstable
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
    AmazonBedrockConfig.getOrUndefined,
    (config) => Effect.provideService(self, AmazonBedrockConfig, { ...config, transformClient })
  ))
