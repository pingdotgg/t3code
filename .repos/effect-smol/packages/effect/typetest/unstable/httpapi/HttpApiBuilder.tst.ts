import { Context, Effect, Schema } from "effect"
import type { FileSystem } from "effect/FileSystem"
import type { Path } from "effect/Path"
import type { Generator } from "effect/unstable/http/Etag"
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform"
import type { RouteContext } from "effect/unstable/http/HttpRouter"
import type { HttpServerRequest, ParsedSearchParams } from "effect/unstable/http/HttpServerRequest"
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse"
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity
} from "effect/unstable/httpapi"
import { describe, expect, it } from "tstyche"

describe("HttpApiBuilder", () => {
  describe("endpoint", () => {
    it("middleware & services", () => {
      const api = HttpApi.make("api").add(
        HttpApiGroup.make("group").add(
          HttpApiEndpoint.get("getUser", "/users/:id", {
            params: {
              id: Schema.String
            },
            success: Schema.Struct({
              id: Schema.String
            })
          }).middleware(M)
        )
      )
      const handler = HttpApiBuilder.endpoint(
        api,
        "group",
        "getUser",
        Effect.fnUntraced(function*(ctx) {
          yield* CurrentUser
          return { id: ctx.params.id }
        })
      )
      expect(handler).type.toBe<
        Effect.Effect<
          Effect.Effect<HttpServerResponse, never, HttpServerRequest | ParsedSearchParams | RouteContext>,
          never,
          M | Token | Generator | FileSystem | HttpPlatform | Path
        >
      >()
    })
  })
})

class Token extends Context.Service<Token, {
  readonly token: string
}>()("Token") {}

class CurrentUser extends Context.Service<CurrentUser, {
  readonly userId: string
}>()("CurrentUser") {}

class M extends HttpApiMiddleware.Service<M, {
  requires: Token
  provides: CurrentUser
}>()("Http/Logger", {
  error: Schema.String,
  security: {
    cookie: HttpApiSecurity.apiKey({
      in: "cookie",
      key: "token"
    })
  }
}) {}
