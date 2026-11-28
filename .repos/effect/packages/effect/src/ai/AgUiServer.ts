/**
 * Serves Agent User Interaction (AG-UI) runs over HTTP.
 *
 * AG-UI clients POST a `RunAgentInput` as JSON and read the run's events as
 * Server-Sent Events, one JSON event per `data:` line. This module defines that
 * binding as an `HttpApiEndpoint`, so it can join an existing `HttpApi`, and
 * provides a layer that mounts a single run handler on an `HttpRouter`. The
 * `agent` constructor serves a `LanguageModel` with server tools, frontend
 * tools, and multiple model rounds.
 *
 * **Example** (Serving a model as an AG-UI agent)
 *
 * ```ts
 * import { AgUi, AgUiServer, LanguageModel } from "effect/ai"
 *
 * const AgentRoute = AgUiServer.layerHttp({
 *   path: "/agent",
 *   run: (input) =>
 *     LanguageModel.streamText({ prompt: AgUi.toPrompt(input) }).pipe(
 *       AgUi.fromStreamParts
 *     )
 * })
 * ```
 *
 * @stability experimental
 * @since 4.1.0
 */
import * as Context from "../Context.ts"
import * as Effect from "../Effect.ts"
import type * as FileSystem from "../FileSystem.ts"
import * as HttpApi from "../http-api/HttpApi.ts"
import * as HttpApiBuilder from "../http-api/HttpApiBuilder.ts"
import * as HttpApiEndpoint from "../http-api/HttpApiEndpoint.ts"
import * as HttpApiError from "../http-api/HttpApiError.ts"
import * as HttpApiGroup from "../http-api/HttpApiGroup.ts"
import * as HttpApiSchema from "../http-api/HttpApiSchema.ts"
import type * as Etag from "../http/Etag.ts"
import type * as HttpPlatform from "../http/HttpPlatform.ts"
import type * as HttpRouter from "../http/HttpRouter.ts"
import type * as JsonSchema from "../JsonSchema.ts"
import * as Layer from "../Layer.ts"
import * as Option from "../Option.ts"
import type * as Path from "../Path.ts"
import * as Schema from "../Schema.ts"
import * as Stream from "../Stream.ts"
import * as AgUi from "./AgUi.ts"
import * as AgUiSchema from "./AgUiSchema.ts"
import * as Chat from "./Chat.ts"
import { defaultIdGenerator, IdGenerator } from "./IdGenerator.ts"
import type * as LanguageModel from "./LanguageModel.ts"
import * as Prompt from "./Prompt.ts"
import type * as Response from "./Response.ts"
import * as Tool from "./Tool.ts"
import * as Toolkit from "./Toolkit.ts"

/**
 * Creates the `POST` endpoint declaration for AG-UI runs.
 *
 * **When to use**
 *
 * Use to add an AG-UI agent to an existing `HttpApi`, and implement it with
 * {@link handler}.
 *
 * **Details**
 *
 * The payload is a JSON `RunAgentInput`, so an invalid body is rejected with
 * `400` before the event stream opens, as is input an {@link agent} rejects.
 * The success response is a `text/event-stream` of AG-UI events sent as
 * `data:` lines, with `Cache-Control: no-cache` and a keepalive comment every
 * 15 seconds.
 *
 * @see {@link handler} for implementing the endpoint
 * @see {@link layerHttp} for serving a single agent without declaring an `HttpApi`
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.0
 */
export const endpoint = <const Name extends string, const Path extends HttpRouter.PathInput>(
  name: Name,
  path: Path
) =>
  HttpApiEndpoint.post(name, path, {
    payload: AgUiSchema.RunAgentInput,
    success: HttpApiSchema.WithHeaders(
      HttpApiSchema.StreamSse({ data: AgUiSchema.Event, keepAlive: "15 seconds" }),
      { "cache-control": Schema.Literal("no-cache") }
    ),
    error: HttpApiError.BadRequest
  })

