/**
 * The `Toolkit` module groups AI `Tool` definitions into a single typed service
 * that can execute tool calls by name. A toolkit is the runtime bridge between
 * declarative tool schemas and the handler functions your application provides
 * for a language model workflow.
 *
 * **Mental model**
 *
 * - A `Tool` describes one callable operation: its name, parameter schema,
 *   success schema, and failure behavior.
 * - A `Toolkit` is a record of tools that also carries the handler requirements
 *   needed to execute those tools.
 * - `toolkit.toLayer(...)` and `toolkit.toHandlers(...)` bind handlers into
 *   `Context`, so yielding a toolkit produces a value with a `handle` function.
 * - `handle` validates parameters, runs the matching handler, and returns a
 *   `Stream` of preliminary and final encoded results.
 *
 * **Common tasks**
 *
 * - Build a toolkit from tools: {@link make}
 * - Merge independently defined toolkits: {@link merge}
 * - Provide handlers with `toolkit.toLayer(...)` or `toolkit.toHandlers(...)`
 * - Emit progress from a long-running handler with `context.preliminary(...)`
 *
 * **Gotchas**
 *
 * - Tool names are runtime lookup keys. When toolkits are merged, later tools
 *   replace earlier tools with the same name.
 * - Handler output is validated and encoded against the tool schemas; invalid
 *   output is reported as an AI error.
 * - The result of `handle` is a stream because handlers can emit preliminary
 *   results before the final value.
 *
 * **Example** (Creating and implementing toolkits)
 *
 * ```ts
 * import { Effect, Schema, Stream } from "effect"
 * import { Tool, Toolkit } from "effect/unstable/ai"
 *
 * const GetCurrentTime = Tool.make("GetCurrentTime", {
 *   description: "Get the current timestamp",
 *   success: Schema.Number
 * })
 *
 * const GetWeather = Tool.make("GetWeather", {
 *   description: "Get weather for a location",
 *   parameters: Schema.Struct({ location: Schema.String }),
 *   success: Schema.Struct({
 *     temperature: Schema.Number,
 *     condition: Schema.String
 *   })
 * })
 *
 * const MyToolkit = Toolkit.make(GetCurrentTime, GetWeather)
 *
 * const MyToolkitLayer = MyToolkit.toLayer({
 *   GetCurrentTime: () => Effect.succeed(1_704_067_200_000),
 *   GetWeather: ({ location }) =>
 *     Effect.succeed({
 *       temperature: 72,
 *       condition: `sunny in ${location}`
 *     })
 * })
 *
 * const program = Effect.gen(function*() {
 *   const toolkit = yield* MyToolkit
 *   const stream = yield* toolkit.handle("GetWeather", {
 *     location: "San Francisco"
 *   })
 *   const results = yield* Stream.runCollect(stream)
 *
 *   return Array.from(results, ({ result }) => result)
 * }).pipe(Effect.provide(MyToolkitLayer))
 *
 * console.log(Effect.runSync(program))
 * // [{ temperature: 72, condition: "sunny in San Francisco" }]
 * ```
 *
 * @since 4.0.0
 */
import type * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Effectable from "../../Effectable.ts"
import * as Fiber from "../../Fiber.ts"
import { identity } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Predicate from "../../Predicate.ts"
import * as Queue from "../../Queue.ts"
import * as Schema from "../../Schema.ts"
import type * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import * as AiError from "./AiError.ts"
import type * as Tool from "./Tool.ts"

const TypeId = "~effect/ai/Toolkit" as const

