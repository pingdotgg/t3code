import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as McpProtocol from "effect/unstable/ai/McpProtocol"
import * as McpSchema from "effect/unstable/ai/McpSchema"
import { makeHttpHarness } from "../TestUtils/McpHttpHarness.ts"
import { makeServerLayer } from "../TestUtils/McpServerLayer.ts"
import { makeFeaturesServerLayer, type Observations } from "./McpConformanceFixtures.ts"
import { makeMcpTestPeer, type McpTestPeerOptions } from "./McpTestPeer.ts"

const SERVER_NAME = "McpConformance"
const SERVER_VERSION = "1.0.0"

const InitializeResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  result: McpSchema.InitializeResult
})

const ErrorResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  error: McpSchema.McpError
})

const ResultResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Number]),
  result: Schema.Record(Schema.String, Schema.Unknown)
})

const BatchResponse = Schema.Array(Schema.Struct({
  id: Schema.Number,
  result: Schema.Struct({})
}))

const decodeInitializeResponse = Schema.decodeUnknownEffect(InitializeResponse)
const decodeErrorResponse = Schema.decodeUnknownEffect(ErrorResponse)
const decodeResultResponse = Schema.decodeUnknownEffect(ResultResponse)
const decodeBatchResponse = Schema.decodeUnknownEffect(BatchResponse)

export interface InitializedSession {
  readonly response: Response
  readonly message: typeof InitializeResponse.Type
  readonly sessionId: string | null
  readonly server: "default" | "features"
}

export interface InitializeOptions {
  readonly id?: number | undefined
  readonly protocolVersion?: string | undefined
  readonly server?: "default" | "features" | undefined
}

export interface SendOptions {
  readonly includeProtocolVersion?: boolean | undefined
  readonly protocolVersion?: string | undefined
}

export interface McpConformanceShape {
  readonly protocol: McpProtocol.ProtocolAdapter
  readonly serverInfo: {
    readonly name: string
    readonly version: string
  }
  readonly initializeRequest: (options?: Omit<InitializeOptions, "server">) => {
    readonly jsonrpc: "2.0"
    readonly id: number
    readonly method: "initialize"
    readonly params: {
      readonly protocolVersion: string
      readonly capabilities: {}
      readonly clientInfo: {
        readonly name: string
        readonly version: string
      }
    }
  }
  readonly initializedNotification: {
    readonly jsonrpc: "2.0"
    readonly method: "notifications/initialized"
  }
  readonly pingRequest: (id?: number) => {
    readonly jsonrpc: "2.0"
    readonly id: number
    readonly method: "ping"
    readonly params: {}
  }
  readonly post: (body: unknown, headers?: HeadersInit) => Effect.Effect<Response>
  readonly request: (request: Request) => Effect.Effect<Response>
  readonly initialize: (
    options?: InitializeOptions
  ) => Effect.Effect<InitializedSession, Schema.SchemaError>
  readonly send: (
    session: InitializedSession,
    body: unknown,
    options?: SendOptions
  ) => Effect.Effect<Response>
  readonly sendText: (
    session: InitializedSession,
    body: string,
    options?: SendOptions
  ) => Effect.Effect<Response>
  readonly notifyInitialized: (
    session: InitializedSession,
    options?: SendOptions
  ) => Effect.Effect<Response>
  readonly ping: (
    session: InitializedSession,
    options?: SendOptions & { readonly id?: number | undefined }
  ) => Effect.Effect<Response>
  readonly makePeer: (
    options?: McpTestPeerOptions
  ) => ReturnType<typeof makeMcpTestPeer>
  readonly observations: Effect.Effect<Observations>
  readonly resetObservations: Effect.Effect<void>
  readonly decodeError: (response: Response) => Effect.Effect<typeof ErrorResponse.Type, Schema.SchemaError>
  readonly decodeResult: (response: Response) => Effect.Effect<typeof ResultResponse.Type, Schema.SchemaError>
  readonly decodeBatchResponseIds: (
    response: Response
  ) => Effect.Effect<ReadonlyArray<number>, Schema.SchemaError>
}

