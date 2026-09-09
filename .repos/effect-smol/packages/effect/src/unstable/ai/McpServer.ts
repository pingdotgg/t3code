/**
 * Builds Model Context Protocol (MCP) servers with Effect.
 *
 * The `McpServer` service stores the tools, resources, resource templates,
 * prompts, completions, initialized clients, and outgoing notifications exposed
 * by a server. This module also includes the server runner, custom protocol,
 * stdio, and HTTP layers, registration helpers, and APIs that let handlers ask
 * the connected client for structured input or read its advertised
 * capabilities.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import * as Layer from "../../Layer.ts"
import * as LogLevel from "../../LogLevel.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Queue from "../../Queue.ts"
import * as RcMap from "../../RcMap.ts"
import { CurrentLogLevel } from "../../References.ts"
import * as Result from "../../Result.ts"
import * as Schema from "../../Schema.ts"
import * as SchemaAST from "../../SchemaAST.ts"
import * as Sink from "../../Sink.ts"
import type { Stdio } from "../../Stdio.ts"
import * as Stream from "../../Stream.ts"
import * as FindMyWay from "../http/FindMyWay.ts"
import * as Headers from "../http/Headers.ts"
import { appendPreResponseHandlerUnsafe } from "../http/HttpEffect.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import * as HttpServerRequest from "../http/HttpServerRequest.ts"
import * as HttpServerResponse from "../http/HttpServerResponse.ts"
import * as Rpc from "../rpc/Rpc.ts"
import * as RpcClient from "../rpc/RpcClient.ts"
import * as RpcGroup from "../rpc/RpcGroup.ts"
import * as RpcMessage from "../rpc/RpcMessage.ts"
import * as RpcSerialization from "../rpc/RpcSerialization.ts"
import * as RpcServer from "../rpc/RpcServer.ts"
import * as AiError from "./AiError.ts"
import * as McpCore from "./internal/mcpCore.ts"
import * as McpProtocolInternal from "./internal/mcpProtocol.ts"
import * as McpProtocolRegistry from "./internal/mcpProtocolRegistry.ts"
import type * as McpProtocol from "./McpProtocol.ts"
import * as McpSchema from "./McpSchema.ts"
import {
  CallToolResult,
  ElicitationDeclined,
  EnabledWhen,
  GetPromptResult,
  Initialize,
  InternalError,
  InvalidParams,
  InvalidRequest,
  isParam,
  McpServerClient,
  McpServerClientMiddleware,
  MethodNotFound,
  Ping,
  Prompt,
  Resource,
  ResourceTemplate,
  ServerNotificationRpcs,
  TextContent,
  Tool as McpTool,
  ToolJsonSchema
} from "./McpSchema.ts"
import type {
  CallTool,
  ClientCapabilities,
  Complete,
  CompleteResult,
  GetPrompt,
  McpErrorBase,
  Param,
  PromptArgument,
  PromptMessage,
  ReadResourceResult,
  ServerCapabilities
} from "./McpSchema.ts"
import * as Tool from "./Tool.ts"
import type * as Toolkit from "./Toolkit.ts"

type CompletionContext = typeof Complete.payloadSchema.Type["context"]

interface QueuedServerNotification {
  readonly notification: McpCore.ServerNotification
  readonly targetClientId?: number | undefined
}

const internalState = new WeakMap<object, {
  readonly core: McpCore.McpCore
  readonly notifications: Queue.Dequeue<QueuedServerNotification>
}>()
type ServerExtensions = NonNullable<typeof ServerCapabilities.Type["extensions"]>
type ServerNotificationRequest<
  R extends Rpc.Any = RpcGroup.Rpcs<typeof BroadcastServerNotificationRpcs>
> = R extends Rpc.Any ? RpcMessage.Request<R> : never

const BroadcastServerNotificationRpcs = ServerNotificationRpcs.omit("notifications/elicitation/complete")

const validateStructuredContent = (
  toolName: string,
  value: unknown
): Effect.Effect<Schema.Json, McpCore.ToolResultProjectionError> =>
  Schema.is(Schema.Json)(value)
    ? Effect.succeed(value)
    : Effect.fail(
      new McpCore.ToolResultProjectionError({
        name: toolName,
        message: `Tool '${toolName}' returned structured content that is not valid JSON`
      })
    )

const toInternalServerNotification = (
  message: ServerNotificationRequest
): McpCore.ServerNotification | undefined => {
  switch (message.tag) {
    case "notifications/cancelled":
      return McpCore.ServerNotification.Cancelled({
        requestId: message.payload.requestId,
        reason: message.payload.reason,
        metadata: message.payload._meta
      })
    case "notifications/progress":
      return McpCore.ServerNotification.Progress({
        progressToken: message.payload.progressToken,
        progress: message.payload.progress,
        total: message.payload.total,
        message: message.payload.message,
        metadata: message.payload._meta
      })
    case "notifications/message":
      return McpCore.ServerNotification.LoggingMessage({
        level: message.payload.level,
        logger: message.payload.logger,
        data: message.payload.data,
        metadata: message.payload._meta
      })
    case "notifications/resources/updated":
      return McpCore.ServerNotification.ResourceUpdated({
        uri: message.payload.uri,
        metadata: message.payload._meta
      })
    case "notifications/resources/list_changed":
      return McpCore.ServerNotification.ResourcesChanged({ metadata: message.payload?._meta })
    case "notifications/tools/list_changed":
      return McpCore.ServerNotification.ToolsChanged({ metadata: message.payload?._meta })
    case "notifications/prompts/list_changed":
      return McpCore.ServerNotification.PromptsChanged({ metadata: message.payload?._meta })
    default:
      return undefined
  }
}

/**
 * Service that stores and serves an MCP server's registered tools, resources,
 * prompts, completions, and outgoing notifications.
 *
 * **Details**
 *
 * Handlers use this service to register capabilities and resolve incoming MCP
 * requests.
 *
 * @category services
 * @since 4.0.0
 */
export class McpServer extends Context.Service<McpServer, {
  readonly notifications: RpcClient.RpcClient<RpcGroup.Rpcs<typeof BroadcastServerNotificationRpcs>>
  readonly notifyElicitationComplete: (options: {
    readonly clientId: number
    readonly elicitationId: string
  }) => Effect.Effect<void>
  readonly initializedClients: Set<number>
  readonly tools: ReadonlyArray<{
    readonly tool: McpTool
    readonly annotations: Context.Context<never>
  }>
  readonly addTool: (options: {
    readonly tool: McpTool
    readonly annotations: Context.Context<never>
    readonly handle: (payload: any) => Effect.Effect<CallToolResult, InternalError | InvalidParams, McpServerClient>
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
      readonly completions: Record<
        string,
        (
          input: string,
          context: CompletionContext
        ) => Effect.Effect<CompleteResult, InternalError>
      >
      readonly handle: (
        uri: string,
        params: Array<string>
      ) => Effect.Effect<
        typeof ReadResourceResult.Type,
        InvalidParams | InternalError,
        McpServerClient
      >
    }
  ) => Effect.Effect<void>

  readonly findResource: (
    uri: string
  ) => Effect.Effect<typeof ReadResourceResult.Type, McpErrorBase | InvalidParams | InternalError, McpServerClient>

