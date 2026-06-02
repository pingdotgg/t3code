/**
 * The `McpServer` module provides Effect services and layers for building
 * Model Context Protocol servers. It keeps track of registered tools,
 * resources, resource templates, prompts, completions, and server
 * notifications, then exposes them through the MCP request handlers.
 *
 * **Common tasks**
 *
 * - Start a server over stdio with {@link layerStdio}
 * - Register HTTP routes for an existing `HttpRouter` with {@link layerHttp}
 * - Expose Effect AI toolkits as MCP tools with {@link registerToolkit}
 * - Register resources, resource templates, and prompts with {@link resource}
 *   and {@link prompt}
 * - Ask the connected MCP client for structured input with {@link elicit}
 *
 * **Gotchas**
 *
 * - Registration helpers require an `McpServer` service, usually provided by
 *   one of this module's layers.
 * - HTTP clients must complete MCP initialization before other requests; the
 *   server tracks initialized sessions with the `Mcp-Session-Id` header.
 * - Resource template parameters are decoded with the schemas embedded in the
 *   template literal.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as Queue from "../../Queue.ts"
import * as RcMap from "../../RcMap.ts"
import { CurrentLogLevel } from "../../References.ts"
import * as Schema from "../../Schema.ts"
import * as AST from "../../SchemaAST.ts"
import * as Sink from "../../Sink.ts"
import type { Stdio } from "../../Stdio.ts"
import * as Stream from "../../Stream.ts"
import type * as Types from "../../Types.ts"
import * as FindMyWay from "../http/FindMyWay.ts"
import * as Headers from "../http/Headers.ts"
import { appendPreResponseHandlerUnsafe } from "../http/HttpEffect.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import * as HttpServerRequest from "../http/HttpServerRequest.ts"
import * as HttpServerResponse from "../http/HttpServerResponse.ts"
import * as Rpc from "../rpc/Rpc.ts"
import * as RpcClient from "../rpc/RpcClient.ts"
import type * as RpcGroup from "../rpc/RpcGroup.ts"
import * as RpcMessage from "../rpc/RpcMessage.ts"
import * as RpcSerialization from "../rpc/RpcSerialization.ts"
import * as RpcServer from "../rpc/RpcServer.ts"
import {
  CallToolResult,
  ClientNotificationRpcs,
  ClientRpcs,
  CompleteResult,
  Elicit,
  ElicitationDeclined,
  EnabledWhen,
  GetPromptResult,
  InternalError,
  InvalidParams,
  isParam,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  McpServerClient,
  McpServerClientMiddleware,
  Prompt,
  Resource,
  ResourceTemplate,
  ServerNotificationRpcs,
  ServerRequestRpcs,
  TextContent,
  Tool as McpTool
} from "./McpSchema.ts"
import type {
  CallTool,
  ClientCapabilities,
  Complete,
  GetPrompt,
  Initialize,
  Param,
  PromptArgument,
  PromptMessage,
  ReadResourceResult,
  ServerCapabilities
} from "./McpSchema.ts"
import * as Tool from "./Tool.ts"
import type * as Toolkit from "./Toolkit.ts"

/**
 * Service that stores and serves an MCP server's registered tools, resources,
 * prompts, completions, and outgoing notifications.
 *
 * **Details**
 *
 * Handlers use this service to register capabilities and resolve incoming MCP
 * requests.
 *
 * @category server
 * @since 4.0.0
 */
export class McpServer extends Context.Service<McpServer, {
  readonly notifications: RpcClient.RpcClient<RpcGroup.Rpcs<typeof ServerNotificationRpcs>>
  readonly notificationsQueue: Queue.Dequeue<RpcMessage.Request<any>>
  readonly initializedClients: Set<number>

  readonly tools: ReadonlyArray<{
    readonly tool: McpTool
    readonly annotations: Context.Context<never>
  }>
  readonly addTool: (options: {
    readonly tool: McpTool
    readonly annotations: Context.Context<never>
    readonly handle: (payload: any) => Effect.Effect<CallToolResult, never, McpServerClient>
  }) => Effect.Effect<void>
  readonly callTool: (
    requests: typeof CallTool.payloadSchema.Type
  ) => Effect.Effect<CallToolResult, InternalError | InvalidParams, McpServerClient>

  readonly resources: ReadonlyArray<{
    readonly resource: Resource
    readonly annotations: Context.Context<never>
  }>
  readonly addResource: (options: {
    readonly resource: Resource
    readonly annotations: Context.Context<never>
    readonly handle: Effect.Effect<typeof ReadResourceResult.Type, InternalError, McpServerClient>
  }) => Effect.Effect<void>

  readonly resourceTemplates: ReadonlyArray<{
    readonly template: ResourceTemplate
    readonly annotations: Context.Context<never>
  }>
  readonly addResourceTemplate: (
    options: {
      readonly template: ResourceTemplate
      readonly annotations: Context.Context<never>
      readonly routerPath: string
      readonly completions: Record<string, (input: string) => Effect.Effect<CompleteResult, InternalError>>
      readonly handle: (
        uri: string,
        params: Array<string>
      ) => Effect.Effect<typeof ReadResourceResult.Type, InvalidParams | InternalError, McpServerClient>
    }
  ) => Effect.Effect<void>

  readonly findResource: (
    uri: string
  ) => Effect.Effect<typeof ReadResourceResult.Type, InvalidParams | InternalError, McpServerClient>

  readonly prompts: ReadonlyArray<{
    readonly prompt: Prompt
    readonly annotations: Context.Context<never>
  }>
  readonly addPrompt: (options: {
    readonly prompt: Prompt
    readonly annotations: Context.Context<never>
    readonly completions: Record<
      string,
      (input: string) => Effect.Effect<CompleteResult, InternalError, McpServerClient>
    >
    readonly handle: (
      params: Record<string, string>
    ) => Effect.Effect<GetPromptResult, InternalError | InvalidParams, McpServerClient>
  }) => Effect.Effect<void>
  readonly getPromptResult: (
    request: typeof GetPrompt.payloadSchema.Type
  ) => Effect.Effect<GetPromptResult, InternalError | InvalidParams, McpServerClient>