/**
 * Represents a collection of tools which can be used to enhance the
 * capabilities of a large language model.
 *
 * **Example** (Defining AI toolkits)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Tool, Toolkit } from "effect/unstable/ai"
 *
 * const SearchDocs = Tool.make("SearchDocs", {
 *   description: "Search project documentation",
 *   parameters: Schema.Struct({ query: Schema.String }),
 *   success: Schema.Array(Schema.String)
 * })
 *
 * const SummarizeText = Tool.make("SummarizeText", {
 *   description: "Summarize text",
 *   parameters: Schema.Struct({ text: Schema.String }),
 *   success: Schema.String
 * })
 *
 * const AiToolkit = Toolkit.make(SearchDocs, SummarizeText)
 *
 * console.log(Object.keys(AiToolkit.tools))
 * // ["SearchDocs", "SummarizeText"]
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export interface Toolkit<in out Tools extends Record<string, Tool.Any>> extends
  Effect.Effect<
    WithHandler<Tools>,
    never,
    Tool.HandlersFor<Tools>
  >
{
  new(_: never): {}

  readonly [TypeId]: typeof TypeId

  /**
   * A record containing all tools in this toolkit.
   */
  readonly tools: Tools

  /**
   * A helper method which can be used for type-safe handler declarations.
   */
  of<Handlers extends HandlersFrom<Tools>>(handlers: Handlers): Handlers

  /**
   * Converts a toolkit into a `Context` containing handlers for each tool
   * in the toolkit.
   */
  toHandlers<Handlers extends HandlersFrom<Tools>, EX = never, RX = never>(
    build: Handlers | Effect.Effect<Handlers, EX, RX>
  ): Effect.Effect<Context.Context<Tool.HandlersFor<Tools>>, EX, RX>

  /**
   * Converts a toolkit into a `Layer` containing handlers for each tool in the
   * toolkit.
   */
  toLayer<Handlers extends HandlersFrom<Tools>, EX = never, RX = never>(
    /**
     * Handler functions or Effect that produces handlers.
     */
    build: Handlers | Effect.Effect<Handlers, EX, RX>
  ): Layer.Layer<Tool.HandlersFor<Tools>, EX, Exclude<RX, Scope.Scope>>
}

/**
 * Context provided to tool handlers during execution.
 *
 * @category models
 * @since 4.0.0
 */
export interface HandlerContext<Tool extends Tool.Any> {
  /**
   * Emit a preliminary result during long-running tool calls.
   *
   * **Details**
   *
   * Preliminary results are streamed to the caller before the handler completes,
   * enabling real-time progress updates for lengthy operations.
   */
  readonly preliminary: (result: Tool.Success<Tool>) => Effect.Effect<void>
}

/**
 * Represents any `Toolkit` instance, used for generic constraints.
 *
 * @category utility types
 * @since 4.0.0
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly tools: Record<string, Tool.Any>
}

/**
 * A utility type which can be used to extract the tool definitions from a
 * toolkit.
 *
 * @category utility types
 * @since 4.0.0
 */
export type Tools<T> = T extends Toolkit<infer Tools> ? Tools : never

/**
 * A utility type which transforms either a record or an array of tools into
 * a record where keys are tool names and values are the tool instances.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ToolsByName<Tools> = Tools extends Record<string, Tool.Any> ?
  { readonly [Name in keyof Tools]: Tools[Name] }
  : Tools extends ReadonlyArray<Tool.Any> ? { readonly [Tool in Tools[number] as Tool["name"]]: Tool }
  : never

/**
 * A utility type that maps tool names to their required handler functions.
 *
 * **Details**
 *
 * Handlers can return either the tool's custom failure type, an `AiErrorReason`
 * (which will be wrapped in `AiError`), or a full `AiError`.
 *
 * @category utility types
 * @since 4.0.0
 */
export type HandlersFrom<Tools extends Record<string, Tool.Any>> = {
  readonly [Name in keyof Tools as Tool.RequiresHandler<Tools[Name]> extends true ? Name : never]: (
    params: Tool.Parameters<Tools[Name]>,
    context: HandlerContext<Tools[Name]>
  ) => Effect.Effect<
    Tool.Success<Tools[Name]>,
    Tool.Failure<Tools[Name]> | AiError.AiError | AiError.AiErrorReason,
    Tool.HandlerServices<Tools[Name]>
  >
}