  readonly prompts: ReadonlyArray<{
    readonly prompt: Prompt
    readonly annotations: Context.Context<never>
  }>
  readonly addPrompt: (options: {
    readonly prompt: Prompt
    readonly annotations: Context.Context<never>
    readonly completions: Record<
      string,
      (
        input: string,
        context: CompletionContext
      ) => Effect.Effect<CompleteResult, InternalError, McpServerClient>
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
  ) => Effect.Effect<CompleteResult, InvalidParams | InternalError, McpServerClient>
}>()("effect/ai/McpServer") {
  /**
   * Builds an MCP server service from registered tools, prompts, resources, and completions.
   *
   * @since 4.0.0
   */
  static readonly make = Effect.gen(function*() {
    const internalCore = yield* McpCore.make
    const tools = Arr.empty<{
      readonly tool: McpTool
      readonly annotations: Context.Context<never>
    }>()
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
    const notificationsQueue = yield* Queue.make<QueuedServerNotification>()
    const listChangedHandles = new Map<string, any>()
    const notifications = yield* RpcClient.makeNoSerialization(BroadcastServerNotificationRpcs, {
      spanPrefix: "McpServer/Notifications",
      onFromClient: (options) =>
        Effect.suspend((): Effect.Effect<void> => {
          const message = options.message
          if (message._tag !== "Request") {
            return Effect.void
          }
          const notification = toInternalServerNotification(message)
          if (notification === undefined) {
            return Effect.void
          }
          if (message.tag.includes("list_changed")) {
            if (!listChangedHandles.has(message.tag)) {
              listChangedHandles.set(
                message.tag,
                setTimeout(() => {
                  Queue.offerUnsafe(notificationsQueue, { notification })
                  listChangedHandles.delete(message.tag)
                }, 0)
              )
            }
          } else {
            Queue.offerUnsafe(notificationsQueue, { notification })
          }
          return notifications.write({
            clientId: 0,
            requestId: message.id,
            _tag: "Exit",
            exit: Exit.void
          })
        })
    })

    const service = McpServer.of({
      notifications: notifications.client,
      notifyElicitationComplete: ({ clientId, elicitationId }) =>
        Queue.offer(notificationsQueue, {
          notification: McpCore.ServerNotification.ElicitationComplete({ elicitationId }),
          targetClientId: clientId
        }),
      initializedClients: new Set(),
      get tools() {
        return tools
      },
      addTool: (options) =>
        Effect.gen(function*() {
          const existingIndex = tools.findIndex(({ tool }) => tool.name === options.tool.name)
          if (existingIndex === -1) {
            tools.push(options)
          } else {
            tools[existingIndex] = options
          }
          const enabledWhen = Context.getOrUndefined(options.annotations, EnabledWhen)
          yield* internalCore.tools.register({
            descriptor: new McpTool({
              ...options.tool,
              title: options.tool.title ?? options.tool.annotations?.title
            }),
            isVisible: (profile) =>
              enabledWhen === undefined || enabledWhen(
                {
                  protocolVersion: profile.protocolVersion,
                  capabilities: profile.clientCapabilities,
                  clientInfo: profile.clientInfo
                }
              ),
            handle: (call, invocation) =>
              options.handle(call.arguments).pipe(
                Effect.provideService(
                  McpServerClient,
                  invocation.requestContext
                ),
                Effect.catchTags({
                  InternalError: (error) =>
                    Effect.fail(
                      new McpCore.ToolExecutionError({
                        name: options.tool.name,
                        message: error.message
                      })
                    ),
                  InvalidParams: (error) =>
                    Effect.fail(
                      new McpCore.InvalidToolInput({
                        name: options.tool.name,
                        message: error.message
                      })
                    )
                }),
                Effect.flatMap((result) =>
                  result.structuredContent === undefined
                    ? Effect.succeed(result)
                    : validateStructuredContent(options.tool.name, result.structuredContent).pipe(
                      Effect.as(result)
                    )
                )
              )
          })
          yield* notifications.client["notifications/tools/list_changed"]({})
        }),
      callTool: (request) =>
        Effect.gen(function*() {
          const client = yield* McpServerClient
          const result = yield* internalCore.tools.call(request, {
            clientId: client.clientId,
            protocol: {
              protocolVersion: client.protocolVersion,
              clientCapabilities: client.initializePayload.capabilities,
              clientInfo: client.initializePayload.clientInfo
            },
            requestContext: client
          }).pipe(
            Effect.mapError((error) =>
              new InvalidParams({
                message: error._tag === "ToolNotFound"
                  ? `Tool '${error.name}' not found`
                  : error.message
              })
            )
          )
          return result
        }),
      get resources() {
        return resources
      },
      get resourceTemplates() {
        return resourceTemplates
      },
      addResource: (options) =>
        Effect.gen(function*() {
          const existingIndex = resources.findIndex(({ resource }) => resource.uri === options.resource.uri)
          if (existingIndex === -1) {
            resources.push(options)
          } else {
            resources[existingIndex] = options
          }
          yield* internalCore.resources.register({
            descriptor: options.resource,
            isVisible: (profile) => {
              const enabledWhen = Context.getOrUndefined(options.annotations, EnabledWhen)
              return enabledWhen === undefined || enabledWhen({
                protocolVersion: profile.protocolVersion,
                capabilities: profile.clientCapabilities,
                clientInfo: profile.clientInfo
              })
            },
            read: (invocation) =>
              options.handle.pipe(
                Effect.provideService(McpServerClient, invocation.requestContext)
              )
          })
          yield* notifications.client["notifications/resources/list_changed"]({})
        }),
      addResourceTemplate: ({ annotations, completions, handle, routerPath, template }) =>
        Effect.gen(function*() {
          const existingIndex = resourceTemplates.findIndex(({ template: current }) =>
            current.uriTemplate === template.uriTemplate
          )
          if (existingIndex === -1) {
            resourceTemplates.push({ template, annotations })
          } else {
            resourceTemplates[existingIndex] = { template, annotations }
          }
          const templateMatcher = makeUriMatcher<true>()
          templateMatcher.add(routerPath, true)
          yield* internalCore.resources.registerTemplate({
            descriptor: template,
            isVisible: (profile) => {
              const enabledWhen = Context.getOrUndefined(annotations, EnabledWhen)
              return enabledWhen === undefined || enabledWhen({
                protocolVersion: profile.protocolVersion,
                capabilities: profile.clientCapabilities,
                clientInfo: profile.clientInfo
              })
            },
            match: (uri) => {
              const match = templateMatcher.find(uri)
              if (match === undefined) {
                return undefined
              }
              const params: Array<string> = []
              for (const key of Object.keys(match.params)) {
                params[Number(key)] = match.params[key]!
              }
              return params
            },
            read: (uri, params, invocation) =>
              handle(uri, Array.from(params)).pipe(
                Effect.provideService(McpServerClient, invocation.requestContext)
              )
          })
          for (const [param, handle] of Object.entries(completions)) {
            yield* internalCore.completions.register(
              `resource/${template.uriTemplate}/${param}`,
              (request) =>
                handle(request.argument.value, request.context).pipe(
                  Effect.map((result) => ({
                    values: result.completion.values,
                    total: result.completion.total,
                    hasMore: result.completion.hasMore,
                    metadata: result._meta
                  }))
                )
            )
          }
          yield* notifications.client["notifications/resources/list_changed"]({})
        }),
      findResource: (uri) =>
        Effect.gen(function*() {
          const client = yield* McpServerClient
          return yield* internalCore.resources.read(uri, {
            clientId: client.clientId,
            protocol: {
              protocolVersion: client.protocolVersion,
              clientCapabilities: client.clientCapabilities,
              clientInfo: client.clientInfo,
              requestMetadata: client.initializePayload._meta
            },
            requestContext: client
          }).pipe(
            Effect.catchTag("ResourceNotFound", (error) =>
              Effect.fail(new InvalidParams({ message: `Resource '${error.uri}' not found` })))
          )
        }),
      get prompts() {
        return prompts
      },
      addPrompt: (options) =>
        Effect.gen(function*() {
          const existingIndex = prompts.findIndex(({ prompt }) => prompt.name === options.prompt.name)
          if (existingIndex === -1) {
            prompts.push(options)
          } else {
            prompts[existingIndex] = options
          }
          yield* internalCore.prompts.register({
            descriptor: options.prompt,
            isVisible: (profile) => {
              const enabledWhen = Context.getOrUndefined(options.annotations, EnabledWhen)
              return enabledWhen === undefined || enabledWhen({
                protocolVersion: profile.protocolVersion,
                capabilities: profile.clientCapabilities,
                clientInfo: profile.clientInfo
              })
            },
            get: (params, invocation) =>
              options.handle(params).pipe(
                Effect.provideService(McpServerClient, invocation.requestContext)
              )
          })
          for (const [param, handle] of Object.entries(options.completions)) {
            yield* internalCore.completions.register(
              `prompt/${options.prompt.name}/${param}`,
              (request, invocation) =>
                handle(request.argument.value, request.context).pipe(
                  Effect.provideService(
                    McpServerClient,
                    invocation.requestContext
                  ),
                  Effect.map((result) => ({
                    values: result.completion.values,
                    total: result.completion.total,
                    hasMore: result.completion.hasMore,
                    metadata: result._meta
                  }))
                )
            )
          }
          yield* notifications.client["notifications/prompts/list_changed"]({})
        }),
      getPromptResult: Effect.fnUntraced(function*({ arguments: params, name }) {
        const client = yield* McpServerClient
        return yield* internalCore.prompts.get(
          name,
          params ?? {},
          McpProtocolInternal.invocationFromClient(client)
        ).pipe(
          Effect.catchTag("PromptNotFound", () => new InvalidParams({ message: `Prompt '${name}' not found` }))
        )
      }),
      completion: Effect.fnUntraced(function*(complete) {
        const client = yield* McpServerClient
        const ref = complete.ref
        const result = yield* internalCore.completions.complete({
          reference: ref.type === "ref/resource"
            ? { type: "resourceTemplate", uriTemplate: ref.uri }
            : { type: "prompt", name: ref.name },
          argument: complete.argument,
          context: complete.context
        }, McpProtocolInternal.invocationFromClient(client))
        return {
          _meta: result.metadata,
          completion: {
            values: result.values,
            total: result.total,
            hasMore: result.hasMore
          }
        }
      })
    })
    internalState.set(service, { core: internalCore, notifications: notificationsQueue })
    return service
  })

  /**
   * Layer that provides the MCP server and client services.
   *
   * @since 4.0.0
   */
  static readonly layer: Layer.Layer<McpServer | McpServerClient> = Layer.effect(McpServer)(McpServer.make) as any
}

const MCP_SESSION_ID_HEADER = "mcp-session-id"
const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version"
const MCP_INVALID_BATCH_METHOD = "invalid/json-rpc-batch"
const requestKey = (requestId: string | number): string => `${typeof requestId}:${requestId}`

type SessionLogLevel =
  | { readonly _tag: "Effect"; readonly level: LogLevel.LogLevel }
  | { readonly _tag: "Mcp"; readonly level: McpSchema.LoggingLevel }

interface Session {
  readonly initializePayload: typeof Initialize.payloadSchema.Type
  readonly negotiatedProfile: McpCore.NegotiatedProtocolProfile
  readonly protocol: McpProtocol.ProtocolAdapter
  readonly resourceSubscriptions: Set<string> | undefined
  logLevel: SessionLogLevel
}

interface Sessions {
  readonly bySessionId: Map<string, Session>
  readonly byClientId: Map<number, Session>
}

class McpClientKey extends Data.Class<{
  readonly clientId: number
  readonly profile: McpCore.NegotiatedProtocolProfile
}> {}

class McpProtocolState extends Context.Service<McpProtocolState, {
  readonly sessions: Sessions
  readonly protocolRegistry: McpProtocolRegistry.ProtocolRegistry<McpProtocol.ProtocolAdapter>
}>()("effect/ai/McpServer/McpProtocolState") {}

const makeMcpProtocolState = Effect.fnUntraced(function*(
  protocols: Arr.NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>
) {
  // TODO: Replace the shared session map with an adapter-owned lifecycle strategy
  // before v2026-07-28. The strategy must let sessionful revisions pin a profile
  // after initialize while stateless revisions select and derive it per request.
  return McpProtocolState.of({
    sessions: {
      bySessionId: new Map(),
      byClientId: new Map()
    },
    protocolRegistry: yield* McpProtocolRegistry.make(protocols)
  })
})

const layerMcpProtocolState = (
  protocols: Arr.NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>
): Layer.Layer<McpProtocolState, Cause.IllegalArgumentError> =>
  Layer.effect(McpProtocolState)(makeMcpProtocolState(protocols))

/**
 * Runs an MCP server over the current `RpcServer.Protocol`.
 *
 * **Details**
 *
 * The server performs initialization and session handling, serves registered
 * tools, resources, and prompts, and forwards queued server notifications to
 * initialized clients.
 *
 * @category running
 * @since 4.0.0
 */
export const run: (options: {
  readonly name: string
  readonly version: string
  readonly description?: string | undefined
  readonly websiteUrl?: string | undefined
  readonly icons?: ReadonlyArray<McpSchema.Icon> | undefined
  readonly protocols: Arr.NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>
  readonly extensions?: ServerExtensions | undefined
}) => Effect.Effect<
  never,
  Cause.IllegalArgumentError,
  McpServer | RpcServer.Protocol
> = Effect.fnUntraced(function*(options: {
  readonly name: string
  readonly version: string
  readonly description?: string | undefined
  readonly websiteUrl?: string | undefined
  readonly icons?: ReadonlyArray<McpSchema.Icon> | undefined
  readonly protocols: Arr.NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>
  readonly extensions?: ServerExtensions | undefined
}) {
  const protocolStateOption = yield* Effect.serviceOption(McpProtocolState)
  const protocolState = Option.isSome(protocolStateOption)
    ? protocolStateOption.value
    : yield* makeMcpProtocolState(options.protocols)
  return yield* runWithProtocolState(options, protocolState)
})

const runWithProtocolState = Effect.fnUntraced(function*(options: {
  readonly name: string
  readonly version: string
  readonly description?: string | undefined
  readonly websiteUrl?: string | undefined
  readonly icons?: ReadonlyArray<McpSchema.Icon> | undefined
  readonly extensions?: ServerExtensions | undefined
}, protocolState: McpProtocolState["Service"]) {
  const protocolRegistry = protocolState.protocolRegistry
  const serverScope = yield* Effect.scope
  const protocol = yield* RpcServer.Protocol
  const server = yield* McpServer
  const defaultLogLevel = yield* CurrentLogLevel
  const isHttp = Option.isSome(yield* Effect.serviceOption(HttpRouter.HttpRouter))
  const sessions = protocolState.sessions
  const clientProtocols = new Map<number, McpProtocol.ProtocolAdapter>()
  const activeRequests = new Map<number, Map<string, boolean>>()
  const clientProfiles = new Map<number, McpCore.NegotiatedProtocolProfile>()
  const handlers = yield* Layer.build(layerHandlers(options, {
    sessions,
    protocolRegistry
  }))

  const clients = yield* RcMap.make({
    lookup: Effect.fnUntraced(function*(key: McpClientKey) {
      const selectedProtocol = protocolRegistry.select(key.profile.protocolVersion)
      let write!: (message: RpcMessage.FromServerEncoded) => Effect.Effect<void>
      const reverseProtocol = yield* RpcClient.Protocol.make(Effect.fnUntraced(function*(writeResponse) {
        let cid = 0
        write = (message) => writeResponse(cid, message)
        return {
          send(id, request, _transferables) {
            cid = id
            if (request._tag === "Request") {
              return protocol.send(key.clientId, {
                _tag: "Request",
                id: request.id,
                tag: request.tag,
                payload: request.payload,
                headers: []
              })
            }
            // Ack & co are not part of FromServerEncoded, but the JSON-RPC
            // serializer encodes them symmetrically for reverse control flow
            return protocol.send(key.clientId, request as any)
          },
          supportsAck: true,
          supportsTransferables: false,
          supportsStructuredClone: false,
          codecFor: protocol.codecFor
        }
      }))
      const client = yield* selectedProtocol.makeReverseClient(key.profile).pipe(
        Effect.provideService(RpcClient.Protocol, reverseProtocol)
      )

      return { client, write } as const
    }),
    idleTimeToLive: 10000
  })

  const clientMiddleware = McpServerClientMiddleware.of((effect, { client, headers, payload, rpc }) => {
    const session = getClientSession(sessions, client.id, headers)
    const isInitialize = rpc._tag.endsWith("/initialize")
    if (!isInitialize && !session) {
      const fiber = Fiber.getCurrent()!
      const httpRequest = Context.getOrUndefined(fiber.context, HttpServerRequest.HttpServerRequest)
      if (httpRequest) {
        appendPreResponseHandlerUnsafe(
          httpRequest,
          () =>
            Effect.succeed(
              HttpServerResponse.empty({
                status: headers[MCP_SESSION_ID_HEADER] === undefined ? 400 : 404
              })
            )
        )
      }
      return Effect.die(new Error(`Mcp-Session-Id does not exist`))
    }
    const selectedProtocol = session?.protocol ?? protocolForInternalTag(protocolRegistry, rpc._tag)
    // NOTE: RPC middleware erases the correlation between the initialize tag
    // and its decoded payload. Restore it once after non-initialize requests
    // without a session have been rejected above.
    const initializePayload = session?.initializePayload ?? payload as typeof Initialize.payloadSchema.Type
    const profile = session?.negotiatedProfile ?? {
      protocolVersion: selectedProtocol.protocolVersion,
      clientCapabilities: initializePayload.capabilities,
      clientInfo: initializePayload.clientInfo
    }
    clientProfiles.set(client.id, profile)
    return Effect.provideService(
      Effect.provideService(
        effect,
        McpServerClient,
        McpServerClient.of({
          clientId: client.id,
          protocolVersion: session?.negotiatedProfile.protocolVersion ?? selectedProtocol.protocolVersion,
          clientCapabilities: profile.clientCapabilities,
          clientInfo: profile.clientInfo,
          initializePayload,
          getClient: RcMap.get(
            clients,
            new McpClientKey({
              clientId: client.id,
              profile
            })
          ).pipe(
            Effect.map(({ client }) => client)
          )
        })
      ),
      CurrentLogLevel,
      effectLogLevel(session?.logLevel, defaultLogLevel)
    )
  })

  const patchedProtocol = RpcServer.Protocol.of({
    ...protocol,
    send: (clientId, response) => {
      if (response._tag === "Exit") {
        const requests = activeRequests.get(clientId)
        const key = requestKey(response.requestId)
        const cancelled = requests?.get(key)
        if (requests !== undefined && requests.delete(key) && requests.size === 0) {
          activeRequests.delete(clientId)
        }
        if (cancelled === true) {
          return Effect.void
        }
        if (
          response.exit._tag === "Failure" &&
          !response.exit.cause.some((failure) => failure._tag === "Fail")
        ) {
          return protocol.send(clientId, {
            _tag: "Exit",
            requestId: response.requestId,
            exit: {
              _tag: "Failure",
              cause: [{
                _tag: "Fail",
                error: new InternalError({ message: "Internal error" })
              }]
            }
          })
        }
      }
      return protocol.send(clientId, response)
    },
    run: (f) =>
      protocol.run((clientId, request_) => {
        const fiber = Fiber.getCurrent()!
        const request = request_ as unknown as
          | RpcMessage.FromServerEncoded
          | RpcMessage.FromClientEncoded
        const httpRequest = isHttp
          ? Context.getOrUndefined(fiber.context, HttpServerRequest.HttpServerRequest)
          : undefined
        if (httpRequest !== undefined && request._tag !== "Eof") {
          appendPreResponseHandlerUnsafe(httpRequest, (_, response) =>
            Effect.succeed(
              response.status === 200 &&
                response.body._tag === "Uint8Array" &&
                response.body.contentLength === 0
                ? HttpServerResponse.empty({
                  headers: Headers.remove(response.headers, "content-type"),
                  status: 202
                })
                : response
            ))
        }
        switch (request._tag) {
          case "Request": {
            const headers = isHttp
              ? Context.getUnsafe(
                Fiber.getCurrent()!.context,
                HttpServerRequest.HttpServerRequest
              ).headers
              : Headers.fromInput(request.headers)
            const session = getClientSession(sessions, clientId, headers)
            const selectedProtocol = session?.protocol ??
              (request.tag === "initialize"
                ? protocolRegistry.select(getOfferedProtocolVersion(request.payload))
                : protocolRegistry.protocols[0])
            // Selection happens before dated payload decoding. Once a
            // session exists, all later messages reuse its pinned adapter.
            clientProtocols.set(clientId, selectedProtocol)
            if (request.tag === MCP_INVALID_BATCH_METHOD) {
              return protocol.send(clientId, {
                _tag: "Exit",
                requestId: request.id,
                exit: {
                  _tag: "Failure",
                  cause: [{
                    _tag: "Fail",
                    error: new InvalidRequest({ message: "JSON-RPC batches are not supported" })
                  }]
                }
              })
            }
            if (isHttp) {
              const fiber = Fiber.getCurrent()!
              const httpRequest = Context.getUnsafe(fiber.context, HttpServerRequest.HttpServerRequest)
              if (session) {
                appendPreResponseHandlerUnsafe(httpRequest, (_, res) =>
                  Effect.succeed(
                    HttpServerResponse.setHeader(
                      res,
                      MCP_PROTOCOL_VERSION_HEADER,
                      session.protocol.protocolVersion
                    )
                  ))
              }
            }
            const routedRequest = protocolRegistry.routeClientRequest(selectedProtocol, request)
            const rpc = protocolRegistry.clientRpcs.requests.get(routedRequest.tag)
            if (
              rpc &&
              selectedProtocol.clientNotificationRpcs.requests.has(request.tag)
            ) {
              if (!session) {
                if (httpRequest) {
                  appendPreResponseHandlerUnsafe(
                    httpRequest,
                    () =>
                      Effect.succeed(
                        HttpServerResponse.empty({
                          status: headers[MCP_SESSION_ID_HEADER] === undefined ? 400 : 404
                        })
                      )
                  )
                }
                return Effect.void
              }
              const decode = selectedProtocol.payloadCodecs(rpc).decode(request.payload)
              return decode.pipe(
                Effect.flatMap((payload) => {
                  if (
                    request.tag === "notifications/roots/list_changed" &&
                    session.initializePayload.capabilities.roots?.listChanged === true &&
                    httpRequest === undefined
                  ) {
                    return RcMap.get(
                      clients,
                      new McpClientKey({
                        clientId,
                        profile: session.negotiatedProfile
                      })
                    ).pipe(
                      Effect.flatMap(({ client }) => client.listRoots()),
                      Effect.scoped,
                      Effect.ignoreCause,
                      Effect.forkIn(serverScope),
                      Effect.asVoid
                    )
                  }
                  if (request.tag === "notifications/cancelled") {
                    return selectedProtocol.normalizeCancellation(payload).pipe(
                      Effect.flatMap((cancellation) => {
                        const key = requestKey(cancellation.requestId)
                        const requests = activeRequests.get(clientId)
                        if (requests?.has(key) !== true) {
                          return Effect.void
                        }
                        requests.set(key, true)
                        return f(clientId, {
                          _tag: "Interrupt",
                          requestId: String(cancellation.requestId)
                        })
                      })
                    )
                  }
                  const handler = handlers.mapUnsafe.get(rpc.key) as Rpc.Handler<string> | undefined
                  return handler
                    ? handler.handler(payload, {
                      rpc,
                      requestId: RpcMessage.RequestId(request.id),
                      client: new Rpc.ServerClient(clientId),
                      headers
                    }) as any as Effect.Effect<void>
                    : Effect.void
                }),
                Effect.ignoreCause
              )
            }
            if (!rpc) {
              if (request.isNotification) {
                return Effect.void
              }
              return protocol.send(clientId, {
                _tag: "Exit",
                requestId: request.id,
                exit: {
                  _tag: "Failure",
                  cause: [{ _tag: "Fail", error: new MethodNotFound({ message: `Method not found: ${request.tag}` }) }]
                }
              })
            }
            return selectedProtocol.payloadCodecs(rpc).decode(request.payload).pipe(
              Effect.matchEffect({
                onSuccess: () => {
                  if (request.isNotification !== true) {
                    const requests = activeRequests.get(clientId) ?? new Map<string, boolean>()
                    requests.set(requestKey(request.id), false)
                    activeRequests.set(clientId, requests)
                  }
                  return f(clientId, routedRequest)
                },
                onFailure: () =>
                  request.isNotification
                    ? Effect.void
                    : protocol.send(clientId, {
                      _tag: "Exit",
                      requestId: request.id,
                      exit: {
                        _tag: "Failure",
                        cause: [{ _tag: "Fail", error: new InvalidParams({ message: "Invalid method parameters" }) }]
                      }
                    })
              })
            )
          }
          case "Ping":
          case "Ack":
          case "Interrupt":
            return f(clientId, request)
          case "Eof":
            activeRequests.delete(clientId)
            clientProtocols.delete(clientId)
            clientProfiles.delete(clientId)
            if (!isHttp) {
              sessions.byClientId.delete(clientId)
            }
            return f(clientId, request)
          case "Pong":
          case "Exit":
          case "Chunk":
          case "ClientProtocolError":
          case "Defect": {
            const selectedProtocol = getProtocolForClient(clientProtocols, clientId, protocolRegistry)
            const profile = clientProfiles.get(clientId) ?? {
              protocolVersion: selectedProtocol.protocolVersion,
              clientCapabilities: {},
              clientInfo: { name: "unknown", version: "unknown" }
            }
            return RcMap.get(
              clients,
              new McpClientKey({
                clientId,
                profile
              })
            ).pipe(
              Effect.flatMap(({ write }) => write(request)),
              Effect.scoped
            )
          }
        }
      })
  })

  yield* Queue.take(internalState.get(server)!.notifications).pipe(
    Effect.flatMap(Effect.fnUntraced(function*({ notification, targetClientId }) {
      const clientIds = yield* patchedProtocol.clientIds
      for (const clientId of clientProtocols.keys()) {
        if (!clientIds.has(clientId)) {
          clientProtocols.delete(clientId)
          clientProfiles.delete(clientId)
          // HTTP client IDs are request-scoped; their UUID sessions outlive them.
          if (!isHttp) {
            sessions.byClientId.delete(clientId)
          }
        }
      }
      for (const clientId of server.initializedClients.keys()) {
        if (targetClientId !== undefined && clientId !== targetClientId) {
          continue
        }
        if (!clientIds.has(clientId)) {
          server.initializedClients.delete(clientId)
          continue
        }
        // This must stay below stale-client cleanup so transports without
        // notification support still prune initializedClients.
        if (!patchedProtocol.supportsNotifications) {
          continue
        }
        const selectedProtocol = clientProtocols.get(clientId)
        if (!selectedProtocol) {
          continue
        }
        yield* Effect.gen(function*() {
          const projected = yield* selectedProtocol.projectNotification(notification)
          if (projected === undefined) {
            return
          }
          const session = sessions.byClientId.get(clientId)
          if (
            notification._tag === "LoggingMessage" &&
            !isMcpLogLevelEnabled(notification.level, session?.logLevel, defaultLogLevel)
          ) {
            return
          }
          if (
            notification._tag === "ResourceUpdated" &&
            session?.resourceSubscriptions?.has(notification.uri) !== true
          ) {
            return
          }
          const rpc = selectedProtocol.serverNotificationRpcs.requests.get(projected.tag)
          if (!rpc) {
            return
          }
          const encoded = yield* selectedProtocol.payloadCodecs(rpc).encode(projected.payload)
          yield* patchedProtocol.send(clientId, {
            _tag: "Request",
            id: "",
            tag: projected.tag,
            payload: encoded,
            headers: [],
            isNotification: true
          })
        }).pipe(Effect.catchCause(() => Effect.void))
      }
    })),
    Effect.catchCause(() => Effect.void),
    Effect.forever,
    Effect.forkScoped
  )

  return yield* RpcServer.make(protocolRegistry.clientRpcs, {
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
  readonly description?: string | undefined
  readonly websiteUrl?: string | undefined
  readonly icons?: ReadonlyArray<McpSchema.Icon> | undefined
  readonly protocols: Arr.NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>
  readonly extensions?: ServerExtensions | undefined
}): Layer.Layer<McpServer | McpServerClient, Cause.IllegalArgumentError, RpcServer.Protocol> =>
  layerWithProtocolState(options).pipe(
    Layer.provide(layerMcpProtocolState(options.protocols))
  )

const layerWithProtocolState = (options: {
  readonly name: string
  readonly version: string
  readonly description?: string | undefined
  readonly websiteUrl?: string | undefined
  readonly icons?: ReadonlyArray<McpSchema.Icon> | undefined
  readonly extensions?: ServerExtensions | undefined
}): Layer.Layer<McpServer | McpServerClient, never, RpcServer.Protocol | McpProtocolState> =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const protocolState = yield* McpProtocolState
      yield* Effect.forkScoped(runWithProtocolState(options, protocolState))
    })
  ).pipe(
    Layer.provideMerge(McpServer.layer)
  )

