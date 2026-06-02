/**
 * Code generator service wrapping @effect/openapi-generator.
 *
 * @since 4.0.0
 */
import * as OpenApiGenerator from "@effect/openapi-generator/OpenApiGenerator"
import * as OpenApiPatch from "@effect/openapi-generator/OpenApiPatch"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as JsonSchema from "effect/JsonSchema"
import * as Layer from "effect/Layer"
import * as Path_ from "effect/Path"
import type * as Schema from "effect/Schema"
import type { DiscoveredProvider } from "./Discovery.ts"

/**
 * Error during code generation.
 *
 * **Example** (Creating a generation error)
 *
 * ```ts
 * import * as Generator from "@effect/ai-codegen/Generator"
 *
 * const error = new Generator.GenerationError({
 *   provider: "openai",
 *   cause: new Error("Invalid spec")
 * })
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export class GenerationError extends Data.TaggedError("GenerationError")<{
  readonly provider: string
  readonly cause: unknown
}> {}

/**
 * Error during patch application.
 *
 * **Example** (Creating a patch error)
 *
 * ```ts
 * import * as Generator from "@effect/ai-codegen/Generator"
 *
 * const error = new Generator.PatchError({
 *   provider: "openai",
 *   cause: new Error("Invalid patch")
 * })
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export class PatchError extends Data.TaggedError("PatchError")<{
  readonly provider: string
  readonly cause: unknown
}> {}

/**
 * Service for generating Effect code from OpenAPI specs.
 *
 * @category models
 * @since 4.0.0
 */
export interface CodeGenerator {
  readonly generate: (
    provider: DiscoveredProvider,
    spec: unknown
  ) => Effect.Effect<string, GenerationError | PatchError, FileSystem.FileSystem | Path_.Path>
}

/**
 * Service tag for generating Effect client code from OpenAPI specifications.
 *
 * @category tags
 * @since 4.0.0
 */
export const CodeGenerator: Context.Service<CodeGenerator, CodeGenerator> = Context.Service(
  "@effect/ai-codegen/CodeGenerator"
)

/**
 * Layer providing the CodeGenerator service.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  CodeGenerator,
  never,
  OpenApiGenerator.OpenApiGenerator | FileSystem.FileSystem | Path_.Path
> = Effect.gen(function*() {
  const openApiGen = yield* OpenApiGenerator.OpenApiGenerator
  const pathService = yield* Path_.Path

  const applyPatches = Effect.fn("applyPatches")(function*(
    provider: DiscoveredProvider,
    spec: Schema.Json
  ) {
    const patchInputs = provider.config.patchList
    if (patchInputs.length === 0) {
      return spec
    }

    // Parse all patches, resolving file paths relative to the provider package
    const parsedPatches = yield* Effect.forEach(patchInputs, (input) => {
      // If it looks like a file path and is not absolute, resolve relative to package
      const resolvedInput = !input.startsWith("[") && !pathService.isAbsolute(input)
        ? pathService.join(provider.packagePath, input)
        : input
      return OpenApiPatch.parsePatchInput(resolvedInput).pipe(
        Effect.map((patch) => ({ source: resolvedInput, patch }))
      )
    }).pipe(
      Effect.mapError((cause) => new PatchError({ provider: provider.name, cause }))
    )

    // Apply all patches to the spec
    return yield* OpenApiPatch.applyPatches(parsedPatches, spec).pipe(
      Effect.mapError((cause) => new PatchError({ provider: provider.name, cause }))
    )
  })

  const generate = Effect.fn("generate")(function*(
    provider: DiscoveredProvider,
    spec: unknown
  ) {
    // Apply patches if any are configured
    const patchedSpec = yield* applyPatches(provider, spec as Schema.Json)

    const excludeAnnotations = provider.config.excludeAnnotationsList
    const disableAdditionalProperties = provider.config.shouldDisableAdditionalProperties

    const exclude = excludeAnnotations ? new Set(excludeAnnotations) : undefined
    const onEnter = (exclude || disableAdditionalProperties)
      ? (js: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
        const out = { ...js }
        if (exclude) {
          for (const key of exclude) delete out[key]
        }
        if (disableAdditionalProperties && out.type === "object") {
          out.additionalProperties = false
        }
        return out
      }
      : undefined

    return yield* openApiGen
      .generate(patchedSpec as unknown as Parameters<typeof openApiGen.generate>[0], {
        name: provider.config.clientName,
        format: provider.config.isTypeOnly ? "httpclient-type-only" : "httpclient",
        onEnter
      })
      .pipe(
        Effect.mapError((cause) => new GenerationError({ provider: provider.name, cause }))
      )
  })

  return { generate }
}).pipe(Layer.effect(CodeGenerator))

/**
 * Layer providing the CodeGenerator with schema transformer (default).
 *
 * @category layers
 * @since 4.0.0
 */
export const layerSchema: Layer.Layer<CodeGenerator, never, FileSystem.FileSystem | Path_.Path> = layer.pipe(
  Layer.provide(OpenApiGenerator.layerTransformerSchema)
)

/**
 * Layer providing the CodeGenerator with TypeScript-only transformer.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerTypeScript: Layer.Layer<CodeGenerator, never, FileSystem.FileSystem | Path_.Path> = layer.pipe(
  Layer.provide(OpenApiGenerator.layerTransformerTs)
)