/**
 * Creates an `HttpApiBuilder` handler for an {@link endpoint} from a function
 * that streams the events of one run.
 *
 * **Details**
 *
 * The stream returned by `run` is wrapped with `AgUi.withRunLifecycle`, so the
 * client receives `RUN_STARTED` first and exactly one `RUN_FINISHED` or
 * `RUN_ERROR` last. Failures of the stream, including events that cannot be
 * encoded as JSON, are logged and reported, and reach the client as a
 * `RUN_ERROR` without error details. The stream runs with the
 * services available to the handler.
 *
 * @see {@link endpoint} for declaring the endpoint
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.0
 */
export const handler = <E, R>(
  run: (input: AgUiSchema.RunAgentInput) => Stream.Stream<AgUiSchema.Event, E, R>
) =>
({ payload }: { readonly payload: AgUiSchema.RunAgentInput }) =>
  Effect.map(Effect.context<R>(), (context) => respond(payload, run(payload), context))

const respond = <E, R>(
  input: AgUiSchema.RunAgentInput,
  events: Stream.Stream<AgUiSchema.Event, E, R>,
  context: Context.Context<R>
) =>
  HttpApiSchema.withHeaders({
    body: events.pipe(
      // Serialize here so an unencodable event becomes a sanitized RUN_ERROR
      // rather than an HttpApi stream failure frame. The result is plain JSON
      // data that has already passed the encoding HttpApi applies to it.
      Stream.mapEffect(normalizeEvent),
      AgUi.withRunLifecycle(input),
      Stream.provideContext(context)
    ),
    headers: { "cache-control": "no-cache" as const }
  })

const EventJson = Schema.fromJsonString(AgUiSchema.Event)
const encodeEvent = Schema.encodeUnknownEffect(EventJson)
const decodeEvent = Schema.decodeUnknownEffect(EventJson)

// Round-trips the event through its JSON text. JSON can drop a required
// member, such as an undefined `value`, so decoding the text checks what
// HttpApi will encode before the event leaves the run
const normalizeEvent = (event: AgUiSchema.Event) => Effect.flatMap(encodeEvent(event), decodeEvent)

/**
 * Creates a layer that serves AG-UI runs at `path` on the current
 * `HttpRouter`.
 *
 * **Details**
 *
 * The route follows {@link endpoint}, and each request is answered by `run`
 * as described in {@link handler}. The returned layer needs the services
 * `HttpApiBuilder.layer` needs, which HTTP server layers usually provide.
 *
 * **Gotchas**
 *
 * Every field of the input comes from the client. Convert it with
 * `AgUi.toPrompt`, which drops client-supplied instructions by default.
 *
 * @see {@link endpoint} for adding an AG-UI agent to an existing `HttpApi`
 * @see {@link agent} for serving a `LanguageModel` with a toolkit
 *
 * @stability experimental
 * @category layers
 * @since 4.1.0
 */
export const layerHttp: {
  <R>(options: {
    readonly path: HttpRouter.PathInput
    readonly agent: Agent<R>
  }): Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | Etag.Generator | FileSystem.FileSystem | HttpPlatform.HttpPlatform | Path.Path | R
  >
  <E, R>(options: {
    readonly path: HttpRouter.PathInput
    readonly run: (input: AgUiSchema.RunAgentInput) => Stream.Stream<AgUiSchema.Event, E, R>
  }): Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | Etag.Generator | FileSystem.FileSystem | HttpPlatform.HttpPlatform | Path.Path | R
  >
} = (options: {
  readonly path: HttpRouter.PathInput
  readonly agent?: Agent<any> | undefined
  readonly run?: ((input: AgUiSchema.RunAgentInput) => Stream.Stream<AgUiSchema.Event, unknown, any>) | undefined
}): Layer.Layer<never, never, any> => {
  const api = HttpApi.make("effect/ai/AgUiServer").add(
    HttpApiGroup.make("agUi").add(endpoint("run", options.path))
  )
  // The overloads guarantee one of the two, but a variable passed to the run
  // overload may still carry `agent: undefined`, so test the value
  const agent = options.agent ?? fromRun(options.run!)
  return HttpApiBuilder.layer(api).pipe(
    Layer.provide(HttpApiBuilder.group(
      api,
      "agUi",
      (handlers) => Effect.map(agentHandler(agent), (run) => handlers.handle("run", run))
    ))
  )
}