/**
 * Creates a layer that runs an MCP server over standard input and output.
 *
 * **When to use**
 *
 * Use when an MCP client launches the server as a subprocess and communicates
 * through newline-delimited JSON-RPC messages.
 *
 * **Details**
 *
 * The selected protocol adapter controls the dated RPC schemas and JSON-RPC
 * batch policy. The layer provides `McpServer` and `McpServerClient` and
 * requires `Stdio`.
 *
 * @see {@link layer} for running over an existing `RpcServer.Protocol`
 * @see {@link layerHttp} for the single-endpoint HTTP transport
 *
 * @category layers
 * @since 4.0.0
 */
export const layerStdio = (options: {
  readonly name: string
  readonly version: string
  readonly description?: string | undefined
  readonly websiteUrl?: string | undefined
  readonly icons?: ReadonlyArray<McpSchema.Icon> | undefined
  readonly protocols: Arr.NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>
  readonly extensions?: ServerExtensions | undefined
}): Layer.Layer<McpServer | McpServerClient, Cause.IllegalArgumentError, Stdio> =>
  layer(options).pipe(
    Layer.provide(RpcServer.layerProtocolStdio),
    Layer.provide(Layer.succeed(
      RpcSerialization.RpcSerialization,
      mcpStdioSerialization(options.protocols)
    ))
  )

