import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Api } from "../../api/Api.ts"
import { CurrentUser } from "../../api/Authorization.ts"
import { AuthorizationLayer } from "../Authorization.ts"
import { Users } from "../Users.ts"

export const UsersApiHandlers = HttpApiBuilder.group(
  Api,
  "users",
  Effect.fn(function*(handlers) {
    const users = yield* Users

    return handlers
      .handle("list", ({ query }) =>
        users.list(query.search).pipe(
          // The list endpoint expects no errors, so we convert any potential
          // errors into a 500 Internal Server Error.
          Effect.orDie
        ))
      .handle(
        "search",
        Effect.fn(function*({ payload }) {
          if (payload.search === "bad-request") {
            // You can use the built in error types like any other
            // Schema.TaggedErrorClass
            return yield* new HttpApiError.RequestTimeout()
          }
          return yield* users.list(payload.search).pipe(
            Effect.catchReason(
              "UsersError",
              "SearchQueryTooShort",
              // Re-fail the "SearchQueryTooShort" reason
              Effect.fail,
              // All other reasons are unexpected, so we convert them into a 500
              // Internal Server Error.
              Effect.die
            )
          )
        })
      )
      .handle("getById", ({ params }) =>
        users.getById(params.id).pipe(
          // You can also use Effect.catchReasons to handle multiple error
          // reasons at once
          Effect.catchReasons("UsersError", {
            UserNotFound: (e) => Effect.fail(e)
          }, Effect.die)
        ))
      .handle("create", ({ payload }) =>
        users.create(payload).pipe(
          Effect.orDie
          // You could alse use Effect.unwrapReason to moves rror reasons up to
          // the top level, so you can handle them with Effect.catch or
          // Effect.catchTag etc.
          //
          // Effect.unwrapReason("UsersError"),
          // Effect.catchTags({
          //   UserNotFound: Effect.die,
          //   SearchQueryTooShort: Effect.die
          // })
        ))
      .handle("me", () =>
        // The Authorization middleware provides the CurrentUser service, so we
        // can access it here.
        CurrentUser)
  })
).pipe(
  // Provide the dependencies for the handlers.
  Layer.provide([Users.layer, AuthorizationLayer])
)