  readonly completion: (
    complete: typeof Complete.payloadSchema.Type
  ) => Effect.Effect<CompleteResult, InternalError, McpServerClient>
}>()("effect/ai/McpServer") {
  /**
   * Builds an MCP server service from registered tools, prompts, resources, and completions.
   *
   * @since 4.0.0
   */
  static readonly make = Effect.gen(function*() {
    const matcher = makeUriMatcher<
      {
        readonly _tag: "ResourceTemplate"
        readonly handle: (
          uri: string,
          params: Array<string>
        ) => Effect.Effect<typeof ReadResourceResult.Type, InternalError | InvalidParams, McpServerClient>
      } | {
        readonly _tag: "Resource"
        readonly effect: Effect.Effect<typeof ReadResourceResult.Type, InternalError, McpServerClient>
      }
    >()
    const tools = Arr.empty<{
      readonly tool: McpTool
      readonly annotations: Context.Context<never>
    }>()
    const toolMap = new Map<string, (payload: any) => Effect.Effect<CallToolResult, InternalError, McpServerClient>>()
    const resources: Array<{
      readonly resource: Resource
      readonly annotations: Context.Context<never>
    }> = []
    const resourceTemplates: Array<{
      readonly template: ResourceTemplate
      readonly annotations: Context.Context<never>
    }> = []
    const prompts: Array<{
      readonly prompt: Prompt
      readonly annotations: Context.Context<never>
    }> = []
    const promptMap = new Map<
      string,
      (params: Record<string, string>) => Effect.Effect<GetPromptResult, InternalError | InvalidParams, McpServerClient>
    >()
    const completionsMap = new Map<
      string,
      (input: string) => Effect.Effect<CompleteResult, InternalError, McpServerClient>
    >()
    const notificationsQueue = yield* Queue.make<RpcMessage.Request<any>>()
    const listChangedHandles = new Map<string, any>()
    const notifications = yield* RpcClient.makeNoSerialization(ServerNotificationRpcs, {
      spanPrefix: "McpServer/Notifications",
      onFromClient: (options) =>
        Effect.suspend((): Effect.Effect<void> => {
          const message = options.message
          if (message._tag !== "Request") {
            return Effect.void
          }
          if (message.tag.includes("list_changed")) {
            if (!listChangedHandles.has(message.tag)) {
              listChangedHandles.set(
                message.tag,
                setTimeout(() => {
                  Queue.offerUnsafe(notificationsQueue, message)
                  listChangedHandles.delete(message.tag)
                }, 0)
              )
            }
          } else {
            Queue.offerUnsafe(notificationsQueue, message)
          }
          return notifications.write({
            clientId: 0,
            requestId: message.id,
            _tag: "Exit",
            exit: Exit.void as any
          })
        })
    })

    return McpServer.of({
      notifications: notifications.client,
      notificationsQueue,
      initializedClients: new Set(),
      get tools() {
        return tools
      },
      addTool: (options) =>
        Effect.suspend(() => {
          tools.push(options)
          toolMap.set(options.tool.name, options.handle)
          return notifications.client["notifications/tools/list_changed"]({})
        }),
      callTool: (request) =>
        Effect.suspend((): Effect.Effect<CallToolResult, InternalError | InvalidParams, McpServerClient> => {
          const handle = toolMap.get(request.name)
          if (!handle) {
            return Effect.fail(new InvalidParams({ message: `Tool '${request.name}' not found` }))
          }
          return handle(request.arguments)
        }),
      get resources() {
        return resources
      },
      get resourceTemplates() {
        return resourceTemplates
      },
      addResource: (options) =>
        Effect.suspend(() => {
          resources.push(options)
          matcher.add(options.resource.uri, { _tag: "Resource", effect: options.handle })
          return notifications.client["notifications/resources/list_changed"]({})
        }),
      addResourceTemplate: ({ annotations, completions, handle, routerPath, template }) =>
        Effect.suspend(() => {
          resourceTemplates.push({ template, annotations })
          matcher.add(routerPath, { _tag: "ResourceTemplate", handle })
          for (const [param, handle] of Object.entries(completions)) {
            completionsMap.set(`ref/resource/${template.uriTemplate}/${param}`, handle)
          }
          return notifications.client["notifications/resources/list_changed"]({})
        }),
      findResource: (uri) =>
        Effect.suspend(() => {
          const match = matcher.find(uri)
          if (!match) {
            return Effect.succeed({ contents: [] })
          } else if (match.handler._tag === "Resource") {
            return match.handler.effect
          }
          const params: Array<string> = []
          for (const key of Object.keys(match.params)) {
            params[Number(key)] = match.params[key]!
          }
          return match.handler.handle(uri, params)
        }),
      get prompts() {
        return prompts
      },
      addPrompt: (options) =>
        Effect.suspend(() => {
          prompts.push(options)
          promptMap.set(options.prompt.name, options.handle)
          for (const [param, handle] of Object.entries(options.completions)) {
            completionsMap.set(`ref/prompt/${options.prompt.name}/${param}`, handle)
          }
          return notifications.client["notifications/prompts/list_changed"]({})
        }),
      getPromptResult: Effect.fnUntraced(function*({ arguments: params, name }) {
        const handler = promptMap.get(name)
        if (!handler) {
          return yield* new InvalidParams({ message: `Prompt '${name}' not found` })
        }
        return yield* handler(params ?? {})
      }),
      completion: Effect.fnUntraced(function*(complete) {
        const ref = complete.ref
        const key = ref.type === "ref/resource"
          ? `ref/resource/${ref.uri}/${complete.argument.name}`
          : `ref/prompt/${ref.name}/${complete.argument.name}`
        const handler = completionsMap.get(key)
        return handler ? yield* handler(complete.argument.value) : CompleteResult.empty
      })
    })
  })

  /**
   * Layer that provides the MCP server and client services.
   *
   * @since 4.0.0
   */
  static readonly layer: Layer.Layer<McpServer | McpServerClient> = Layer.effect(McpServer)(McpServer.make) as any
}