export class McpConformance extends Context.Service<McpConformance, McpConformanceShape>()(
  "effect/test/unstable/ai/McpConformance"
) {}

export type McpConformanceLayer = Layer.Layer<McpConformance, unknown>

export const layer = (protocol: McpProtocol.ProtocolAdapter) =>
  Layer.effect(
    McpConformance,
    Effect.gen(function*() {
      const defaultHarness = yield* makeHttpHarness(makeServerLayer({
        name: SERVER_NAME,
        protocols: [protocol]
      }))
      const observations = yield* Ref.make<Observations>({
        toolInvocations: 0,
        promptInvocations: 0,
        resourceTemplateInvocations: 0
      })
      const featuresHarness = yield* makeHttpHarness(makeFeaturesServerLayer(protocol, observations))

      const initializeRequest: McpConformanceShape["initializeRequest"] = (options) => ({
        jsonrpc: "2.0",
        id: options?.id ?? 1,
        method: "initialize",
        params: {
          protocolVersion: options?.protocolVersion ?? protocol.protocolVersion,
          capabilities: {},
          clientInfo: {
            name: "McpConformanceClient",
            version: "1.0.0"
          }
        }
      })

      const initializedNotification = {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      } as const

      const pingRequest: McpConformanceShape["pingRequest"] = (id = 2) => ({
        jsonrpc: "2.0",
        id,
        method: "ping",
        params: {}
      })

      const initialize: McpConformanceShape["initialize"] = Effect.fnUntraced(function*(options) {
        const server = options?.server ?? "default"
        const harness = server === "features" ? featuresHarness : defaultHarness
        const response = yield* harness.post(initializeRequest(options))
        const body = yield* Effect.promise<unknown>(() => response.json())
        return {
          response,
          message: yield* decodeInitializeResponse(body),
          sessionId: response.headers.get("Mcp-Session-Id"),
          server
        }
      })

      const sessionHeaders = (session: InitializedSession, options?: SendOptions): HeadersInit => ({
        ...(session.sessionId === null ? {} : { "Mcp-Session-Id": session.sessionId }),
        ...(options?.includeProtocolVersion ?? true
          ? {
            "Mcp-Protocol-Version": options?.protocolVersion ?? session.message.result.protocolVersion
          }
          : {})
      })

      const harnessFor = (session: InitializedSession) =>
        session.server === "features" ? featuresHarness : defaultHarness

      const sendText: McpConformanceShape["sendText"] = (session, body, options) =>
        harnessFor(session).postText(body, sessionHeaders(session, options))

      const send: McpConformanceShape["send"] = (session, body, options) =>
        harnessFor(session).post(body, sessionHeaders(session, options))

      const notifyInitialized: McpConformanceShape["notifyInitialized"] = (session, options) =>
        send(session, initializedNotification, options)

      const ping: McpConformanceShape["ping"] = (session, options) => send(session, pingRequest(options?.id), options)

      return McpConformance.of({
        protocol,
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        },
        initializeRequest,
        initializedNotification,
        pingRequest,
        post: defaultHarness.post,
        request: (request) => Effect.promise(() => defaultHarness.handler(request)),
        initialize,
        send,
        sendText,
        notifyInitialized,
        ping,
        makePeer: (options) => makeMcpTestPeer(protocol, options),
        observations: Ref.get(observations),
        resetObservations: Ref.set(observations, {
          toolInvocations: 0,
          promptInvocations: 0,
          resourceTemplateInvocations: 0
        }),
        decodeError: (response) =>
          Effect.promise<unknown>(() => response.json()).pipe(
            Effect.flatMap(decodeErrorResponse)
          ),
        decodeResult: (response) =>
          Effect.promise<unknown>(() => response.json()).pipe(
            Effect.flatMap(decodeResultResponse)
          ),
        decodeBatchResponseIds: (response) =>
          Effect.promise<unknown>(() => response.json()).pipe(
            Effect.flatMap(decodeBatchResponse),
            Effect.map((responses) => responses.map((message) => message.id))
          )
      })
    })
  )
