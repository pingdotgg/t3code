import * as Data from "../../../Data.ts"
import * as Effect from "../../../Effect.ts"
import * as Match from "../../../Match.ts"
import * as Result from "../../../Result.ts"
import * as Schema from "../../../Schema.ts"
import type * as Scope from "../../../Scope.ts"
import type * as Headers from "../../http/Headers.ts"
import type * as Rpc from "../../rpc/Rpc.ts"
import * as RpcClient from "../../rpc/RpcClient.ts"
import type { RpcClientError } from "../../rpc/RpcClientError.ts"
import type * as RpcGroup from "../../rpc/RpcGroup.ts"
import type * as PublicMcpProtocol from "../McpProtocol.ts"
import * as PublicMcpSchema from "../McpSchema.ts"
import * as McpCore from "./mcpCore.ts"

/** @internal */
export const profileFromClient = (
  request: PublicMcpSchema.McpServerClient["Service"]
): McpCore.NegotiatedProtocolProfile => ({
  protocolVersion: request.protocolVersion,
  clientCapabilities: request.clientCapabilities,
  clientInfo: request.clientInfo,
  requestMetadata: request.initializePayload._meta
})

/** @internal */
export const invocationFromClient = (
  request: PublicMcpSchema.McpServerClient["Service"]
): McpCore.McpInvocation => ({
  clientId: request.clientId,
  protocol: profileFromClient(request),
  requestContext: request
})

// NOTE: Keep the two codec assertions below as the single documented
// existential-schema boundary. Rpc.AnyWithProps intentionally erases each
// request's payload type, while the runtime schema still performs decoding and
// encoding; do not spread this erasure into MCP domain records.

/** @internal */
export interface LifecycleRuntime {
  readonly initialize: (
    protocolVersion: PublicMcpProtocol.ProtocolVersion,
    profile: McpCore.NegotiatedProtocolProfile,
    clientId: number
  ) => Effect.Effect<McpCore.CanonicalInitializeResult>
  readonly setLogLevel: (
    level: PublicMcpSchema.LoggingLevel,
    clientId: number,
    headers: Headers.Headers
  ) => Effect.Effect<void>
  readonly subscribe: (uri: string, clientId: number, headers: Headers.Headers) => Effect.Effect<void, ProtocolError>
  readonly unsubscribe: (uri: string, clientId: number, headers: Headers.Headers) => Effect.Effect<void, ProtocolError>
  readonly clientNotification: (
    notification: McpCore.ClientNotification,
    clientId: number,
    headers: Headers.Headers
  ) => Effect.Effect<void>
}

/** @internal */
export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  readonly code: number
  readonly message: string
  readonly data?: unknown
}> {
  static fromTool(
    error: McpCore.ToolError | McpCore.UnsupportedByProtocol
  ): ProtocolError {
    const message = Match.value(error).pipe(
      Match.tag("ToolNotFound", (error) => `Tool '${error.name}' not found`),
      Match.tag(
        "UnsupportedByProtocol",
        (error) => `${error.feature} is not supported by MCP ${error.protocolVersion}`
      ),
      Match.tags({
        InvalidToolInput: (error) => error.message,
        ToolExecutionError: (error) => error.message,
        ToolResultProjectionError: (error) => error.message
      }),
      Match.exhaustive
    )
    return new ProtocolError({ code: -32602, message })
  }

  static fromFeature(error: unknown): ProtocolError {
    if (error instanceof McpCore.PromptNotFound) {
      return new ProtocolError({ code: -32602, message: `Prompt '${error.name}' not found` })
    }
    if (error instanceof McpCore.ResourceNotFound) {
      return new ProtocolError({ code: -32002, message: `Resource '${error.uri}' not found` })
    }
    const decoded = Schema.decodeUnknownResult(ProtocolErrorFields)(error)
    if (Result.isSuccess(decoded)) {
      return new ProtocolError(decoded.success)
    }
    return new ProtocolError({ code: -32603, message: "MCP feature handler failed" })
  }
}

const ProtocolErrorFields = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown)
})

/** @internal */
export const reverseError = (
  operation: PublicMcpSchema.McpReverseOperationError["operation"]
) =>
(cause: unknown) =>
  cause instanceof PublicMcpSchema.McpReverseOperationUnsupported
    ? cause
    : new PublicMcpSchema.McpReverseOperationError({ operation, cause })

/** @internal */
export const transcode = <
  From extends Schema.Constraint,
  To extends Schema.Constraint
>(
  from: From,
  to: To,
  input: Schema.Schema.Type<From>
) =>
  Schema.encodeEffect(from)(input).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(to))
  )

/** @internal */
export const transcodeStrict = <
  From extends Schema.Constraint,
  To extends Schema.Constraint