const LATEST_PROTOCOL_VERSION = "2025-06-18"
const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
]
const mcpSessionIdHeader = "mcp-session-id"
const mcpProtocolVersionHeader = "mcp-protocol-version"

/**
 * Runs an MCP server over the current `RpcServer.Protocol`.
 *
 * **Details**
 *
 * The server performs initialization and session handling, serves registered
 * tools, resources, and prompts, and forwards queued server notifications to
 * initialized clients.
 *
 * @category constructors
 * @since 4.0.0
 */
export const run: (options: {
  readonly name: string
  readonly version: string
  readonly extensions?: Record<`${string}/${string}`, unknown> | undefined
}) => Effect.Effect<
  never,
  never,
  McpServer | RpcServer.Protocol
> = Effect.fnUntraced(function*(options: {
  readonly name: string
  readonly version: string
}) {
  const protocol = yield* RpcServer.Protocol
  const server = yield* McpServer
  const isHttp = Option.isSome(yield* Effect.serviceOption(HttpRouter.HttpRouter))
  const clientSessions = new Map<string, typeof Initialize.payloadSchema.Type>()
  const handlers = yield* Layer.build(layerHandlers(options, { clientSessions }))

  const clients = yield* RcMap.make({
    lookup: Effect.fnUntraced(function*(clientId: number) {
      let write!: (message: RpcMessage.FromServerEncoded) => Effect.Effect<void>
      const client = yield* RpcClient.make(ServerRequestRpcs, {
        spanPrefix: "McpServer/Client"
      }).pipe(
        Effect.provideServiceEffect(
          RpcClient.Protocol,
          RpcClient.Protocol.make(Effect.fnUntraced(function*(writeResponse) {
            let cid = 0
            write = (message) => writeResponse(cid, message)
            return {
              send(id, request, _transferables) {
                cid = id
                return protocol.send(clientId, {
                  ...request,
                  headers: undefined,
                  traceId: undefined,
                  spanId: undefined,
                  sampled: undefined
                } as any)
              },
              supportsAck: true,
              supportsTransferables: false,
              supportsStructuredClone: false
            }
          }))
        )
      )

      return { client, write } as const
    }),
    idleTimeToLive: 10000
  })

  const clientMiddleware = McpServerClientMiddleware.of((effect, { client, headers, rpc }) => {
    const initializePayload = getInitializedClient(clientSessions, client.id, headers)
    const isInitialize = rpc._tag === "initialize"
    if (!isInitialize && !initializePayload) {
      const fiber = Fiber.getCurrent()!
      const httpRequest = Context.getOrUndefined(fiber.context, HttpServerRequest.HttpServerRequest)
      if (httpRequest) {
        appendPreResponseHandlerUnsafe(
          httpRequest,
          () => Effect.succeed(HttpServerResponse.empty({ status: 404 }))
        )
      }
      return Effect.die(new Error(`Mcp-Session-Id does not exist`))
    }
    return Effect.provideService(
      effect,
      McpServerClient,
      McpServerClient.of({
        clientId: client.id,
        initializePayload: initializePayload!,
        getClient: RcMap.get(clients, client.id).pipe(
          Effect.map(({ client }) => client)
        )
      })
    )
  })

  const patchedProtocol = RpcServer.Protocol.of({
    ...protocol,
    run: (f) =>
      protocol.run((clientId, request_) => {
        const request = request_ as any as
          | RpcMessage.FromServerEncoded
          | RpcMessage.FromClientEncoded
        switch (request._tag) {
          case "Request": {
            if (isHttp) {
              const fiber = Fiber.getCurrent()!
              const httpRequest = Context.getUnsafe(fiber.context, HttpServerRequest.HttpServerRequest)
              const client = getInitializedClient(clientSessions, clientId, httpRequest.headers)
              if (client) {
                appendPreResponseHandlerUnsafe(httpRequest, (_, res) =>
                  Effect.succeed(
                    HttpServerResponse.setHeader(res, mcpProtocolVersionHeader, client.protocolVersion)
                  ))
              }
            }
            const rpc = ClientNotificationRpcs.requests.get(request.tag)
            if (rpc) {
              if (request.tag === "notifications/cancelled") {
                return f(clientId, {
                  _tag: "Interrupt",
                  requestId: String((request.payload as any).requestId)
                })
              }
              const handler = handlers.mapUnsafe.get(request.tag) as Rpc.Handler<string>
              return handler
                ? handler.handler(request.payload, {
                  rpc,
                  requestId: RpcMessage.RequestId(request.id),
                  client: new Rpc.ServerClient(clientId),
                  headers: Headers.fromInput(request.headers)
                }) as any as Effect.Effect<void>
                : Effect.void
            }
            return f(clientId, request)
          }
          case "Ping":
          case "Ack":
          case "Interrupt":
          case "Eof":
            return f(clientId, request)
          case "Pong":
          case "Exit":
          case "Chunk":
          case "ClientProtocolError":
          case "Defect":
            return RcMap.get(clients, clientId).pipe(
              Effect.flatMap(({ write }) => write(request)),
              Effect.scoped
            )
        }
      })
  })

  const encodeNotification = Schema.encodeUnknownEffect(
    Schema.Union(Array.from(ServerNotificationRpcs.requests.values(), (rpc) => rpc.payloadSchema))
  )
  yield* Queue.take(server.notificationsQueue).pipe(
    Effect.flatMap(Effect.fnUntraced(function*(request) {
      const encoded = yield* encodeNotification(request.payload)
      const message: RpcMessage.RequestEncoded = {
        _tag: "Request",
        tag: request.tag,
        payload: encoded
      } as any
      const clientIds = yield* patchedProtocol.clientIds
      for (const clientId of server.initializedClients.keys()) {
        if (!clientIds.has(clientId)) {
          server.initializedClients.delete(clientId)
          continue
        }
        yield* patchedProtocol.send(clientId, message as any)
      }
    })),
    Effect.catchCause(() => Effect.void),
    Effect.forever,
    Effect.forkScoped
  )

  return yield* RpcServer.make(ClientRpcs, {
    spanPrefix: "McpServer",
    disableFatalDefects: true
  }).pipe(
    Effect.provideService(RpcServer.Protocol, patchedProtocol),
    Effect.provideService(McpServerClientMiddleware, clientMiddleware),
    Effect.provide(handlers)
  )
}, Effect.scoped)

