/**
 * The `AnthropicTelemetry` module adds Anthropic-specific attributes to the
 * provider-neutral GenAI telemetry model. It keeps the standard
 * `Telemetry.addGenAIAnnotations` attributes and adds Anthropic request and
 * response metadata under the `gen_ai.anthropic.*` OpenTelemetry namespaces.
 *
 * **Mental model**
 *
 * - Standard GenAI attributes come from `effect/unstable/ai/Telemetry`
 * - Anthropic request attributes are written under
 *   `gen_ai.anthropic.request.*`
 * - Anthropic response attributes are written under
 *   `gen_ai.anthropic.response.*`
 * - Attribute option keys are written in camelCase and converted to
 *   OpenTelemetry snake_case attribute names
 * - {@link addGenAIAnnotations} mutates the supplied span by adding any
 *   non-nullish attributes from the option object
 *
 * **Common tasks**
 *
 * - Use {@link AnthropicTelemetryAttributes} when typing the complete set of
 *   standard and Anthropic-specific span attributes
 * - Pass `anthropic.request` data for options such as extended thinking and
 *   thinking budget tokens
 * - Pass `anthropic.response` data for response details such as stop reason and
 *   cache token counts
 * - Use {@link addGenAIAnnotations} from an Anthropic model span to keep
 *   standard GenAI and provider-specific annotations together
 *
 * **Gotchas**
 *
 * - This module only annotates spans; it does not start spans or export traces
 * - Null and undefined attribute values are skipped instead of being written
 * - The helper accepts both direct and data-last forms because it is built with
 *   `dual`
 *
 * @since 4.0.0
 */
import { dual } from "effect/Function"
import * as String from "effect/String"
import type { Span } from "effect/Tracer"
import type { Simplify } from "effect/Types"
import * as Telemetry from "effect/unstable/ai/Telemetry"

/**
 * The attributes used to describe telemetry in the context of Generative
 * Artificial Intelligence (GenAI) Models requests and responses.
 *
 * **Details**
 *
 * These attributes follow the OpenTelemetry generative AI semantic
 * conventions:
 * https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/
 *
 * @category models
 * @since 4.0.0
 */
export type AnthropicTelemetryAttributes = Simplify<
  & Telemetry.GenAITelemetryAttributes
  & Telemetry.AttributesWithPrefix<RequestAttributes, "gen_ai.anthropic.request">
  & Telemetry.AttributesWithPrefix<ResponseAttributes, "gen_ai.anthropic.response">
>

/**
 * All telemetry attributes which are part of the GenAI specification,
 * including the Anthropic-specific attributes.
 *
 * @category models
 * @since 4.0.0
 */
export type AllAttributes = Telemetry.AllAttributes & RequestAttributes & ResponseAttributes

/**
 * Telemetry attributes which are part of the GenAI specification and are
 * namespaced by `gen_ai.anthropic.request`.
 *
 * @category models
 * @since 4.0.0
 */
export interface RequestAttributes {
  /**
   * Whether extended thinking is enabled.
   */
  readonly extendedThinking?: boolean | null | undefined
  /**
   * The budget tokens for extended thinking.
   */
  readonly thinkingBudgetTokens?: number | null | undefined
}

/**
 * Telemetry attributes which are part of the GenAI specification and are
 * namespaced by `gen_ai.anthropic.response`.
 *
 * @category models
 * @since 4.0.0
 */
export interface ResponseAttributes {
  /**
   * The stop reason from the response.
   */
  readonly stopReason?: string | null | undefined
  /**
   * Number of cache creation input tokens.
   */
  readonly cacheCreationInputTokens?: number | null | undefined
  /**
   * Number of cache read input tokens.
   */
  readonly cacheReadInputTokens?: number | null | undefined
}

/**
 * Options accepted by `addGenAIAnnotations`, combining standard GenAI telemetry attributes with optional Anthropic request and response attributes.
 *
 * @category models
 * @since 4.0.0
 */
export type AnthropicTelemetryAttributeOptions = Telemetry.GenAITelemetryAttributeOptions & {
  anthropic?: {
    request?: RequestAttributes | undefined
    response?: ResponseAttributes | undefined
  } | undefined
}

const addAnthropicRequestAttributes = Telemetry.addSpanAttributes("gen_ai.anthropic.request", String.camelToSnake)<
  RequestAttributes
>
const addAnthropicResponseAttributes = Telemetry.addSpanAttributes("gen_ai.anthropic.response", String.camelToSnake)<
  ResponseAttributes
>

/**
 * Applies the specified Anthropic GenAI telemetry attributes to the provided
 * `Span`.
 *
 * **When to use**
 *
 * Use to annotate an Anthropic model span with standard GenAI telemetry
 * attributes and Anthropic-specific request or response metadata.
 *
 * **Gotchas**
 *
 * This method mutates the `Span` in place.
 *
 * @category utils
 * @since 4.0.0
 */
export const addGenAIAnnotations: {
  (options: AnthropicTelemetryAttributeOptions): (span: Span) => void
  (span: Span, options: AnthropicTelemetryAttributeOptions): void
} = dual(2, (span: Span, options: AnthropicTelemetryAttributeOptions) => {
  Telemetry.addGenAIAnnotations(span, options)
  if (options.anthropic != null) {
    if (options.anthropic.request != null) {
      addAnthropicRequestAttributes(span, options.anthropic.request)
    }
    if (options.anthropic.response != null) {
      addAnthropicResponseAttributes(span, options.anthropic.response)
    }
  }
})
