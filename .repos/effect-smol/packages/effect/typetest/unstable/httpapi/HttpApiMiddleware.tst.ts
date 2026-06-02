import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { describe, expect, it } from "tstyche"

describe("HttpApiMiddleware", () => {
  describe("Service", () => {
    it("error", () => {
      class M extends HttpApiMiddleware.Service<M>()("Http/Logger", {
        error: Schema.String
      }) {}
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.String
      }).middleware(M)
      expect(M.error).type.toBe<ReadonlySet<Schema.Top>>()
      expect<HttpApiEndpoint.MiddlewareError<typeof endpoint>>().type.toBe<string>()
      expect(M.security).type.toBe<never>()
    })

    it("security", () => {
      class M extends HttpApiMiddleware.Service<M>()("M", {
        security: {
          cookie: HttpApiSecurity.apiKey({
            in: "cookie",
            key: "token"
          })
        }
      }) {}
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.String
      }).middleware(M)
      expect(M.error).type.toBe<ReadonlySet<Schema.Top>>()
      expect<HttpApiEndpoint.MiddlewareError<typeof endpoint>>().type.toBe<never>()
      expect(M.security).type.toBe<{ readonly cookie: HttpApiSecurity.ApiKey }>()
    })

    it("error + security", () => {
      class M extends HttpApiMiddleware.Service<M>()("Http/Logger", {
        error: Schema.String,
        security: {
          cookie: HttpApiSecurity.apiKey({
            in: "cookie",
            key: "token"
          })
        }
      }) {}
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.String
      }).middleware(M)
      expect(M.error).type.toBe<ReadonlySet<Schema.Top>>()
      expect<HttpApiEndpoint.MiddlewareError<typeof endpoint>>().type.toBe<string>()
      expect(M.security).type.toBe<{ readonly cookie: HttpApiSecurity.ApiKey }>()
    })

    it("error array", () => {
      class M extends HttpApiMiddleware.Service<M>()("Http/Auth", {
        error: [HttpApiError.UnauthorizedNoContent, HttpApiError.ForbiddenNoContent]
      }) {}
      const endpoint = HttpApiEndpoint.get("a", "/a", {
        success: Schema.String
      }).middleware(M)
      expect(M.error).type.toBe<ReadonlySet<Schema.Top>>()
      expect<HttpApiEndpoint.MiddlewareError<typeof endpoint>>().type.toBe<
        HttpApiError.Unauthorized | HttpApiError.Forbidden
      >()
    })
  })
})