/**
 * Creates a layer that starts an MCP server over an existing
 * `RpcServer.Protocol` and provides the `McpServer` and `McpServerClient`
 * services.
 *
 * **When to use**
 *
 * Use when you already have a custom or externally provided
 * `RpcServer.Protocol` and want to start an MCP server as part of a layer
 * graph.
 *
 * **Details**
 *
 * The returned layer forks `run(options)` in the layer scope and merges
 * `McpServer.layer`, so registration layers can use the `McpServer` service
 * while the server is running.
 *
 * **Gotchas**
 *
 * Unlike `layerStdio` and `layerHttp`, this layer does not install a concrete
 * transport. The surrounding layer graph must provide `RpcServer.Protocol`.
 *
 * @see {@link run} for the effect form used by this layer
 * @see {@link layerStdio} for a stdio-backed layer that installs the MCP protocol and NDJSON-RPC serialization
 * @see {@link layerHttp} for an HTTP-backed layer that registers with `HttpRouter` and installs JSON-RPC serialization
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options: {
  readonly name: string
  readonly version: string
  readonly extensions?: Record<`${string}/${string}`, unknown> | undefined
}): Layer.Layer<McpServer | McpServerClient, never, RpcServer.Protocol> =>
  Layer.effectDiscard(Effect.forkScoped(run(options))).pipe(
    Layer.provideMerge(McpServer.layer)
  )

/**
 * Runs the McpServer, using stdio for input and output.
 *
 * **Example** (Running an MCP server over stdio)
 *
 * ```ts
 * import { Effect, Layer, Logger, Schema } from "effect"
 * import { NodeRuntime, NodeStdio } from "@effect/platform-node"
 * import { McpSchema, McpServer } from "effect/unstable/ai"
 *
 * const idParam = McpSchema.param("id", Schema.Number)
 *
 * // Define a resource template for a README file
 * const ReadmeTemplate = McpServer.resource`file://readme/${idParam}`({
 *   name: "README Template",
 *   // You can add auto-completion for the ID parameter
 *   completion: {
 *     id: (_) => Effect.succeed([1, 2, 3, 4, 5])
 *   },
 *   content: Effect.fn(function*(_uri, id) {
 *     return `# MCP Server Demo - ID: ${id}`
 *   })
 * })
 *
 * // Define a test prompt with parameters
 * const TestPrompt = McpServer.prompt({
 *   name: "Test Prompt",
 *   description: "A test prompt to demonstrate MCP server capabilities",
 *   parameters: {
 *     flightNumber: Schema.String
 *   },
 *   completion: {
 *     flightNumber: () => Effect.succeed(["FL123", "FL456", "FL789"])
 *   },
 *   content: ({ flightNumber }) =>
 *     Effect.succeed(`Get the booking details for flight number: ${flightNumber}`)
 * })
 *
 * // Merge all the resources and prompts into a single server layer
 * const ServerLayer = Layer.mergeAll(
 *   ReadmeTemplate,
 *   TestPrompt
 * ).pipe(
 *   // Provide the MCP server implementation
 *   Layer.provide(McpServer.layerStdio({
 *     name: "Demo Server",
 *     version: "1.0.0",
 *   })),
 *   Layer.provide(NodeStdio.layer),
 *   Layer.provide(Layer.succeed(Logger.LogToStderr)(true))
 * )
 *
 * Layer.launch(ServerLayer).pipe(NodeRuntime.runMain)
 * ```
 *
 * @category layers
 * @since 4.0.0
 */
export const layerStdio = (options: {
  readonly name: string
  readonly version: string
  readonly extensions?: Record<`${string}/${string}`, unknown> | undefined
}): Layer.Layer<McpServer | McpServerClient, never, Stdio> =>
  layer(options).pipe(
    Layer.provide(RpcServer.layerProtocolStdio),
    Layer.provide(RpcSerialization.layerNdJsonRpc())
  )

/**
 * Registers an HTTP POST JSON-RPC route at `options.path` on the current
 * `HttpRouter`.
 *
 * **When to use**
 *
 * Use to expose an MCP server through an existing `HttpRouter`.
 *
 * **Details**
 *
 * This layer composes `layer(options)`, `RpcServer.layerProtocolHttp(options)`,
 * and `RpcSerialization.layerJsonRpc()`.
 *
 * @see {@link layerStdio} for exposing the server over stdio
 * @see {@link layer} for the base MCP server layer without a transport protocol
 *
 * @category layers
 * @since 4.0.0
 */
export const layerHttp = (options: {
  readonly name: string
  readonly version: string
  readonly path: HttpRouter.PathInput
  readonly extensions?: Record<`${string}/${string}`, unknown> | undefined
}): Layer.Layer<McpServer | McpServerClient, never, HttpRouter.HttpRouter> =>
  layer(options).pipe(
    Layer.provide(RpcServer.layerProtocolHttp(options)),
    Layer.provide(RpcSerialization.layerJsonRpc())
  )

/**
 * Registers a `Toolkit` with the `McpServer`.
 *
 * @category tools
 * @since 4.0.0
 */
export const registerToolkit: <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
) => Effect.Effect<
  void,
  never,
  McpServer | Tool.HandlersFor<Tools> | Exclude<Tool.HandlerServices<Tools>, McpServerClient>