>(
  from: From,
  to: To,
  input: Schema.Schema.Type<From>
) =>
  Schema.encodeEffect(from)(input).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(to, { onExcessProperty: "error" }))
  )

/** @internal */
export const makeNotificationProjector = Effect.fn(function*(
  options: {
    readonly supportsProgressMessage: boolean
  },
  notification: McpCore.ServerNotification
) {
  return McpCore.ServerNotification.$match(notification, {
    Cancelled: (notification): PublicMcpProtocol.ProjectedNotification => ({
      tag: PublicMcpSchema.CancelledNotification._tag,
      payload: PublicMcpSchema.CancelledNotification.payloadSchema.make({
        _meta: notification.metadata,
        requestId: notification.requestId,
        reason: notification.reason
      })
    }),
    Progress: (notification): PublicMcpProtocol.ProjectedNotification => ({
      tag: PublicMcpSchema.ProgressNotification._tag,
      payload: PublicMcpSchema.ProgressNotification.payloadSchema.make({
        _meta: notification.metadata,
        progressToken: notification.progressToken,
        progress: notification.progress,
        total: notification.total,
        message: options.supportsProgressMessage ? notification.message : undefined
      })
    }),
    LoggingMessage: (notification): PublicMcpProtocol.ProjectedNotification => ({
      tag: PublicMcpSchema.LoggingMessageNotification._tag,
      payload: PublicMcpSchema.LoggingMessageNotification.payloadSchema.make({
        _meta: notification.metadata,
        level: notification.level,
        logger: notification.logger,
        data: notification.data
      })
    }),
    ResourceUpdated: (notification): PublicMcpProtocol.ProjectedNotification => ({
      tag: PublicMcpSchema.ResourceUpdatedNotification._tag,
      payload: PublicMcpSchema.ResourceUpdatedNotification.payloadSchema.make({
        _meta: notification.metadata,
        uri: notification.uri
      })
    }),
    ResourcesChanged: (notification): PublicMcpProtocol.ProjectedNotification => ({
      tag: PublicMcpSchema.ResourceListChangedNotification._tag,
      payload: PublicMcpSchema.ResourceListChangedNotification.payloadSchema.make({
        _meta: notification.metadata
      })
    }),
    ToolsChanged: (notification): PublicMcpProtocol.ProjectedNotification => ({
      tag: PublicMcpSchema.ToolListChangedNotification._tag,
      payload: PublicMcpSchema.ToolListChangedNotification.payloadSchema.make({
        _meta: notification.metadata
      })
    }),
    PromptsChanged: (notification): PublicMcpProtocol.ProjectedNotification => ({
      tag: PublicMcpSchema.PromptListChangedNotification._tag,
      payload: PublicMcpSchema.PromptListChangedNotification.payloadSchema.make({
        _meta: notification.metadata
      })
    }),
    ElicitationComplete: () => undefined
  })
})

/** @internal */
export interface HandlerInstallationTarget {
  readonly install: <
    Rpcs extends Rpc.Any,
    Handlers extends RpcGroup.HandlersFrom<Rpcs>
  >(
    protocol: {
      readonly protocolVersion: string
    },
    rpcs: RpcGroup.RpcGroup<Rpcs>,
    handlers: Handlers
  ) => Effect.Effect<void, never, RpcGroup.HandlersServices<Rpcs, Handlers>>
}

/** @internal */
export interface ProtocolAdapter<
  out Version extends string = string,
  ClientRpcs extends Rpc.Any = Rpc.Any,
  ClientNotificationRpcs extends ClientRpcs = ClientRpcs,
  ServerRequestRpcs extends Rpc.Any = Rpc.Any,
  ServerNotificationRpcs extends Rpc.Any = Rpc.Any,
  HandlerRpcs extends Rpc.Any = never,
  HandlerRequirements = never
> {
  // Each adapter owns its dated RPC vocabulary, transport policy, handler
  // projection, and wire behavior.
  readonly protocolVersion: Version
  readonly transport: {
    readonly acceptsJsonRpcBatches: boolean
    readonly requiresVersionHeader: boolean
  }
  readonly clientRpcs: RpcGroup.RpcGroup<ClientRpcs>
  readonly clientNotificationRpcs: RpcGroup.RpcGroup<ClientNotificationRpcs>
  readonly serverRequestRpcs: RpcGroup.RpcGroup<ServerRequestRpcs>
  readonly serverNotificationRpcs: RpcGroup.RpcGroup<ServerNotificationRpcs>
  readonly payloadCodecs: (rpc: Rpc.AnyWithProps) => PublicMcpProtocol.PayloadCodecs
  readonly handlerRpcs?: RpcGroup.RpcGroup<HandlerRpcs> | undefined
  readonly installHandlers: (
    core: McpCore.McpCore,
    lifecycle: LifecycleRuntime,
    target: HandlerInstallationTarget
  ) => Effect.Effect<void, never, HandlerRequirements>
  readonly makeReverseClient: (
    profile: McpCore.NegotiatedProtocolProfile
  ) => Effect.Effect<
    PublicMcpSchema.McpReverseClient,
    never,
    RpcClient.Protocol | Scope.Scope
  >
  readonly projectNotification: (
    notification: McpCore.ServerNotification
  ) => Effect.Effect<PublicMcpProtocol.ProjectedNotification | undefined, McpCore.UnsupportedByProtocol>
  readonly normalizeCancellation: (
    payload: unknown
  ) => Effect.Effect<McpCore.Cancellation, unknown>
}

