import { OpenAiClient, OpenAiWorkloadIdentity } from "@effect/ai-openai"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { TestClock } from "effect/testing"
import { WS } from "vitest-websocket-mock"

const IDENTITY_TOKEN = "identity.token.signature"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const API_URL = "https://api.openai.com/v1/responses"

describe("OpenAiWorkloadIdentity", () => {
  it.effect("exchanges the identity token for an access token", () =>
    Effect.gen(function*() {
      // OpenAI can leave `expires_in` out of the token response.
      const http = makeHttp(() => Response.json({ access_token: "access-1" }))
      const client = yield* HttpClient.HttpClient.pipe(
        Effect.provide(OpenAiWorkloadIdentity.layer({ ...options, identityTokenType: "id_token" })),
        Effect.provideService(HttpClient.HttpClient, http.client)
      )

      yield* client.get(API_URL)

      const [exchange, request] = http.requests
      assert.strictEqual(exchange.url, TOKEN_URL)
      assert.isUndefined(exchange.headers.authorization)
      assert.deepStrictEqual(bodyJson(exchange), {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: IDENTITY_TOKEN,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        identity_provider_id: "idp_1",
        service_account_id: "sa_1"
      })
      assert.strictEqual(request.headers.authorization, "Bearer access-1")
    }))

  it.effect("maps a rejected exchange to an AiError without the identity token", () =>
    Effect.gen(function*() {
      const http = makeHttp(() =>
        new Response(
          JSON.stringify({
            error: { message: `Authentication failed for ${IDENTITY_TOKEN}`, type: "invalid_request_error" }
          }).replaceAll(".", "\\u002e"),
          { status: 401, headers: { "www-authenticate": `Bearer error_description="${IDENTITY_TOKEN}"` } }
        )
      )
      const client = yield* OpenAiClient.OpenAiClient.pipe(provideClient(http))

      const error = yield* Effect.flip(client.createResponse({ model: "gpt-4o", input: "test" }))

      assert.strictEqual(error.reason._tag, "AuthenticationError")
      assert.include(error.message, "Authentication failed for <redacted>")
    }))

  describe("WebSocket mode", () => {
    it.effect("authenticates each connection with the current access token", () =>
      Effect.gen(function*() {
        const apiUrl = "https://connections.test/v1"
        const server = yield* makeSocketServer(apiUrl)
        const http = makeHttp()
        const connections: Array<string | undefined> = []

        yield* Effect.gen(function*() {
          const client = yield* OpenAiClient.OpenAiClient
          // An error event makes the client replace the connection.
          const failedTurn = Effect.gen(function*() {
            const [, stream] = yield* client.createResponseStream({ model: "gpt-4o", input: "test" })
            yield* Effect.all([
              Effect.flip(Stream.runDrain(stream)),
              reply(server, { type: "error", code: "server_error", message: "bad", param: null })
            ], { concurrency: "unbounded" })
          })

          yield* failedTurn
          yield* TestClock.adjust("1 hour")
          yield* failedTurn
        }).pipe(OpenAiClient.withWebSocketMode, provideClient(http, apiUrl), recordConnections(connections))

        assert.deepStrictEqual(connections, ["Bearer access-1", "Bearer access-2"])
      }))

    it.effect("fails the stream with an AiError when the exchange fails, and connects once it succeeds", () =>
      Effect.gen(function*() {
        const apiUrl = "https://exchange-failure.test/v1"
        const server = yield* makeSocketServer(apiUrl)
        let rejected = true
        const http = makeHttp((n) =>
          rejected ? Response.json({ error: "invalid_subject_token" }, { status: 401 }) : tokenResponse(n)
        )
        const connections: Array<string | undefined> = []

        yield* Effect.gen(function*() {
          const client = yield* OpenAiClient.OpenAiClient
          const error = yield* Effect.flip(client.createResponseStream({ model: "gpt-4o", input: "test" }))
          assert.strictEqual(error.reason._tag, "AuthenticationError")

          rejected = false
          const [, stream] = yield* client.createResponseStream({ model: "gpt-4o", input: "test" })
          yield* Effect.all([Stream.runDrain(stream), reply(server, completedEvent)], { concurrency: "unbounded" })
        }).pipe(OpenAiClient.withWebSocketMode, provideClient(http, apiUrl), recordConnections(connections))

        assert.deepStrictEqual(connections, ["Bearer access-3"])
      }))

    it.effect("keeps using a connected socket after the access token expires", () =>
      Effect.gen(function*() {
        const apiUrl = "https://connected.test/v1"
        const server = yield* makeSocketServer(apiUrl)
        const http = makeHttp(() => Response.json({ access_token: "access-1", expires_in: 40 }))
        const connections: Array<string | undefined> = []

        yield* Effect.gen(function*() {
          const client = yield* OpenAiClient.OpenAiClient
          const turn = Effect.gen(function*() {
            const [, stream] = yield* client.createResponseStream({ model: "gpt-4o", input: "test" })
            yield* Effect.all([Stream.runDrain(stream), reply(server, completedEvent)], { concurrency: "unbounded" })
          })

          yield* turn
          // The access token is used for 30 seconds, and an idle socket stays open for 60.
          yield* TestClock.adjust("31 seconds")
          yield* turn
        }).pipe(OpenAiClient.withWebSocketMode, provideClient(http, apiUrl), recordConnections(connections))

        assert.deepStrictEqual(connections, ["Bearer access-1"])
        assert.lengthOf(http.requests, 1)
      }))
  })
})

const options = {
  identityToken: Effect.succeed(Redacted.make(IDENTITY_TOKEN)),
  identityProviderId: "idp_1",
  serviceAccountId: "sa_1"
}

const tokenResponse = (n: number) => Response.json({ access_token: `access-${n}`, expires_in: 3600 })

type Http = ReturnType<typeof makeHttp>

const makeHttp = (token: (n: number) => Response = tokenResponse) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  let exchanges = 0
  const client = HttpClient.make((request) => {
    requests.push(request)
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, request.url === TOKEN_URL ? token(++exchanges) : new Response())
    )
  })
  return { client, requests }
}

const provideClient = (http: Http, apiUrl?: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(OpenAiClient.layer({ apiUrl }).pipe(Layer.provide(OpenAiWorkloadIdentity.layer(options)))),
    Effect.provideService(HttpClient.HttpClient, http.client)
  )

// Records the Authorization header of every WebSocket connection.
const recordConnections = (connections: Array<string | undefined>) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Socket.WebSocketConstructor, (url, options) => {
    const headers = typeof options === "object" && "headers" in options ? options.headers : undefined
    connections.push((headers as Record<string, string> | undefined)?.authorization)
    return new globalThis.WebSocket(url)
  })

const makeSocketServer = (apiUrl: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new WS(`${apiUrl.replace("https", "wss")}/responses`, { jsonProtocol: true })),
    (server) => Effect.sync(() => server.close())
  )

// Answers the next message the server receives.
const reply = (server: WS, event: object) =>
  Effect.promise(() => server.nextMessage).pipe(Effect.andThen(Effect.sync(() => server.send(event))))

const bodyJson = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined

const completedEvent = {
  type: "response.completed",
  sequence_number: 1,
  response: {
    id: "resp_1",
    object: "response",
    created_at: 1,
    model: "gpt-4o",
    status: "completed",
    output: [],
    metadata: null,
    temperature: null,
    top_p: null,
    tools: [],
    tool_choice: "auto",
    error: null,
    incomplete_details: null,
    instructions: null,
    parallel_tool_calls: false
  }
}