> = Effect.fnUntraced(function*<Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
) {
  const registry = yield* McpServer
  const built = yield* (toolkit as any as Effect.Effect<
    Toolkit.WithHandler<Tools>,
    never,
    Exclude<Tool.HandlersFor<Tools>, McpServerClient>
  >)
  const services = yield* Effect.context<never>()
  for (const tool of Object.values(built.tools)) {
    const annotations = tool.annotations
    const toolMeta = Context.getOrUndefined(annotations, Tool.Meta)
    const mcpTool = new McpTool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...(Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined
        )),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld)
      },
      _meta: toolMeta
    })
    yield* registry.addTool({
      tool: mcpTool,
      annotations,
      handle(payload) {
        return built.handle(tool.name as any, payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideContext(services as Context.Context<any>),
          Effect.matchCause({
            onFailure: (cause) =>
              new CallToolResult({
                isError: true,
                content: [{
                  type: "text",
                  text: Cause.pretty(cause)
                }]
              }),
            onSuccess: (result: any) =>
              new CallToolResult({
                isError: false,
                structuredContent: typeof result.encodedResult === "object" ? result.encodedResult : undefined,
                content: [{
                  type: "text",
                  text: JSON.stringify(result.encodedResult)
                }]
              })
          }),
          Effect.tapCause(Effect.log)
        ) as any
      }
    })
  }
})

/**
 * Registers an `AiToolkit` with the `McpServer`.
 *
 * @category tools
 * @since 4.0.0
 */
export const toolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>
): Layer.Layer<
  never,
  never,
  Tool.HandlersFor<Tools> | Exclude<Tool.HandlerServices<Tools>, McpServerClient>
> =>
  Layer.effectDiscard(registerToolkit(toolkit)).pipe(
    Layer.provide(McpServer.layer)
  )

/**
 * Utility type that validates a completion-handler record against the allowed
 * parameter keys.
 *
 * @category utility types
 * @since 4.0.0
 */
export type ValidateCompletions<Completions, Keys extends string> =
  & Completions
  & {
    readonly [K in keyof Completions]: K extends Keys ? (input: string) => any : never
  }

/**
 * Completion-handler map for a resource URI template.
 *
 * **Details**
 *
 * Each schema interpolation contributes a parameter key, using an explicit
 * `Param` name when present or `paramN` otherwise, and each handler returns
 * candidate values for that parameter.
 *
 * @category models
 * @since 4.0.0
 */
export type ResourceCompletions<Schemas extends ReadonlyArray<Schema.Top>> = {
  readonly [
    K in Extract<keyof Schemas, `${number}`> as Schemas[K] extends Param<infer Id, infer _S> ? Id
      : `param${K}`
  ]: (input: string) => Effect.Effect<Array<Schemas[K]["Type"]>, any, any>
}

/**
 * Registers an MCP resource or resource template from an Effect program.
 *
 * **When to use**
 *
 * Use to add a resource to an existing MCP server from an Effect program.
 *
 * @see {@link resource} for the layer-based resource registration wrapper
 *
 * @category resources
 * @since 4.0.0
 */
export const registerResource: {
  <E, R>(options: {
    readonly uri: string
    readonly name: string
    readonly description?: string | undefined
    readonly mimeType?: string | undefined
    readonly audience?: ReadonlyArray<"user" | "assistant"> | undefined
    readonly priority?: number | undefined
    readonly content: Effect.Effect<
      typeof ReadResourceResult.Type | string | Uint8Array,
      E,
      R
    >
    readonly annotations?: Context.Context<never> | undefined
  }): Effect.Effect<void, never, Exclude<R, McpServerClient> | McpServer>
  <const Schemas extends ReadonlyArray<Schema.Top>>(segments: TemplateStringsArray, ...schemas: Schemas): <
    E,
    R,
    const Completions extends Partial<ResourceCompletions<Schemas>> = {}
  >(options: {
    readonly name: string
    readonly description?: string | undefined
    readonly mimeType?: string | undefined
    readonly audience?: ReadonlyArray<"user" | "assistant"> | undefined
    readonly priority?: number | undefined
    readonly completion?: ValidateCompletions<Completions, keyof ResourceCompletions<Schemas>> | undefined
    readonly content: (uri: string, ...params: { readonly [K in keyof Schemas]: Schemas[K]["Type"] }) => Effect.Effect<
      typeof ReadResourceResult.Type | string | Uint8Array,
      E,
      R
    >
    readonly annotations?: Context.Context<never> | undefined
  }) => Effect.Effect<
    void,
    never,
    | Exclude<
      | Schemas[number]["DecodingServices"]
      | Schemas[number]["EncodingServices"]
      | R
      | (Completions[keyof Completions] extends (input: string) => infer Ret ?
        Ret extends Effect.Effect<infer _A, infer _E, infer _R> ? _R : never
        : never),
      McpServerClient
    >
    | McpServer
  >
} = function() {
  if (arguments.length === 1) {
    const options = arguments[0] as {
      readonly uri: string
      readonly name: string
      readonly description?: string | undefined
      readonly mimeType?: string | undefined
      readonly audience?: ReadonlyArray<"user" | "assistant"> | undefined
      readonly priority?: number | undefined
      readonly content: Effect.Effect<typeof ReadResourceResult.Type | string | Uint8Array, any, any>
      readonly annotations?: Context.Context<never> | undefined
    }
    return Effect.gen(function*() {
      const services = yield* Effect.context<any>()
      const registry = yield* McpServer
      yield* registry.addResource({
        resource: new Resource({
          ...options,
          annotations: options
        }),
        handle: options.content.pipe(
          Effect.provideContext(services),
          Effect.map((content) => resolveResourceContent(options.uri, content)),
          Effect.catchCause((cause) => {
            const prettyError = Cause.prettyErrors(cause)[0]
            return Effect.fail(new InternalError({ message: prettyError.message }))
          })
        ),
        annotations: options.annotations ?? Context.empty()
      })
    })
  }
  const {
    params,
    routerPath,
    schema,
    uriPath
  } = compileUriTemplate(...(arguments as any as [any, any]))
  return Effect.fnUntraced(function*<E, R>(options: {
    readonly name: string
    readonly description?: string | undefined
    readonly mimeType?: string | undefined
    readonly audience?: ReadonlyArray<"user" | "assistant"> | undefined
    readonly priority?: number | undefined
    readonly completion?: Record<string, (input: string) => Effect.Effect<any>> | undefined
    readonly content: (uri: string, ...params: Array<any>) => Effect.Effect<
      typeof ReadResourceResult.Type | string | Uint8Array,
      E,
      R
    >
    readonly annotations?: Context.Context<never> | undefined
  }) {
    const services = yield* Effect.context<any>()
    const registry = yield* McpServer
    const decode = Schema.decodeUnknownEffect(schema)
    const template = new ResourceTemplate({
      ...options,
      uriTemplate: uriPath,
      annotations: options!
    })
    const completions: Record<string, (input: string) => Effect.Effect<CompleteResult, InternalError>> = {}
    for (const [param, handle] of Object.entries(options.completion ?? {})) {
      const encodeArray = Schema.encodeUnknownEffect(Schema.Array(params[param]))
      const handler = (input: string) =>
        handle(input).pipe(
          Effect.flatMap(encodeArray),
          Effect.map((values) => ({
            completion: {
              values: values as Array<string>,
              total: values.length,
              hasMore: false
            }
          })),
          Effect.catchCause((cause) => {
            const prettyError = Cause.prettyErrors(cause)[0]
            return Effect.fail(new InternalError({ message: prettyError.message }))
          }),
          Effect.provideContext(services)
        )
      completions[param] = handler
    }
    yield* registry.addResourceTemplate({
      template,
      routerPath,
      completions,
      annotations: options.annotations ?? Context.empty(),
      handle: (uri, params) =>
        decode(params).pipe(
          Effect.mapError((error) => new InvalidParams({ message: error.message })),
          Effect.flatMap((params: any) =>
            options.content(uri, ...params).pipe(
              Effect.map((content) => resolveResourceContent(uri, content)),
              Effect.catchCause((cause) => {
                const prettyError = Cause.prettyErrors(cause)[0]
                return Effect.fail(new InternalError({ message: prettyError.message }))
              })
            )
          ),
          Effect.provideContext(services)
        )
    })
  })
} as any