/** @internal */
export const make = <
  const Version extends string,
  ClientRpcs extends Rpc.Any,
  ClientNotificationRpcs extends ClientRpcs,
  ServerRequestRpcs extends Rpc.Any,
  ServerNotificationRpcs extends Rpc.Any,
  HandlerRpcs extends Rpc.Any = never,
  Handlers extends RpcGroup.HandlersFrom<HandlerRpcs> = RpcGroup.HandlersFrom<HandlerRpcs>
>(options: {
  readonly protocolVersion: Version
  readonly transport: {
    readonly acceptsJsonRpcBatches: boolean
    readonly requiresVersionHeader: boolean
  }
  readonly clientRpcs: RpcGroup.RpcGroup<ClientRpcs>
  readonly clientNotificationRpcs: RpcGroup.RpcGroup<ClientNotificationRpcs>
  readonly serverRequestRpcs: RpcGroup.RpcGroup<ServerRequestRpcs>
  readonly serverNotificationRpcs: RpcGroup.RpcGroup<ServerNotificationRpcs>
  readonly handlerRpcs?: RpcGroup.RpcGroup<HandlerRpcs> | undefined
  readonly makeHandlers?:
    | ((
      core: McpCore.McpCore,
      lifecycle: LifecycleRuntime
    ) => Handlers)
    | undefined
  readonly toReverseClient: (
    profile: McpCore.NegotiatedProtocolProfile,
    client: RpcClient.RpcClient<ServerRequestRpcs, RpcClientError>
  ) => PublicMcpSchema.McpReverseClient
  readonly projectNotification: (
    notification: McpCore.ServerNotification
  ) => Effect.Effect<PublicMcpProtocol.ProjectedNotification | undefined, McpCore.UnsupportedByProtocol>
  readonly normalizeCancellation: (
    payload: unknown
  ) => Effect.Effect<McpCore.Cancellation, unknown>
}): ProtocolAdapter<
  Version,
  ClientRpcs,
  ClientNotificationRpcs,
  ServerRequestRpcs,
  ServerNotificationRpcs,
  HandlerRpcs,
  RpcGroup.HandlersServices<HandlerRpcs, Handlers>
> => {
  const payloadCodecsCache = new WeakMap<Rpc.AnyWithProps, PublicMcpProtocol.PayloadCodecs>()
  const payloadCodecs = (rpc: Rpc.AnyWithProps): PublicMcpProtocol.PayloadCodecs => {
    let codecs = payloadCodecsCache.get(rpc)
    if (codecs === undefined) {
      const schema = Schema.toCodecJson(rpc.payloadSchema)
      codecs = {
        decode: Schema.decodeUnknownEffect(schema) as PublicMcpProtocol.PayloadCodecs["decode"],
        encode: Schema.encodeUnknownEffect(schema) as PublicMcpProtocol.PayloadCodecs["encode"]
      }
      payloadCodecsCache.set(rpc, codecs)
    }
    return codecs
  }

  const installHandlers = (
    core: McpCore.McpCore,
    lifecycle: LifecycleRuntime,
    target: HandlerInstallationTarget
  ): Effect.Effect<void, never, RpcGroup.HandlersServices<HandlerRpcs, Handlers>> =>
    options.handlerRpcs === undefined || options.makeHandlers === undefined
      ? Effect.void
      : target.install(options, options.handlerRpcs, options.makeHandlers(core, lifecycle))

  const makeReverseClient = (
    profile: McpCore.NegotiatedProtocolProfile
  ): Effect.Effect<
    PublicMcpSchema.McpReverseClient,
    never,
    RpcClient.Protocol | Scope.Scope
  > =>
    RpcClient.make(options.serverRequestRpcs, {
      spanPrefix: "McpServer/Client"
    }).pipe(
      Effect.map((client) => options.toReverseClient(profile, client))
    )

  return {
    ...options,
    payloadCodecs,
    installHandlers,
    makeReverseClient
  }
}
