import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { User, UserId } from "../domain/User.ts"
import { SearchQueryTooShort, UserNotFound } from "../domain/UserErrors.ts"
import { Authorization } from "./Authorization.ts"

export class UsersApiGroup extends HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("list", "/", {
      query: {
        search: Schema.optional(Schema.String)
      },
      success: Schema.Array(User)
    }),
    HttpApiEndpoint.get("search", "/search", {
      // For get requests, payload uses the query string
      payload: {
        search: Schema.String
      },
      success: [
        Schema.Array(User),
        Schema.String.pipe(HttpApiSchema.asText({
          contentType: "text/csv"
        }))
      ],
      error: [
        SearchQueryTooShort.pipe(
          // If you want an error to return no content, you can use
          // `HttpApiSchema.asNoContent` and provide a decoder that transforms the
          // error into the appropriate type.
          HttpApiSchema.asNoContent({
            decode: () => new SearchQueryTooShort()
          })
        ),
        // You can also add some of the built in `HttpApiError`s to handle common
        // error cases like bad requests, unauthorized, etc.
        HttpApiError.RequestTimeoutNoContent
      ]
    }),
    HttpApiEndpoint.get("getById", "/:id", {
      params: {
        // Path parameter schemas need to be able to decode from strings.
        // Schema.decodeTo can be used to "bridge" between schemas
        id: Schema.FiniteFromString.pipe(
          Schema.decodeTo(UserId)
        )
      },
      success: User,
      error: UserNotFound.pipe(
        // If you want an error to return no content, you can use
        // `HttpApiSchema.asNoContent` and provide a decoder that transforms the
        // error into the appropriate type.
        HttpApiSchema.asNoContent({
          decode: () => new UserNotFound()
        })
      )
    }),
    HttpApiEndpoint.post("create", "/", {
      // For post requests, payload uses the request body. It defaults to JSON,
      // but you can specify other content types as well using
      // `HttpApiSchema.asText`, `HttpApiSchema.asMultipart`, etc.
      payload: Schema.Struct({
        name: Schema.String,
        email: Schema.String
      }),
      success: User
    }),
    HttpApiEndpoint.get("me", "/me", {
      success: User,
      error: UserNotFound.pipe(HttpApiSchema.status(404))
    })
  )
  // You can apply middleware to entire groups, which is useful for things like
  // authentication and authorization.
  //
  // You can also apply middleware to individual endpoints if you need more
  // fine-grained control.
  .middleware(Authorization)
  // To add a common prefix to all endpoints in a group, you can use the `prefix`
  // method. This is useful for grouping related endpoints together under a common
  // path segment. In this case, all endpoints in the `UsersApiGroup` will be
  // prefixed with `/users`.
  .prefix("/users")
  // You can add OpenAPI annotations to groups, endpoints, and even parameters and
  // request bodies. These will be merged together to generate the final OpenAPI
  // docs for the API
  .annotateMerge(OpenApi.annotations({
    title: "Users",
    description: "User management endpoints"
  }))
{}
