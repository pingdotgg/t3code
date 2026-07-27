import { Context, Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { describe, expect, it } from "tstyche"

describe("HttpRouter", () => {
  describe("toWebHandler", () => {
    it("excludes adapter services required by middleware from the request context", () => {
      class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()("CurrentUser") {}

      const app = HttpRouter.add(
        "GET",
        "/",
        Effect.gen(function*() {
          const user = yield* CurrentUser
          return HttpServerResponse.text(user.id)
        })
      )
      const { handler } = HttpRouter.toWebHandler(app, {
        disableLogger: true,
        middleware: (effect) => effect
      })

      expect(handler).type.toBe<
        (request: Request, context: Context.Context<CurrentUser>) => Promise<Response>
      >()
      expect(handler).type.toBeCallableWith(
        new Request("http://localhost/"),
        Context.make(CurrentUser, { id: "user-1" })
      )
    })
  })
})