/**
 * A toolkit instance with registered handlers ready for tool execution.
 *
 * @category models
 * @since 4.0.0
 */
export interface WithHandler<in out Tools extends Record<string, Tool.Any>> {
  /**
   * The tools available in this toolkit instance.
   */
  readonly tools: Tools

  /**
   * Executes a tool call by name.
   *
   * **Details**
   *
   * Validates the input parameters, executes the corresponding handler, and
   * streams back both the typed result and encoded result. Streaming allows
   * handlers to emit preliminary results before completion.
   */
  readonly handle: <Name extends keyof Tools>(
    /**
     * The name of the tool to execute.
     */
    name: Name,
    /**
     * Parameters to pass to the tool handler.
     */
    params: Tool.Parameters<Tools[Name]>
  ) => Effect.Effect<
    Stream.Stream<
      Tool.HandlerResult<Tools[Name]>,
      Tool.HandlerError<Tools[Name]>,
      Tool.HandlerServices<Tools[Name]>
    >,
    AiError.AiError
  >
}

/**
 * A utility type which can be used to extract the tools from a toolkit with
 * handlers.
 *
 * @category utility types
 * @since 4.0.0
 */
export type WithHandlerTools<T> = T extends WithHandler<infer Tools> ? Tools : never

const Proto = {
  ...Effectable.Prototype({
    label: "Toolkit",
    evaluate: Effect.fnUntraced(function*(this: Toolkit<Record<string, Tool.Any>>, parent) {
      const tools = this.tools
      const services = parent.context
      const schemasCache = new WeakMap<any, {
        readonly context: Context.Context<never>
        readonly handler: Tool.Handler<any>["handler"]
        readonly decodeParameters: (u: unknown) => Effect.Effect<unknown, Schema.SchemaError>
        readonly decodeResult: (u: unknown) => Effect.Effect<unknown, Schema.SchemaError>
        readonly encodeResult: (u: unknown) => Effect.Effect<unknown, Schema.SchemaError>
      }>()

      const getSchemas = (tool: Tool.Any) => {
        let schemas = schemasCache.get(tool)
        if (Predicate.isUndefined(schemas)) {
          const handler = services.mapUnsafe.get(tool.id)! as Tool.Handler<any>
          const resultSchema = tool.failureMode === "return"
            ? Schema.Union([tool.successSchema, tool.failureSchema, AiError.AiError])
            : tool.successSchema
          const decodeParameters = Schema.isSchema(tool.parametersSchema)
            ? Schema.decodeUnknownEffect(tool.parametersSchema) as any
            : (u: unknown) => Effect.succeed(u)
          const decodeResult = Schema.decodeUnknownEffect(resultSchema) as any
          const encodeResult = Schema.encodeUnknownEffect(resultSchema) as any
          schemas = {
            context: handler.context,
            handler: handler.handler,
            decodeParameters,
            decodeResult,
            encodeResult
          }
          schemasCache.set(tool, schemas)
        }
        return schemas
      }

      const handle = Effect.fnUntraced(function*(name: string, params: unknown) {
        const tool = tools[name]

        yield* Effect.annotateCurrentSpan({
          tool: name,
          parameters: params
        })

        // If the tool is not found, return an error
        if (Predicate.isUndefined(tool)) {
          return yield* AiError.make({
            module: "Toolkit",
            method: `${name}.handle`,
            reason: new AiError.ToolNotFoundError({
              toolName: name,
              availableTools: Object.keys(tools)
            })
          })
        }

        // Fetch cached schemas / handlers for the tool
        const schemas = getSchemas(tool)

        // Decode the tool call parameters which will be passed to the handler
        const decodedParams = yield* schemas.decodeParameters(params).pipe(
          Effect.mapError((cause) =>
            AiError.make({
              module: "Toolkit",
              method: `${name}.handle`,
              reason: new AiError.ToolParameterValidationError({
                toolName: name,
                toolParams: params,
                description: cause.message
              })
            })
          )
        )

        // Setup the handler context
        const queue = yield* Queue.make<{
          readonly result: any
          readonly isFailure: boolean
          readonly preliminary: boolean
        }, Cause.Done>()
        const context: HandlerContext<any> = {
          preliminary: (result) =>
            Effect.asVoid(Queue.offer(queue, {
              result,
              isFailure: false,
              preliminary: true
            }))
        }

        const fiber = yield* schemas.handler(decodedParams, context).pipe(
          Effect.flatMap((result) => Queue.offer(queue, { result, isFailure: false, preliminary: false })),
          Effect.updateContext((input) => Context.merge(schemas.context, input)),
          Effect.matchCauseEffect({
            onFailure: (cause) => Queue.failCause(queue, cause),
            onSuccess: () => Queue.end(queue)
          }),
          Effect.forkChild
        )

        const encodeResult = (result: any) =>
          schemas.encodeResult(result).pipe(
            Effect.mapError((cause) =>
              AiError.make({
                module: "Toolkit",
                method: `${name}.handle`,
                reason: new AiError.ToolResultEncodingError({
                  toolName: name,
                  toolResult: result,
                  description: cause.message
                })
              })
            )
          )

        const normalizeError = (error: unknown) => {
          // Schema errors indicate handler returned invalid data
          const normalizedError = Schema.isSchemaError(error)
            ? AiError.make({
              module: "Toolkit",
              method: `${name}.handle`,
              reason: new AiError.InvalidToolResultError({
                toolName: name,
                description: `Tool handler returned invalid result: ${error.message}`
              })
            })
            : AiError.isAiErrorReason(error)
            ? AiError.make({
              module: "Toolkit",
              method: `${name}.handle`,
              reason: error
            })
            : error
          return normalizedError
        }

        return Stream.fromQueue(queue).pipe(
          // If the tool handler failed, check the tool's failure mode to
          // determine how the result should be returned to the end user
          Stream.catch((error) => {
            const normalizedError = normalizeError(error)
            return tool.failureMode === "error"
              ? Stream.fail(normalizedError)
              : Stream.succeed({ result: normalizedError, isFailure: true, preliminary: false })
          }),
          Stream.mapEffect(Effect.fnUntraced(function*(output) {
            const encodedResult = yield* encodeResult(output.result)
            return { ...output, encodedResult }
          })),
          Stream.onEnd(Fiber.interrupt(fiber))
        ) satisfies Stream.Stream<Tool.HandlerResult<any>, any>
      })

      return {
        tools,
        handle: handle as any
      } satisfies WithHandler<Record<string, any>>
    })
  }),
  [TypeId]: TypeId,
  of: identity,
  toHandlers(
    this: Toolkit<Record<string, Tool.Any>>,
    build: Record<string, (params: any) => any> | Effect.Effect<Record<string, (params: any) => any>>
  ) {
    return Effect.gen({ self: this }, function*() {
      const services = yield* Effect.context<never>()
      const handlers = Effect.isEffect(build) ? yield* build : build
      const context = new Map<string, unknown>()
      for (const [name, handler] of Object.entries(handlers)) {
        const tool = this.tools[name]!
        context.set(tool.id, { name, handler, context: services })
      }
      return Context.makeUnsafe(context)
    })
  },
  toLayer(
    this: Toolkit<Record<string, Tool.Any>>,
    build: Record<string, (params: any) => any> | Effect.Effect<Record<string, (params: any) => any>>
  ) {
    return Layer.effectContext(this.toHandlers(build))
  },
  toJSON(this: Toolkit<any>): unknown {
    return {
      _id: "effect/ai/Toolkit",
      tools: Array.from(Object.values(this.tools)).map((tool) => (tool as Tool.Any).name)
    }
  }
}