const mcpStdioSerialization = (
  protocols: Arr.NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>
): RpcSerialization.RpcSerialization["Service"] => {
  const serialization = RpcSerialization.jsonRpc({
    contentType: "application/json-rpc"
  })
  return RpcSerialization.RpcSerialization.of({
    contentType: serialization.contentType,
    includesFraming: true,
    codecFor: serialization.codecFor,
    makeUnsafe: () => {
      const frames = RpcSerialization.ndjson.makeUnsafe()
      const parser = serialization.makeUnsafe()
      let selectedProtocol: McpProtocol.ProtocolAdapter | undefined
      return {
        decode: (data) => {
          const decoded: Array<unknown> = []
          for (const frame of frames.decode(data)) {
            if (Array.isArray(frame)) {
              const acceptsBatch = selectedProtocol?.transport.acceptsJsonRpcBatches === true
              if (
                !acceptsBatch ||
                frame.length === 0 ||
                frame.some(isInitializeJsonRpcMessage)
              ) {
                decoded.push({
                  _tag: "Request",
                  id: null,
                  tag: MCP_INVALID_BATCH_METHOD,
                  payload: null,
                  headers: []
                })
                continue
              }
            } else if (isInitializeJsonRpcMessage(frame)) {
              const offered = getJsonRpcProtocolVersion(frame)
              selectedProtocol = protocols.find((protocol) => protocol.protocolVersion === offered) ??
                protocols[0]
            }
            decoded.push(...parser.decode(JSON.stringify(frame)))
          }
          return decoded
        },
        encode: (response) => {
          const invalidBatchExit = decodeInvalidBatchExit(response)
          if (Result.isSuccess(invalidBatchExit)) {
            return JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {
                _tag: "Cause",
                code: McpSchema.INVALID_REQUEST_ERROR_CODE,
                message: "JSON-RPC batches are not supported",
                data: invalidBatchExit.success.exit.cause
              }
            }) + "\n"
          }
          const encoded = parser.encode(response)
          return encoded === undefined ? undefined : `${encoded}\n`
        }
      }
    }
  })
}

