import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

const Routes = Layer.mergeAll(
  HttpRouter.add("GET", "/hello", HttpServerResponse.text("Hello")),
  HttpRouter.add(
    "GET",
    "/users/:id",
    Effect.map(HttpRouter.params, (params) => HttpServerResponse.jsonUnsafe({ id: params.id }))
  )
)

const { handler } = HttpRouter.toWebHandler(Routes, { disableLogger: true })

handler(new Request("http://localhost/hello")).then((response) => response.text())
