import { Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi"
import { type Atom, AtomHttpApi } from "effect/unstable/reactivity"
import { describe, expect, it } from "tstyche"

class EndpointError extends Schema.ErrorClass<EndpointError>("EndpointError")({
  _tag: Schema.tag("EndpointError")
}) {}

class MiddlewareError extends Schema.ErrorClass<MiddlewareError>("MiddlewareError")({
  _tag: Schema.tag("MiddlewareError")
}) {}

class MiddlewareClientError extends Schema.ErrorClass<MiddlewareClientError>("MiddlewareClientError")({
  _tag: Schema.tag("MiddlewareClientError")
}) {}

class TestMiddleware extends HttpApiMiddleware.Service<TestMiddleware, {
  clientError: MiddlewareClientError
}>()("TestMiddleware", {
  error: MiddlewareError,
  requiredForClient: true
}) {}

const Api = HttpApi.make("Api").add(
  HttpApiGroup.make("group").add(
    HttpApiEndpoint.get("get", "/get", {
      success: Schema.String,
      error: EndpointError
    }).middleware(TestMiddleware)
  )
)

const Client = AtomHttpApi.Service()("Client", {
  api: Api,
  httpClient: Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("not used")))
})

describe("AtomHttpApi", () => {
  it("should include middleware errors in query and mutation atoms", () => {
    const mutation = Client.mutation("group", "get")
    const query = Client.query("group", "get", {})

    expect<Atom.Failure<typeof mutation>>().type.toBe<
      EndpointError | MiddlewareError | MiddlewareClientError
    >()

    expect<Atom.Failure<typeof query>>().type.toBe<
      EndpointError | MiddlewareError | MiddlewareClientError
    >()
  })

  it("should mirror HttpApiClient response-only error behavior", () => {
    const mutation = Client.mutation("group", "get", {
      responseMode: "response-only"
    })

    expect<Atom.Failure<typeof mutation>>().type.toBe<
      MiddlewareError | MiddlewareClientError
    >()
  })
})