/**
 * Registers a Streamable HTTP MCP endpoint at `options.path`.
 *
 * **When to use**
 *
 * Use to expose an MCP server through an existing `HttpRouter`.
 *
 * **Details**
 *
 * POST serves JSON-RPC and accepted notification-only requests return `202`.
 * Unsupported protocol versions return `400`; methods without MCP handlers
 * return `405`. Requests carrying an `Origin` header are rejected unless the
 * exact origin appears in `allowedOrigins`; Origin-less non-browser clients
 * remain valid. The surrounding HTTP server remains responsible for binding
 * to an appropriate interface and installing authentication.
 *
 * `layerHttp` always implements the single-endpoint Streamable HTTP topology.
 * Using `v2024_11_05` here is a custom compatibility transport for that
 * revision's schema. It does not implement the historical two-endpoint
 * HTTP+SSE transport, GET SSE, event resumption, session expiry, or client
 * session termination.
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
  readonly description?: string | undefined
  readonly websiteUrl?: string | undefined
  readonly icons?: ReadonlyArray<McpSchema.Icon> | undefined
  readonly path: HttpRouter.PathInput
  readonly protocols: Arr.NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter>
  readonly extensions?: ServerExtensions | undefined
  readonly allowedOrigins?: ReadonlyArray<string> | undefined
}): Layer.Layer<McpServer | McpServerClient, Cause.IllegalArgumentError, HttpRouter.HttpRouter> => {
  const protocolState = layerMcpProtocolState(options.protocols)
  const methodNotAllowedResponse = HttpServerResponse.empty({
    status: 405,
    headers: { allow: "POST" }
  })
  const methodNotAllowed = (request: HttpServerRequest.HttpServerRequest) =>
    isAllowedMcpOrigin(request, options.allowedOrigins)
      ? Effect.succeed(methodNotAllowedResponse)
      : Effect.succeed(HttpServerResponse.empty({ status: 403 }))
  const routes = Layer.mergeAll(
    HttpRouter.add("GET", options.path, methodNotAllowed),
    HttpRouter.add("PUT", options.path, methodNotAllowed),
    HttpRouter.add("PATCH", options.path, methodNotAllowed),
    HttpRouter.add("DELETE", options.path, methodNotAllowed),
    HttpRouter.add("OPTIONS", options.path, methodNotAllowed)
  )
  return Layer.merge(layerWithProtocolState(options), routes).pipe(
    Layer.provide(layerMcpProtocolHttp(options)),
    Layer.provide(protocolState),
    Layer.provide(RpcSerialization.layerJsonRpc())
  )
}

const layerMcpProtocolHttp = (options: {
  readonly path: HttpRouter.PathInput
  readonly allowedOrigins?: ReadonlyArray<string> | undefined
}): Layer.Layer<
  RpcServer.Protocol,
  never,
  McpProtocolState | RpcSerialization.RpcSerialization | HttpRouter.HttpRouter
> =>
  Layer.effect(RpcServer.Protocol)(Effect.gen(function*() {
    const state = yield* McpProtocolState
    const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffect()
    const router = yield* HttpRouter.HttpRouter
    yield* router.add("POST", options.path, (request) => {
      if (!isAllowedMcpOrigin(request, options.allowedOrigins)) {
        return Effect.succeed(HttpServerResponse.empty({ status: 403 }))
      }
      if (mcpMediaTypes(request.headers["content-type"])[0] !== "application/json") {
        return Effect.succeed(HttpServerResponse.empty({ status: 415 }))
      }
      const accepted = mcpMediaTypes(request.headers["accept"])
      if (!accepted.includes("application/json") || !accepted.includes("text/event-stream")) {
        return Effect.succeed(HttpServerResponse.empty({ status: 406 }))
      }
      const protocolVersion = request.headers[MCP_PROTOCOL_VERSION_HEADER]
      const sessionId = request.headers[MCP_SESSION_ID_HEADER]
      const session = sessionId === undefined
        ? undefined
        : state.sessions.bySessionId.get(sessionId)
      if (sessionId !== undefined && session === undefined) {
        return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
      }
      const protocolVersionHeaderRejected = (protocolVersion !== undefined &&
        !state.protocolRegistry.protocols.some((protocol) => protocol.protocolVersion === protocolVersion)) ||
        (session?.protocol.transport.requiresVersionHeader === true &&
          protocolVersion !== session.protocol.protocolVersion)
      const parseErrorResponse = protocolVersionHeaderRejected
        ? HttpServerResponse.empty({ status: 400 })
        : HttpServerResponse.jsonUnsafe({
          jsonrpc: "2.0",
          id: null,
          error: new McpSchema.ParseError({ message: "Parse error" })
        })
      return request.text.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)),
        Effect.matchEffect({
          onFailure: () => Effect.succeed(parseErrorResponse),
          onSuccess: (input) => {
            if (!Array.isArray(input)) {
              const hasId = Predicate.hasProperty(input, "id")
              const id = hasId && (typeof input.id === "string" || typeof input.id === "number")
                ? input.id
                : null
              const isJsonRpc = Predicate.hasProperty(input, "jsonrpc") && input.jsonrpc === "2.0"
              const hasValidRequestId = !hasId || typeof input.id === "string" || typeof input.id === "number"
              const isRequest = isJsonRpc && hasValidRequestId &&
                Predicate.hasProperty(input, "method") && typeof input.method === "string"
              const hasValidResponseId = hasId &&
                (typeof input.id === "string" || typeof input.id === "number" || input.id === null)
              const hasResult = Predicate.hasProperty(input, "result")
              const hasError = Predicate.hasProperty(input, "error")
              const isResponse = isJsonRpc && hasValidResponseId && hasResult !== hasError
              const isInitialize = isRequest && isInitializeJsonRpcMessage(input)
              // Initialize requests are exempt from the version header check:
              // rejecting them with a 400 makes clients treat the endpoint as a
              // legacy HTTP+SSE server and retry initialization with a GET.
              if (!isInitialize && protocolVersionHeaderRejected) {
                return Effect.succeed(HttpServerResponse.empty({ status: 400 }))
              }
              if (!isRequest && !isResponse) {
                return Effect.succeed(HttpServerResponse.jsonUnsafe({
                  jsonrpc: "2.0",
                  id,
                  error: new InvalidRequest({ message: "Invalid Request" })
                }))
              }
              if (isInitialize && sessionId !== undefined) {
                return Effect.succeed(HttpServerResponse.empty({ status: 400 }))
              }
              if (!isInitialize && isRequest && sessionId === undefined) {
                return Effect.succeed(HttpServerResponse.empty({ status: 400 }))
              }
              return httpEffect
            }
            if (protocolVersionHeaderRejected) {
              return Effect.succeed(HttpServerResponse.empty({ status: 400 }))
            }
            if (input.length === 0) {
              return Effect.succeed(HttpServerResponse.jsonUnsafe({
                jsonrpc: "2.0",
                id: null,
                error: new InvalidRequest({ message: "Invalid Request" })
              }, { status: 400 }))
            }
            if (input.some(isInitializeJsonRpcMessage) || session === undefined) {
              return Effect.succeed(HttpServerResponse.empty({ status: 400 }))
            }
            const selectedProtocol = session.protocol
            return selectedProtocol.transport.acceptsJsonRpcBatches
              ? httpEffect
              : Effect.succeed(HttpServerResponse.empty({ status: 400 }))
          }
        })
      )
    })
    return protocol
  }))

const isAllowedMcpOrigin = (
  request: HttpServerRequest.HttpServerRequest,
  allowedOrigins: ReadonlyArray<string> | undefined
): boolean => {
  const origin = request.headers["origin"]
  return origin === undefined || (allowedOrigins ?? []).includes(origin)
}

const mcpMediaTypes = (header: string | undefined): ReadonlyArray<string> =>
  header === undefined
    ? []
    : header.split(",").flatMap((part) => {
      const [mediaType, ...parameters] = part.split(";")
      const quality = parameters
        .map((parameter) => parameter.trim().toLowerCase())
        .find((parameter) => parameter.startsWith("q="))
      if (quality !== undefined) {
        const value = Number(quality.slice(2))
        if (!Number.isFinite(value) || value <= 0 || value > 1) {
          return []
        }
      }
      return [mediaType.trim().toLowerCase()]
    })

const InitializeJsonRpcMessage = Schema.Struct({
  method: Schema.Literal("initialize")
})

const isInitializeJsonRpcMessage = (message: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(InitializeJsonRpcMessage)(message))

const JsonRpcProtocolVersion = Schema.Struct({
  params: Schema.Struct({
    protocolVersion: Schema.String
  })
})

const getJsonRpcProtocolVersion = (message: unknown): string | undefined => {
  const decoded = Schema.decodeUnknownResult(JsonRpcProtocolVersion)(message)
  return Result.isSuccess(decoded) ? decoded.success.params.protocolVersion : undefined
}

const INTERNAL_TOOL_ERROR_MESSAGE = "Tool execution failed due to an internal server error."

const toolErrorResult = (message: string): CallToolResult =>
  new CallToolResult({
    isError: true,
    content: [{ type: "text", text: message }]
  })

/**
 * Registers a `Toolkit` with the `McpServer`.
 *
 * @category handlers
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
    const isDeclaredFailure = Schema.is(tool.failureSchema)
    const outputJsonSchema = Tool.getJsonSchemaFromSchema(tool.successSchema)
    const outputSchema = outputJsonSchema.type === "object"
      ? yield* Schema.decodeUnknownEffect(ToolJsonSchema)(outputJsonSchema).pipe(Effect.orDie)
      : undefined
    const inputSchema = yield* Schema.decodeUnknownEffect(ToolJsonSchema)(
      Tool.getJsonSchema(tool)
    ).pipe(Effect.orDie)
    const mcpTool = new McpTool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
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
        return built.handle(tool.name as keyof Tools, payload ?? {}).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideContext(
            services as Context.Context<Tool.HandlerServices<Tools[keyof Tools]>>
          ),
          Effect.map((result) =>
            new CallToolResult({
              isError: false,
              structuredContent: typeof result.encodedResult === "object" ? result.encodedResult : undefined,
              content: result.encodedResult === undefined ? [] : [{
                type: "text",
                text: JSON.stringify(result.encodedResult)
              }]
            })
          ),
          Effect.tapCause(Effect.logError),
          Effect.catch((error) => {
            if (AiError.isAiError(error)) {
              const reason = (error as AiError.AiError).reason
              return reason._tag === "ToolParameterValidationError"
                ? Effect.fail(new InvalidParams({ message: reason.message }))
                : Effect.succeed(toolErrorResult(INTERNAL_TOOL_ERROR_MESSAGE))
            }
            if (isDeclaredFailure(error)) {
              const message = error instanceof Error
                ? error.message
                : INTERNAL_TOOL_ERROR_MESSAGE
              return Effect.succeed(toolErrorResult(message))
            }
            return Effect.succeed(toolErrorResult(INTERNAL_TOOL_ERROR_MESSAGE))
          }),
          Effect.catchDefect(() => Effect.succeed(toolErrorResult(INTERNAL_TOOL_ERROR_MESSAGE)))
        )
      }
    })
  }
})

/**
 * Registers an `AiToolkit` with the `McpServer`.
 *
 * @category layers
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
    readonly [K in keyof Completions]: K extends Keys ? (
        input: string,
        context: CompletionContext
      ) => any
      : never
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
export type ResourceCompletions<Schemas extends ReadonlyArray<Schema.Constraint>> = {
  readonly [
    K in Extract<keyof Schemas, `${number}`> as Schemas[K] extends Param<infer Id, infer _S> ? Id
      : `param${K}`
  ]: (
    input: string,
    context: CompletionContext
  ) => Effect.Effect<Array<Schemas[K]["Type"]>, any, any>
}

/**
 * Registers an MCP resource or resource template from an Effect program.
 *
 * **When to use**
 *
 * Use when you are already inside an Effect program with an `McpServer`
 * service and need to add a concrete resource or URI-template resource
 * directly.
 *
 * @see {@link resource} for the layer-based resource registration wrapper
 *
 * @category handlers
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
  <const Schemas extends ReadonlyArray<Schema.Constraint>>(segments: TemplateStringsArray, ...schemas: Schemas): <
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
    readonly completion?:
      | Record<
        string,
        (
          input: string,
          context: CompletionContext
        ) => Effect.Effect<any>
      >
      | undefined
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
    const completions: Record<
      string,
      (
        input: string,
        context: CompletionContext
      ) => Effect.Effect<CompleteResult, InternalError>
    > = Object.create(null)
    for (const [param, handle] of Object.entries(options.completion ?? {})) {
      const encodeArray = Schema.encodeUnknownEffect(Schema.Array(params[param]))
      const handler = (
        input: string,
        context: CompletionContext
      ) =>
        handle(input, context).pipe(
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
 * @category layers
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
  <const Schemas extends ReadonlyArray<Schema.Constraint>>(segments: TemplateStringsArray, ...schemas: Schemas): <
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
 * Use when you are already inside an Effect program with an `McpServer`
 * service and need to add a prompt handler directly.
 *
 * **Details**
 *
 * Parameters are decoded with the supplied schema, completion handlers encode
 * per-parameter suggestions, and string prompt content is converted into a user
 * text message.
 *
 * @see {@link prompt} for the layer-based prompt registration wrapper
 *
 * @category handlers
 * @since 4.0.0
 */