/**
 * Creates a layer that registers an MCP resource or resource template.
 *
 * **When to use**
 *
 * Use to compose resource registration into an MCP server layer.
 *
 * @see {@link registerResource} for the Effect-level resource registration API
 *
 * @category resources
 * @since 4.0.0
 */
export const resource: {
  <E, R>(options: {
    readonly uri: string
    readonly name: string
    readonly description?: string | undefined
    readonly mimeType?: string | undefined
    readonly audience?: ReadonlyArray<"user" | "assistant"> | undefined
    readonly priority?: number | undefined
    readonly content: Effect.Effect<
      typeof ReadResourceResult.Type | string | Uint8Array,
      E,
      R
    >
  }): Layer.Layer<never, never, Exclude<R, McpServerClient>>
  <const Schemas extends ReadonlyArray<Schema.Top>>(segments: TemplateStringsArray, ...schemas: Schemas): <
    E,
    R,
    const Completions extends Partial<ResourceCompletions<Schemas>> = {}
  >(options: {
    readonly name: string
    readonly description?: string | undefined
    readonly mimeType?: string | undefined
    readonly audience?: ReadonlyArray<"user" | "assistant"> | undefined
    readonly priority?: number | undefined
    readonly completion?: ValidateCompletions<Completions, keyof ResourceCompletions<Schemas>> | undefined
    readonly content: (uri: string, ...params: { readonly [K in keyof Schemas]: Schemas[K]["Type"] }) => Effect.Effect<
      typeof ReadResourceResult.Type | string | Uint8Array,
      E,
      R
    >
  }) => Layer.Layer<
    never,
    never,
    Exclude<
      | R
      | (Completions[keyof Completions] extends (input: string) => infer Ret ?
        Ret extends Effect.Effect<infer _A, infer _E, infer _R> ? _R : never
        : never),
      McpServerClient
    >
  >
} = function() {
  if (arguments.length === 1) {
    return Layer.effectDiscard(registerResource(arguments[0])).pipe(
      Layer.provide(McpServer.layer)
    )
  }
  const register = registerResource(...(arguments as any as [any, any]))
  return (options: any) =>
    Layer.effectDiscard(register(options)).pipe(
      Layer.provide(McpServer.layer)
    )
} as any

/**
 * Registers an MCP prompt from an Effect program.
 *
 * **When to use**
 *
 * Use to register an MCP prompt from an Effect program.
 *
 * **Details**
 *
 * Parameters are decoded with the supplied schema, completion handlers encode
 * per-parameter suggestions, and string prompt content is converted into a user
 * text message.
 *
 * @see {@link prompt} for the layer-based prompt registration wrapper
 *
 * @category prompts
 * @since 4.0.0
 */
export const registerPrompt = <
  E,
  R,
  Params extends Schema.Struct.Fields = {},
  const Completions extends {
    readonly [K in keyof Params]?: (input: string) => Effect.Effect<Array<Params[K]>, any, any>
  } = {}