const makeProto = <Tools extends Record<string, Tool.Any>>(tools: Tools): Toolkit<Tools> =>
  Object.assign(function() {}, Proto, { tools }) as any

const resolveInput = <Tools extends ReadonlyArray<Tool.Any>>(
  ...tools: Tools
): Record<string, Tools[number]> => {
  const output = {} as Record<string, Tools[number]>
  for (const tool of tools) {
    output[tool.name] = tool
  }
  return output
}

/**
 * An empty toolkit with no tools.
 *
 * **When to use**
 *
 * Use as a starting point for building toolkits or as a default value. Can
 * be extended using the merge function to add tools.
 *
 * @category constructors
 * @since 4.0.0
 */
export const empty: Toolkit<{}> = makeProto({})

/**
 * Creates a new toolkit from the specified tools.
 *
 * **Details**
 *
 * This is the primary constructor for creating toolkits. It accepts multiple
 * tools and organizes them into a toolkit that can be provided to AI language
 * models.
 *
 * **Example** (Creating a toolkit)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Tool, Toolkit } from "effect/unstable/ai"
 *
 * const GetCurrentTime = Tool.make("GetCurrentTime", {
 *   description: "Get the current timestamp",
 *   success: Schema.Number
 * })
 *
 * const GetWeather = Tool.make("get_weather", {
 *   description: "Get weather information",
 *   parameters: Schema.Struct({ location: Schema.String }),
 *   success: Schema.Struct({
 *     temperature: Schema.Number,
 *     condition: Schema.String
 *   })
 * })
 *
 * const toolkit = Toolkit.make(GetCurrentTime, GetWeather)
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <Tools extends ReadonlyArray<Tool.Any>>(
  ...tools: Tools
): Toolkit<ToolsByName<Tools>> => makeProto(resolveInput(...tools)) as any

/**
 * A utility type which flattens a record type for improved IDE display.
 *
 * @category utility types
 * @since 4.0.0
 */
