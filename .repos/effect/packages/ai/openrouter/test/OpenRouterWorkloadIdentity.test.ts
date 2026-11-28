import { OpenRouterClient, OpenRouterWorkloadIdentity } from "@effect/ai-openrouter"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"

const IDENTITY_TOKEN = "identity.token.signature"
// A trailing slash, which OpenRouterClient also accepts.
const API_URL = "https://openrouter.ai/api/v1/"
const TOKEN_URL = "https://openrouter.ai/api/v1/oauth/token"

describe("OpenRouterWorkloadIdentity", () => {
  it.effect("exchanges the identity token and authenticates every client request path", () =>
    Effect.gen(function*() {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const httpClient = HttpClient.make((request) => {
        requests.push(request)
        return Effect.succeed(HttpClientResponse.fromWeb(
          request,
          request.url === TOKEN_URL
            ? Response.json({ access_token: "access-1", expires_in: 900 })
            : new Response()
        ))
      })
      const client = yield* OpenRouterClient.OpenRouterClient.pipe(
        Effect.provide(
          OpenRouterClient.layer({ apiUrl: API_URL }).pipe(Layer.provide(OpenRouterWorkloadIdentity.layer({
            identityToken: Effect.succeed(Redacted.make(IDENTITY_TOKEN)),
            federationPolicyId: "policy_1",
            apiUrl: API_URL
          })))
        ),
        Effect.provideService(HttpClient.HttpClient, httpClient)
      )
      const messages = [{ role: "user" as const, content: "hello" }]

      yield* Effect.ignore(client.createChatCompletion({ model: "openai/gpt-4o-mini", messages }))
      yield* Effect.ignore(client.createChatCompletionStream({ model: "openai/gpt-4o-mini", messages }))
      yield* Effect.ignore(client.createDecisions({ model: "openai/gpt-4o-mini", state: {}, questions: {} }))

      const [exchange, ...apiRequests] = requests
      assert.strictEqual(exchange.url, TOKEN_URL)
      assert.isUndefined(exchange.headers.authorization)
      assert.strictEqual(exchange.headers["content-type"], "application/x-www-form-urlencoded")
      assert.deepStrictEqual(bodyParams(exchange), {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: IDENTITY_TOKEN,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        federation_policy_id: "policy_1",
        scope: "inference"
      })
      assert.deepStrictEqual(
        apiRequests.map((request) => [request.url, request.headers.authorization]),
        [
          ["https://openrouter.ai/api/v1/chat/completions", "Bearer access-1"],
          ["https://openrouter.ai/api/v1/chat/completions", "Bearer access-1"],
          ["https://openrouter.ai/api/alpha/decisions", "Bearer access-1"]
        ]
      )
    }))
})

const bodyParams = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body.body)))
    : undefined
