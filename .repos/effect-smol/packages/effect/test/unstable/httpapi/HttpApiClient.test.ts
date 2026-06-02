import { describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Schema } from "effect"
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

describe("HttpApiClient", () => {
  describe("urlBuilder", () => {
    const Api = HttpApi.make("Api")
      .add(
        HttpApiGroup.make("users")
          .add(
            HttpApiEndpoint.get("getUser", "/users/:id", {
              params: {
                id: Schema.Finite
              },
              query: {
                page: Schema.Finite,
                tags: Schema.Array(Schema.Finite)
              }
            }),
            HttpApiEndpoint.get("health", "/health")
          )
      )

    it("builds urls using endpoint schemas", () => {
      const builder = HttpApiClient.urlBuilder(Api, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(
        builder.users.getUser({
          params: {
            id: 123
          },
          query: {
            page: 1,
            tags: [1, 2]
          }
        }),
        "https://api.example.com/users/123?page=1&tags=1&tags=2"
      )
    })

    it("returns relative urls when baseUrl is omitted", () => {
      const builder = HttpApiClient.urlBuilder(Api)

      strictEqual(builder.users.health(), "/health")
    })

    it("supports top-level endpoints", () => {
      const TopLevelApi = HttpApi.make("Api")
        .add(
          HttpApiGroup.make("top", { topLevel: true })
            .add(
              HttpApiEndpoint.get("health", "/health")
            )
        )
        .prefix("/v1")

      const builder = HttpApiClient.urlBuilder(TopLevelApi, {
        baseUrl: "https://api.example.com"
      })

      strictEqual(builder.health(), "https://api.example.com/v1/health")
    })
  })
})