export const registerPrompt = <
  E,
  R,
  Params extends Schema.Struct.Fields = {},
  const Completions extends {
    readonly [K in keyof Params]?: (
      input: string,
      context: CompletionContext
    ) => Effect.Effect<Array<Params[K]>, any, any>
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
  const props: Record<string, Schema.Constraint> = options.parameters ?? {}
  for (const [name, prop] of Object.entries(props)) {
    args.push({
      name,
      description: SchemaAST.resolveDescription(prop.ast),
      required: !SchemaAST.isOptional(prop.ast)
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
  const completion: Record<
    string,
    (
      input: string,
      context: CompletionContext
    ) => Effect.Effect<any>
  > = options.completion ?? {}
  return Effect.gen(function*() {
    const registry = yield* McpServer
    const services = yield* Effect.context<Exclude<R | Schema.Struct.DecodingServices<Params>, McpServerClient>>()
    const completions: Record<
      string,
      (
        input: string,
        context: CompletionContext
      ) => Effect.Effect<CompleteResult, InternalError, McpServerClient>
    > = Object.create(null)
    for (const [param, handle] of Object.entries(completion)) {
      const encodeArray = Schema.encodeEffect(Schema.Array(props[param]))
      const handler = (
        input: string,
        context: CompletionContext
      ) =>
        handle(input, context).pipe(
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
          Effect.flatMap((params) =>
            options.content(params as any).pipe(
              Effect.catchCause((cause) => {
                const prettyError = Cause.prettyErrors(cause)[0]
                return Effect.fail(new InternalError({ message: prettyError.message }))
              })
            )
          ),
          Effect.map((messages) => {
            messages = typeof messages === "string" ?
              [{
                role: "user",
                content: TextContent.make({ text: messages })
              }] :
              messages
            return new GetPromptResult({ messages, description: prompt.description })
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
 * @category layers
 * @since 4.0.0
 */
export const prompt = <
  E,
  R,
  Params extends Schema.Struct.Fields = {},
  const Completions extends {
    readonly [K in keyof Params]?: (
      input: string,
      context: CompletionContext
    ) => Effect.Effect<Array<Params[K]["Type"]>, any, any>
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
 * @category accessors
 * @since 4.0.0
 */
export const elicit: <S extends Schema.ConstraintEncoder<Record<string, unknown>, unknown>>(options: {
  readonly message: string
  readonly schema: S
}) => Effect.Effect<
  S["Type"],
  ElicitationDeclined,
  McpServerClient | S["DecodingServices"]
> = Effect.fnUntraced(function*<S extends Schema.ConstraintEncoder<Record<string, unknown>, unknown>>(options: {
  readonly message: string
  readonly schema: S
}) {
  const { getClient } = yield* McpServerClient
  const client = yield* getClient
  const schema = options.schema
  const request = yield* Schema.decodeUnknownEffect(McpSchema.ElicitRequestFormParams)({
    mode: "form",
    message: options.message,
    requestedSchema: Tool.getJsonSchemaFromSchema(schema)
  }).pipe(Effect.orDie)
  const res = yield* client.elicit(request).pipe(
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
 * @category accessors
 * @since 4.0.0
 */
export const clientCapabilities: Effect.Effect<
  ClientCapabilities,
  never,
  McpServerClient
> = McpServerClient.useSync((_) => _.clientCapabilities)

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

const compileUriTemplate = (segments: TemplateStringsArray, ...schemas: ReadonlyArray<Schema.Constraint>) => {
  let routerPath = segments[0].replace(":", "::")
  let uriPath = segments[0]
  const params: Record<string, Schema.Top> = Object.create(null)
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

const PingRpcs = RpcGroup.make(Ping).middleware(McpServerClientMiddleware)
const layerHandlers = (serverInfo: {
  readonly name: string
  readonly version: string
  readonly description?: string | undefined
  readonly websiteUrl?: string | undefined
  readonly icons?: ReadonlyArray<McpSchema.Icon> | undefined
  readonly extensions?: ServerExtensions | undefined
}, options: {
  readonly sessions: Sessions
  readonly protocolRegistry: McpProtocolRegistry.ProtocolRegistry<McpProtocol.ProtocolAdapter>
}) =>
  Layer.effectContext(
    Effect.gen(function*() {
      const server = yield* McpServer
      const defaultLogLevel = yield* CurrentLogLevel
      const contextMap = new Map<string, unknown>()
      const internalCore = internalState.get(server)!.core
      const handlerTarget = options.protocolRegistry.handlerTarget(contextMap)

      for (const protocol of options.protocolRegistry.protocols) {
        const wireHandlers = PingRpcs.of({
          // Requests
          ping: () => Effect.succeed({})
        })
        yield* handlerTarget.install(protocol, PingRpcs, wireHandlers)
        const lifecycle: McpProtocolInternal.LifecycleRuntime = {
          initialize: Effect.fnUntraced(
            function*(protocolVersion, profile, clientId) {
              const presence = yield* internalCore.registrationPresence
              let capabilities: McpCore.CanonicalServerCapabilities = {
                completions: true,
                logging: true
              }
              if (presence.tools) {
                capabilities = { ...capabilities, tools: { listChanged: true } }
              }
              if (presence.resources) {
                capabilities = {
                  ...capabilities,
                  resources: {
                    listChanged: true,
                    subscribe: true
                  }
                }
              }
              if (presence.prompts) {
                capabilities = { ...capabilities, prompts: { listChanged: true } }
              }
              if (serverInfo.extensions) {
                capabilities = {
                  ...capabilities,
                  extensions: serverInfo.extensions
                }
              }
              return yield* Effect.withFiber((fiber) => {
                const httpRequest = Context.getOrUndefined(fiber.context, HttpServerRequest.HttpServerRequest)
                if (httpRequest !== undefined && capabilities.resources !== undefined) {
                  capabilities = {
                    ...capabilities,
                    resources: { ...capabilities.resources, subscribe: false }
                  }
                }
                const initializePayload = Initialize.payloadSchema.make({
                  protocolVersion,
                  capabilities: profile.clientCapabilities,
                  clientInfo: profile.clientInfo,
                  _meta: profile.requestMetadata
                })
                const session: Session = {
                  initializePayload,
                  negotiatedProfile: profile,
                  protocol,
                  resourceSubscriptions: httpRequest === undefined && capabilities.resources?.subscribe === true
                    ? new Set()
                    : undefined,
                  logLevel: { _tag: "Effect", level: defaultLogLevel }
                }
                if (httpRequest) {
                  const sessionId = crypto.randomUUID()
                  options.sessions.bySessionId.set(sessionId, session)
                  appendPreResponseHandlerUnsafe(httpRequest, (_req, res) =>
                    Effect.succeed(HttpServerResponse.setHeaders(res, {
                      [MCP_SESSION_ID_HEADER]: sessionId,
                      [MCP_PROTOCOL_VERSION_HEADER]: protocol.protocolVersion
                    })))
                } else {
                  options.sessions.byClientId.set(clientId, session)
                }
                return Effect.succeed({
                  capabilities,
                  serverInfo: McpSchema.Implementation.make({
                    name: serverInfo.name,
                    version: serverInfo.version,
                    description: serverInfo.description,
                    websiteUrl: serverInfo.websiteUrl,
                    icons: serverInfo.icons
                  })
                })
              })
            }
          ),
          setLogLevel: Effect.fnUntraced(function*(level, clientId, headers) {
            const session = getClientSession(options.sessions, clientId, headers)
            if (session === undefined) {
              return
            }
            session.logLevel = { _tag: "Mcp", level }
          }),
          subscribe: Effect.fnUntraced(function*(uri, clientId, headers) {
            const subscriptions = getClientSession(options.sessions, clientId, headers)?.resourceSubscriptions
            if (subscriptions === undefined) {
              return yield* new McpProtocolInternal.ProtocolError({
                code: McpSchema.METHOD_NOT_FOUND_ERROR_CODE,
                message: "Resource subscriptions are not supported"
              })
            }
            subscriptions.add(uri)
          }),
          unsubscribe: Effect.fnUntraced(function*(uri, clientId, headers) {
            const subscriptions = getClientSession(options.sessions, clientId, headers)?.resourceSubscriptions
            if (subscriptions === undefined) {
              return yield* new McpProtocolInternal.ProtocolError({
                code: McpSchema.METHOD_NOT_FOUND_ERROR_CODE,
                message: "Resource subscriptions are not supported"
              })
            }
            subscriptions.delete(uri)
          }),
          clientNotification: Effect.fnUntraced(function*(notification, clientId) {
            if (notification._tag === "Initialized") {
              server.initializedClients.add(clientId)
            }
            return
          })
        }
        yield* protocol.installHandlers(
          internalCore,
          lifecycle,
          handlerTarget
        )
      }
      return Context.makeUnsafe(contextMap)
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

const getClientSession = (
  sessions: Sessions,
  clientId: number,
  headers: Headers.Headers
) => {
  const sessionId = headers[MCP_SESSION_ID_HEADER]
  if (sessionId === undefined) {
    return sessions.byClientId.get(clientId)
  }
  return sessions.bySessionId.get(sessionId)
}

const InvalidBatchExit = Schema.Struct({
  _tag: Schema.Literal("Exit"),
  requestId: Schema.Null,
  exit: Schema.Struct({
    _tag: Schema.Literal("Failure"),
    cause: Schema.Unknown
  })
})

const decodeInvalidBatchExit = Schema.decodeUnknownResult(InvalidBatchExit)

const mcpLogLevels: Record<McpSchema.LoggingLevel, { readonly effect: LogLevel.LogLevel; readonly order: number }> = {
  debug: { effect: "Debug", order: 0 },
  info: { effect: "Info", order: 1 },
  notice: { effect: "Info", order: 2 },
  warning: { effect: "Warn", order: 3 },
  error: { effect: "Error", order: 4 },
  critical: { effect: "Fatal", order: 5 },
  alert: { effect: "Fatal", order: 6 },
  emergency: { effect: "Fatal", order: 7 }
}

const effectLogLevel = (logLevel: SessionLogLevel | undefined, fallback: LogLevel.LogLevel): LogLevel.LogLevel =>
  logLevel?._tag === "Mcp" ? mcpLogLevels[logLevel.level].effect : logLevel?.level ?? fallback

const isMcpLogLevelEnabled = (
  level: McpSchema.LoggingLevel,
  minimum: SessionLogLevel | undefined,
  fallback: LogLevel.LogLevel
): boolean =>
  minimum?._tag === "Mcp"
    ? mcpLogLevels[level].order >= mcpLogLevels[minimum.level].order
    : LogLevel.isGreaterThanOrEqualTo(mcpLogLevels[level].effect, minimum?.level ?? fallback)

const OfferedProtocolVersion = Schema.Struct({
  protocolVersion: Schema.String
})

const getOfferedProtocolVersion = (payload: unknown): string => {
  const decoded = Schema.decodeUnknownResult(OfferedProtocolVersion)(payload)
  return Result.isSuccess(decoded) ? decoded.success.protocolVersion : ""
}

const protocolForInternalTag = (
  registry: McpProtocolRegistry.ProtocolRegistry<McpProtocol.ProtocolAdapter>,
  tag: string
): McpProtocol.ProtocolAdapter => {
  for (const protocol of registry.protocols) {
    const routed = registry.routeClientRequest(protocol, {
      _tag: "Request",
      id: 0,
      tag: "",
      payload: undefined,
      headers: []
    })
    if (tag.startsWith(routed.tag)) {
      return protocol
    }
  }
  return registry.protocols[0]
}

const getProtocolForClient = (
  clientProtocols: Map<number, McpProtocol.ProtocolAdapter>,
  clientId: number,
  registry: McpProtocolRegistry.ProtocolRegistry<McpProtocol.ProtocolAdapter>
): McpProtocol.ProtocolAdapter =>
  clientProtocols.get(clientId) ??
    registry.protocols[0]