>(
  options: {
    readonly name: string
    readonly description?: string | undefined
    readonly parameters?: Params | undefined
    readonly completion?: ValidateCompletions<Completions, Extract<keyof Params, string>> | undefined
    readonly content: (params: Params) => Effect.Effect<Array<typeof PromptMessage.Type> | string, E, R>
    readonly annotations?: Context.Context<never> | undefined
  }
): Effect.Effect<void, never, Exclude<Schema.Struct.DecodingServices<Params> | R, McpServerClient> | McpServer> => {
  const args = Arr.empty<typeof PromptArgument.Type>()
  const props: Record<string, Schema.Top> = options.parameters ?? {}
  for (const [name, prop] of Object.entries(props)) {
    args.push({
      name,
      description: AST.resolveDescription(prop.ast),
      required: !AST.isOptional(prop.ast)
    })
  }
  const prompt = new Prompt({
    name: options.name,
    description: options.description,
    arguments: args
  })
  const decode = options.parameters
    ? Schema.decodeEffect(Schema.Struct(props))
    : () => Effect.succeed({} as Params)
  const completion: Record<string, (input: string) => Effect.Effect<any>> = options.completion ?? {}
  return Effect.gen(function*() {
    const registry = yield* McpServer
    const services = yield* Effect.context<Exclude<R | Schema.Struct.DecodingServices<Params>, McpServerClient>>()
    const completions: Record<
      string,
      (input: string) => Effect.Effect<CompleteResult, InternalError, McpServerClient>
    > = {}
    for (const [param, handle] of Object.entries(completion)) {
      const encodeArray = Schema.encodeEffect(Schema.Array(props[param]))
      const handler = (input: string) =>
        handle(input).pipe(
          Effect.flatMap(encodeArray),
          Effect.map((values) => ({
            completion: {
              values: values as Array<string>,
              total: values.length,
              hasMore: false
            }
          })),
          Effect.catchCause((cause) => {
            const prettyError = Cause.prettyErrors(cause)[0]
            return Effect.fail(new InternalError({ message: prettyError.message }))
          }),
          Effect.provide(services)
        )
      completions[param] = handler as any
    }
    yield* registry.addPrompt({
      prompt,
      completions,
      annotations: options.annotations ?? Context.empty(),
      handle: (params) =>
        decode(params).pipe(
          Effect.mapError((error) => new InvalidParams({ message: error.message })),
          Effect.flatMap((params) => options.content(params as any)),
          Effect.map((messages) => {
            messages = typeof messages === "string" ?
              [{
                role: "user",
                content: TextContent.make({ text: messages })
              }] :
              messages
            return new GetPromptResult({ messages, description: prompt.description })
          }),
          Effect.catchCause((cause) => {
            const prettyError = Cause.prettyErrors(cause)[0]
            return Effect.fail(new InternalError({ message: prettyError.message }))
          }),
          Effect.provideContext(services as Context.Context<unknown>)
        )
    })
  })
}

/**
 * Creates a layer that registers an MCP prompt.
 *
 * **When to use**
 *
 * Use to compose prompt registration into an MCP server layer.
 *
 * **Details**
 *
 * Parameters are decoded with the supplied schema, completion handlers encode
 * per-parameter suggestions, and string prompt content is converted into a user
 * text message.
 *
 * @see {@link registerPrompt} for the Effect-level prompt registration API
 *
 * @category prompts
 * @since 4.0.0
 */
export const prompt = <
  E,
  R,
  Params extends Schema.Struct.Fields = {},
  const Completions extends {
    readonly [K in keyof Params]?: (input: string) => Effect.Effect<Array<Params[K]["Type"]>, any, any>
  } = {}
>(
  options: {
    readonly name: string
    readonly description?: string | undefined
    readonly parameters?: Params | undefined
    readonly completion?: ValidateCompletions<Completions, Extract<keyof Params, string>> | undefined
    readonly content: (
      params: Schema.Struct.Type<Params>
    ) => Effect.Effect<Array<typeof PromptMessage.Type> | string, E, R>
    readonly annotations?: Context.Context<never> | undefined
  }
): Layer.Layer<never, never, Exclude<Schema.Struct.DecodingServices<Params> | R, McpServerClient>> =>
  Layer.effectDiscard(registerPrompt(options)).pipe(
    Layer.provide(McpServer.layer)
  )

/**
 * Collects structured input from the current MCP client and decodes the
 * accepted response with `schema`.
 *
 * **Details**
 *
 * Accepted content is decoded with the supplied schema, declined requests fail
 * with `ElicitationDeclined`, and canceled requests interrupt the effect.
 *
 * @category elicitation
 * @since 4.0.0
 */
export const elicit: <S extends Schema.Encoder<Record<string, unknown>, unknown>>(options: {
  readonly message: string
  readonly schema: S
}) => Effect.Effect<
  S["Type"],
  ElicitationDeclined,
  McpServerClient | S["DecodingServices"]
> = Effect.fnUntraced(function*<S extends Schema.Encoder<Record<string, unknown>, unknown>>(options: {
  readonly message: string
  readonly schema: S
}) {
  const { getClient } = yield* McpServerClient
  const client = yield* getClient
  const schema = options.schema
  const request = Elicit.payloadSchema.make({
    message: options.message,
    requestedSchema: Tool.getJsonSchemaFromSchema(schema)
  })
  const res = yield* client["elicitation/create"](request).pipe(
    Effect.catchCause((cause) => Effect.fail(new ElicitationDeclined({ cause: Cause.squash(cause), request })))
  )
  switch (res.action) {
    case "accept":
      return yield* Effect.orDie(Schema.decodeUnknownEffect(schema)(res.content))
    case "cancel":
      return yield* Effect.interrupt
    case "decline":
      return yield* new ElicitationDeclined({ request })
  }
}, Effect.scoped)

/**
 * Accesses the current client's capabilities.
 *
 * @category capabilities
 * @since 4.0.0
 */
export const clientCapabilities: Effect.Effect<
  ClientCapabilities,
  never,
  McpServerClient
> = McpServerClient.useSync((_) => _.initializePayload.capabilities)

// -----------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------

const makeUriMatcher = <A>() => {
  const router = FindMyWay.make<A>({
    ignoreTrailingSlash: true,
    ignoreDuplicateSlashes: true,
    caseSensitive: true
  })
  const add = (uri: string, value: A) => {
    router.on("GET", uri as any, value)
  }
  const find = (uri: string) => router.find("GET", uri)

  return { add, find } as const
}

const compileUriTemplate = (segments: TemplateStringsArray, ...schemas: ReadonlyArray<Schema.Top>) => {
  let routerPath = segments[0].replace(":", "::")
  let uriPath = segments[0]
  const params: Record<string, Schema.Top> = {}
  let pathSchema = Schema.Tuple([]) as Schema.Top
  if (schemas.length > 0) {
    const arr: Array<Schema.Top> = []
    for (let i = 0; i < schemas.length; i++) {
      const toCodecStringTree = Schema.toCodecStringTree(schemas[i])
      const segment = segments[i + 1]
      const key = String(i)
      arr.push(toCodecStringTree)
      routerPath += `:${key}${segment.replace(":", "::")}`
      const schema = schemas[i]
      const paramName = isParam(schema) ? (schema as Param<string, Schema.Top>).name : `param${key}`
      params[paramName] = toCodecStringTree
      uriPath += `{${paramName}}${segment}`
    }
    pathSchema = Schema.Tuple(arr)
  }
  return {
    routerPath,
    uriPath,
    schema: pathSchema,
    params
  } as const
}