const fromRun = (
  run: (input: AgUiSchema.RunAgentInput) => Stream.Stream<AgUiSchema.Event, unknown, any>
): Agent<any> => ({ run: (input) => Effect.succeed(run(input)) })

/**
 * Creates an `HttpApiBuilder` handler for an {@link endpoint} that serves an
 * {@link Agent}.
 *
 * **When to use**
 *
 * Use to serve an {@link agent} from an endpoint in an existing `HttpApi`.
 * Yield it while building the `HttpApiBuilder.group` that implements the
 * endpoint.
 *
 * **Details**
 *
 * The services the agent needs are captured when the handler is created. Each
 * request first runs the agent's validation, so a rejected input is answered
 * with `400` before the event stream opens. The events are then served as
 * described in {@link handler}.
 *
 * @see {@link handler} for serving a function that streams events
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.0
 */
export const agentHandler = <R>(agent: Agent<R>) =>
  Effect.map(
    Effect.context<R>(),
    (context) => ({ payload }: { readonly payload: AgUiSchema.RunAgentInput }) =>
      Effect.map(agent.run(payload), (events) => respond(payload, events, context))
  )

// =============================================================================
// Agent
// =============================================================================

/**
 * Service holding the input of the AG-UI run being served.
 *
 * **When to use**
 *
 * Use to read the run's `threadId`, `runId`, `state`, or `forwardedProps` in
 * a server tool's handler. Declare it in the tool's `dependencies`, and the
 * {@link agent} provides it for each run.
 *
 * @stability experimental
 * @category services
 * @since 4.1.0
 */
export class RunInput extends Context.Service<RunInput, AgUiSchema.RunAgentInput>()(
  "effect/ai/AgUiServer/RunInput"
) {}

/**
 * An AG-UI agent served by {@link layerHttp}.
 *
 * **Details**
 *
 * `run` either rejects the input, which answers the request with `400`, or
 * returns the run's event stream. `R` is the services the agent needs.
 *
 * @see {@link agent} for creating a `LanguageModel` agent
 *
 * @stability experimental
 * @category models
 * @since 4.1.0
 */
export interface Agent<R> {
  readonly run: (
    input: AgUiSchema.RunAgentInput
  ) => Effect.Effect<Stream.Stream<AgUiSchema.Event, unknown, R>, HttpApiError.BadRequest>
}

/**
 * Creates an AG-UI agent that answers each run with the current
 * `LanguageModel` and a toolkit.
 *
 * **Details**
 *
 * - The prompt is `system`, if given, followed by the run's conversation as
 *   converted by `AgUi.toPrompt`, which drops client-supplied instructions.
 * - The model is offered the server toolkit and each of the run's tools as a
 *   client-executed tool. A run whose tools reuse a server tool's name is
 *   rejected with `400`.
 * - Rounds follow `Chat.streamText` with `maxSteps`, so server tool results
 *   go back to the model until a round needs no tools, `maxSteps` rounds have
 *   run, or a tool call is left for the application.
 * - The run finishes with the token usage summed over every round. Frontend
 *   tool calls left for the application are listed as
 *   `pendingToolCallIds`, and the application answers them with tool
 *   messages in its next run.
 * - Server tool handlers can read the run's input from {@link RunInput}.
 *
 * **Example** (Serving a model with server tools)
 *
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { AgUiServer, Tool, Toolkit } from "effect/ai"
 *
 * const GetTime = Tool.make("GetTime", { success: Schema.String })
 * const Tools = Toolkit.make(GetTime)
 *
 * const AgentRoute = AgUiServer.layerHttp({
 *   path: "/agent",
 *   agent: AgUiServer.agent({ toolkit: Tools, system: "Be brief", maxSteps: 5 })
 * })
 *
 * const ToolsLayer = Tools.toLayer({
 *   GetTime: () => Effect.sync(() => new Date().toISOString())
 * })
 * ```
 *
 * @see {@link layerHttp} for serving the agent
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.0
 */