export type SimplifyRecord<T> = { [K in keyof T]: T[K] } & {}

/**
 * A utility type which merges a union of tool records into a single record.
 *
 * @category utility types
 * @since 4.0.0
 */
export type MergeRecords<U> = {
  readonly [K in Extract<U extends unknown ? keyof U : never, string>]: Extract<
    U extends Record<K, infer V> ? V : never,
    Tool.Any
  >
}

/**
 * A utility type which merges the tools from multiple toolkits into a single
 * record.
 *
 * @category utility types
 * @since 4.0.0
 */
export type MergedTools<Toolkits extends ReadonlyArray<Any>> = SimplifyRecord<
  MergeRecords<Tools<Toolkits[number]>>
>

/**
 * Merges multiple toolkits into a single toolkit.
 *
 * **Details**
 *
 * Combines all tools from the provided toolkits into one unified toolkit.
 * If there are naming conflicts, tools from later toolkits will override
 * tools from earlier ones.
 *
 * **Example** (Merging toolkits)
 *
 * ```ts
 * import { Schema } from "effect"
 * import { Tool, Toolkit } from "effect/unstable/ai"
 *
 * const mathToolkit = Toolkit.make(
 *   Tool.make("add", { success: Schema.Number }),
 *   Tool.make("subtract", { success: Schema.Number })
 * )
 *
 * const utilityToolkit = Toolkit.make(
 *   Tool.make("get_time", { success: Schema.Number }),
 *   Tool.make("get_weather", { success: Schema.String })
 * )
 *
 * const combined = Toolkit.merge(mathToolkit, utilityToolkit)
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const merge = <const Toolkits extends ReadonlyArray<Any>>(
  /**
   * The toolkits to merge together.
   */
  ...toolkits: Toolkits
): Toolkit<MergedTools<Toolkits>> => {
  const tools = {} as Record<string, any>
  for (const toolkit of toolkits) {
    for (const [name, tool] of Object.entries(toolkit.tools)) {
      tools[name] = tool
    }
  }
  return makeProto(tools) as any
}
