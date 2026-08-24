/**
 * Wraps an AI model layer with provider and model metadata.
 *
 * A `Model` can be used anywhere its underlying `Layer` can be used. It also
 * provides the current provider name and model name through the Effect context.
 * This module includes the `Model` interface, the `ProviderName` and
 * `ModelName` service tags, and the `make` constructor. Models can also capture
 * their required services from the current context when they need to be used
 * inside another Effect service.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import { identity } from "../../Function.ts"
import { PipeInspectableProto } from "../../internal/core.ts"
import * as Layer from "../../Layer.ts"

const TypeId = "~effect/ai/Model" as const

/**
 * A Model represents a provider-specific AI service.
 *
 * **When to use**
 *
 * Use when you use a Model directly as a Layer to provide a particular model implementation
 * to an Effect program, or use it as an Effect to "lift" dependencies of the
 * Model constructor into the parent Effect when you want to use a Model from
 * within an Effect service.
 *
 * @category models
 * @since 4.0.0
 */
export interface Model<in out Provider, in out Provides, in out Requires>
  extends Layer.Layer<Provides | ProviderName | ModelName, never, Requires>
{
  readonly [TypeId]: typeof TypeId

  /**
   * The provider identifier (e.g., "openai", "anthropic", "amazon-bedrock").
   */
  readonly provider: Provider

  /**
   * Returns a `Layer` with the requirements satisfied, using the current context.
   */
  readonly captureRequirements: Effect.Effect<
    Layer.Layer<Provides | ProviderName | ModelName>,
    never,
    Requires
  >
}

/**
 * Service tag that provides the current large language model provider name.
 *
 * **Details**
 *
 * This tag is automatically provided by Model instances and can be used to
 * access the name of the provider that is currently in use within a given
 * Effect program.
 *
 * @category services
 * @since 4.0.0
 */
export class ProviderName extends Context.Service<ProviderName, string>()(
  "effect/unstable/ai/Model/ProviderName"
) {}

/**
 * Service tag that provides the current large language model name.
 *
 * **Details**
 *
 * This tag is automatically provided by Model instances and can be used to
 * access the name of the model that is currently in use within a given Effect
 * program.
 *
 * @category services
 * @since 4.0.0
 */
export class ModelName extends Context.Service<ModelName, string>()(
  "effect/unstable/ai/Model/ModelName"
) {}

const Proto = {
  ...PipeInspectableProto,
  [TypeId]: TypeId,
  ["~effect/Layer"]: {
    _ROut: identity,
    _E: identity,
    _RIn: identity
  },
  get captureRequirements() {
    const self = this as any as Model<any, any, any>
    return Effect.contextWith((context: Context.Context<never>) =>
      Effect.succeed(Layer.provide(self, Layer.succeedContext(context)))
    )
  },
  toJSON(this: Model<any, any, any>): unknown {
    return {
      _id: "effect/ai/Model",
      provider: this.provider
    }
  }
}

/**
 * Creates a Model from a provider name and a Layer that constructs AI services.
 *
 * **Example** (Providing model metadata)
 *
 * ```ts
 * import { Effect } from "effect"
 * import type { Layer } from "effect"
 * import { LanguageModel, Model } from "effect/unstable/ai"
 *
 * declare const bedrockLayer: Layer.Layer<LanguageModel.LanguageModel>
 *
 * // Model automatically provides ProviderName and ModelName services
 * const checkProviderAndGenerate = Effect.gen(function*() {
 *   const provider = yield* Model.ProviderName
 *   const modelName = yield* Model.ModelName
 *
 *   console.log(`Generating with: ${provider}/${modelName}`)
 *
 *   return yield* LanguageModel.generateText({
 *     prompt: `Hello from ${provider}!`
 *   })
 * })
 *
 * const program = checkProviderAndGenerate.pipe(
 *   Effect.provide(Model.make("amazon-bedrock", "claude-3-5-haiku", bedrockLayer))
 * )
 * // Will log: "Generating with: amazon-bedrock/claude-3-5-haiku"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <const Provider extends string, const Name extends string, Provides, Requires>(
  /**
   * Provider identifier (e.g., "openai", "anthropic", "amazon-bedrock").
   */
  provider: Provider,
  /**
   * Model identifier (e.g., "gpt-5", "claude-3-5-haiku").
   */
  modelName: Name,
  /**
   * Layer that provides the AI services for this provider.
   */
  layer: Layer.Layer<Provides, never, Requires>
): Model<Provider, Provides, Requires> =>
  Object.assign(
    Object.create(Proto),
    { provider },
    Layer.merge(
      layer,
      Layer.succeedContext(
        ProviderName.context(provider).pipe(
          Context.add(ModelName, modelName)
        )
      )
    )
  )