export const agent = <Tools extends Record<string, Tool.Any>>(options: {
  readonly toolkit: Toolkit.Toolkit<Tools>
  readonly system?: string | undefined
  readonly maxSteps?: number | undefined
}): Agent<
  | LanguageModel.LanguageModel
  | Tool.HandlersFor<Tools>
  | Exclude<Tool.HandlerServices<Tools[keyof Tools]>, RunInput>
> => ({
  run: Effect.fnUntraced(function*(input: AgUiSchema.RunAgentInput) {
    if (input.tools.some((tool) => Object.hasOwn(options.toolkit.tools, tool.name))) {
      return yield* new HttpApiError.BadRequest({})
    }
    const frontendTools = input.tools.map((tool) =>
      Tool.dynamic(tool.name, {
        description: tool.description,
        parameters: (tool.parameters ?? { type: "object", properties: {} }) as JsonSchema.JsonSchema,
        execution: "client"
      })
    )
    const toolkit = Toolkit.merge(options.toolkit, Toolkit.make(...frontendTools))
    const conversation = AgUi.toPrompt(input)
    const prompt = options.system === undefined ? conversation : Prompt.prependSystem(conversation, options.system)
    const chat = yield* Chat.empty
    const run = makeRunSummary(input, toolkit.tools)
    const parts = chat.streamText({ prompt, toolkit, maxSteps: options.maxSteps }) as Stream.Stream<
      Response.AnyPart,
      unknown,
      never
    >
    return parts.pipe(
      Stream.tap((part) => Effect.sync(() => run.observe(part))),
      AgUi.fromStreamParts,
      Stream.concat(Stream.sync(run.finished)),
      Stream.provideService(RunInput, input),
      Stream.provideServiceEffect(
        IdGenerator,
        Effect.map(Effect.serviceOption(IdGenerator), Option.getOrElse(() => defaultIdGenerator))
      )
    )
  })
})

// Accumulates what `RUN_FINISHED` reports: the token usage of every round and
// the client-executed tool calls nothing answered
const makeRunSummary = (input: AgUiSchema.RunAgentInput, tools: Record<string, Tool.Any>) => {
  const clientTools = new Set(Object.values(tools).filter(Tool.isClientExecuted).map((tool) => tool.name))
  const pending = new Set<string>()
  const usage: {
    -readonly [K in keyof AgUiSchema.TokenUsage]: AgUiSchema.TokenUsage[K]
  } = {}
  const add = (key: keyof typeof usage & `${string}Tokens`, value: number | undefined) => {
    if (value !== undefined) usage[key] = (usage[key] ?? 0) + value
  }
  return {
    observe(part: Response.AnyPart) {
      if (part.type === "tool-call" && clientTools.has(part.name)) {
        pending.add(part.id)
      } else if (part.type === "tool-result" && !part.preliminary) {
        pending.delete(part.id)
      } else if (part.type === "finish") {
        add("inputTokens", part.usage.inputTokens.total)
        add("outputTokens", part.usage.outputTokens.total)
        add("reasoningTokens", part.usage.outputTokens.reasoning)
        add("cachedInputTokens", part.usage.inputTokens.cacheRead)
        add("cacheWriteInputTokens", part.usage.inputTokens.cacheWrite)
        if (part.usage.inputTokens.total !== undefined || part.usage.outputTokens.total !== undefined) {
          add("totalTokens", (part.usage.inputTokens.total ?? 0) + (part.usage.outputTokens.total ?? 0))
        }
      }
    },
    finished(): AgUiSchema.Event {
      return {
        type: "RUN_FINISHED",
        threadId: input.threadId,
        runId: input.runId,
        ...(pending.size > 0 ? { outcome: { type: "success", pendingToolCallIds: Array.from(pending) } } : {}),
        ...(Object.keys(usage).length > 0 ? { usage: [usage] } : {})
      }
    }
  }
}