const layerHandlers = (serverInfo: {
  readonly name: string
  readonly version: string
  readonly extensions?: Record<`${string}/${string}`, unknown> | undefined
}, options: {
  readonly clientSessions: Map<string, typeof Initialize.payloadSchema.Type>
}) =>
  ClientRpcs.toLayer(
    Effect.gen(function*() {
      const server = yield* McpServer
      let currentLogLevel = yield* CurrentLogLevel

      return ClientRpcs.of({
        // Requests
        ping: () => Effect.succeed({}),
        initialize(params, { client }) {
          const requestedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion
            : LATEST_PROTOCOL_VERSION
          if (requestedVersion !== params.protocolVersion) {
            params = {
              ...params,
              protocolVersion: requestedVersion
            }
          }
          const capabilities: Types.DeepMutable<typeof ServerCapabilities.Type> = {
            completions: {}
          }
          if (server.tools.length > 0) {
            capabilities.tools = { listChanged: true }
          }
          if (server.resources.length > 0 || server.resourceTemplates.length > 0) {
            capabilities.resources = {
              listChanged: true,
              subscribe: false
            }
          }
          if (server.prompts.length > 0) {
            capabilities.prompts = { listChanged: true }
          }
          if (serverInfo.extensions) {
            capabilities.extensions = serverInfo.extensions as any
          }
          return Effect.withFiber((fiber) => {
            const httpRequest = Context.getOrUndefined(fiber.context, HttpServerRequest.HttpServerRequest)
            if (httpRequest) {
              const sessionId = crypto.randomUUID()
              options.clientSessions.set(sessionId, params)
              appendPreResponseHandlerUnsafe(httpRequest, (_req, res) =>
                Effect.succeed(HttpServerResponse.setHeaders(res, {
                  [mcpSessionIdHeader]: sessionId,
                  [mcpProtocolVersionHeader]: requestedVersion
                })))
            } else {
              options.clientSessions.set(String(client.id), params)
            }
            return Effect.succeed({
              capabilities,
              serverInfo,
              protocolVersion: requestedVersion
            })
          })
        },
        "completion/complete": (r) =>
          server.completion(r).pipe(
            Effect.provideService(CurrentLogLevel, currentLogLevel)
          ),
        "logging/setLevel": ({ level }) =>
          Effect.sync(() => {
            switch (level) {
              case "notice":
              case "info":
                currentLogLevel = "Info"
                break
              case "error":
                currentLogLevel = "Error"
                break
              case "debug":
                currentLogLevel = "Debug"
                break
              case "warning":
                currentLogLevel = "Warn"
                break
              case "critical":
              case "alert":
              case "emergency":
                currentLogLevel = "Fatal"
                break
            }
          }),
        "prompts/get": (r) =>
          server.getPromptResult(r).pipe(
            Effect.provideService(CurrentLogLevel, currentLogLevel)
          ),
        "prompts/list": (_, { client, headers }) =>
          Effect.sync(() => {
            const initialized = getInitializedClient(options.clientSessions, client.id, headers)
            return new ListPromptsResult({ prompts: filterByClient(initialized, server.prompts, "prompt") })
          }),
        "resources/list": (_, { client, headers }) =>
          Effect.sync(() => {
            const initialized = getInitializedClient(options.clientSessions, client.id, headers)
            return new ListResourcesResult({ resources: filterByClient(initialized, server.resources, "resource") })
          }),
        "resources/read": ({ uri }) =>
          server.findResource(uri).pipe(
            Effect.provideService(CurrentLogLevel, currentLogLevel)
          ),
        "resources/subscribe": () =>
          InternalError.notImplemented,
        "resources/unsubscribe": () =>
          InternalError.notImplemented,
        "resources/templates/list": (_, { client, headers }) =>
          Effect.sync(() => {
            const initialized = getInitializedClient(options.clientSessions, client.id, headers)
            return new ListResourceTemplatesResult({
              resourceTemplates: filterByClient(initialized, server.resourceTemplates, "template")
            })
          }),
        "tools/call": (r) =>
          server.callTool(r).pipe(
            Effect.provideService(CurrentLogLevel, currentLogLevel)
          ),
        "tools/list": (_, { client, headers }) =>
          Effect.sync(() => {
            const initialized = getInitializedClient(options.clientSessions, client.id, headers)
            return new ListToolsResult({
              tools: filterByClient(initialized, server.tools, "tool")
            })
          }),

        // Notifications
        "notifications/cancelled": (_) => Effect.void,
        "notifications/initialized": (_) => Effect.void,
        "notifications/progress": (_) => Effect.void,
        "notifications/roots/list_changed": (_) => Effect.void
      })
    })
  )

const resolveResourceContent = (
  uri: string,
  content: typeof ReadResourceResult.Type | string | Uint8Array
): typeof ReadResourceResult.Type => {
  if (typeof content === "string") {
    return {
      contents: [{
        uri,
        text: content
      }]
    }
  } else if (content instanceof Uint8Array) {
    return {
      contents: [{
        uri,
        blob: content
      }]
    }
  }
  return content
}

const filterByClient = <
  A extends {
    readonly annotations: Context.Context<never>
  },
  P extends keyof A
>(
  client: typeof Initialize.payloadSchema.Type | undefined,
  items: ReadonlyArray<A>,
  prop: P
): Array<A[P]> => {
  if (!client) {
    return items.map((item) => item[prop])
  }
  const out = Arr.empty<A[P]>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const enabledWhen = Context.getOrUndefined(item.annotations, EnabledWhen)
    if (!enabledWhen || enabledWhen(client)) {
      out.push(item[prop])
    }
  }
  return out
}

const getInitializedClient = (
  sessions: Map<string, typeof Initialize.payloadSchema.Type>,
  clientId: number,
  headers: Headers.Headers
) => {
  const sessionId = headers[mcpSessionIdHeader]
  if (sessionId === undefined) {
    return sessions.get(String(clientId))
  }
  return sessions.get(sessionId)
}
