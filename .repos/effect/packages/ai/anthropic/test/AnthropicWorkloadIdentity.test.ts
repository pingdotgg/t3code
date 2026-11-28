import { AnthropicClient, AnthropicWorkloadIdentity } from "@effect/ai-anthropic"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"

const IDENTITY_TOKEN = "identity.token.signature"
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token"

describe("AnthropicWorkloadIdentity", () => {
  it.effect("exchanges the identity token and adds the OAuth beta to authenticated requests", () =>
    Effect.gen(function*() {
      const http = makeHttp()
      const client = yield* HttpClient.HttpClient.pipe(
        Effect.provide(AnthropicWorkloadIdentity.layer({
          ...options,
          serviceAccountId: "svac_1",
          workspaceId: "wrkspc_1"
        })),
        Effect.provideService(HttpClient.HttpClient, http.client)
      )

      yield* client.get("https://api.anthropic.com/v1/messages", {
        headers: { "anthropic-beta": "files-api-2025-04-14" }
      })

      const [exchange, request] = http.requests
      assert.strictEqual(exchange.url, TOKEN_URL)
      assert.isUndefined(exchange.headers.authorization)
      assert.strictEqual(exchange.headers["anthropic-beta"], "oauth-2025-04-20,oidc-federation-2026-04-01")
      assert.deepStrictEqual(bodyJson(exchange), {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: IDENTITY_TOKEN,
        federation_rule_id: "fdrl_1",
        organization_id: "org_1",
        service_account_id: "svac_1",
        workspace_id: "wrkspc_1"
      })
      assert.strictEqual(request.headers.authorization, "Bearer access-1")
      assert.strictEqual(request.headers["anthropic-beta"], "files-api-2025-04-14,oauth-2025-04-20")
    }))

  it.effect("maps a rejected exchange to an AiError without the identity token", () =>
    Effect.gen(function*() {
      const http = makeHttp(() =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: `Authentication failed for ${IDENTITY_TOKEN}` }
          }).replaceAll(".", "\\u002e"),
          { status: 401, headers: { "www-authenticate": `Bearer error_description="${IDENTITY_TOKEN}"` } }
        )
      )
      const client = yield* AnthropicClient.AnthropicClient.pipe(
        Effect.provide(AnthropicClient.layer({}).pipe(Layer.provide(AnthropicWorkloadIdentity.layer(options)))),
        Effect.provideService(HttpClient.HttpClient, http.client)
      )

      const error = yield* Effect.flip(client.createMessage({
        payload: { model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hello" }] }
      }))

      assert.strictEqual(error.reason._tag, "AuthenticationError")
      assert.include(error.message, "Authentication failed for <redacted>")
    }))
})

const options = {
  identityToken: Effect.succeed(Redacted.make(IDENTITY_TOKEN)),
  federationRuleId: "fdrl_1",
  organizationId: "org_1"
}

const makeHttp = (token = () => Response.json({ access_token: "access-1", expires_in: 3600 })) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = []
  const client = HttpClient.make((request) => {
    requests.push(request)
    return Effect.succeed(HttpClientResponse.fromWeb(request, request.url === TOKEN_URL ? token() : new Response()))
  })
  return { client, requests }
}

const bodyJson = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
