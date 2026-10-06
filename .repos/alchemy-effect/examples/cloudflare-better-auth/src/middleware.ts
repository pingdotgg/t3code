import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import { Auth } from "./auth.ts";
import { CurrentUser } from "./current-user.ts";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

export class AuthenticationUnavailable extends Schema.TaggedError<AuthenticationUnavailable>()(
  "AuthenticationUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()("app/Authentication", {
  error: [Unauthorized, AuthenticationUnavailable],
}) {
  static readonly layer = Layer.effect(
    Authentication,
    Effect.gen(function* () {
      const auth = yield* Auth;
      return (httpEffect) =>
        Effect.gen(function* () {
          const session = yield* auth.getSession().pipe(
            Effect.mapError(() => new AuthenticationUnavailable()),
            Effect.catchDefect(() =>
              Effect.fail(new AuthenticationUnavailable()),
            ),
          );
          if (session === null) return yield* new Unauthorized();
          return yield* Effect.provideService(
            httpEffect,
            CurrentUser,
            session.user,
          );
        }).pipe(
          // HttpApi does not carry Alchemy's runtime marker; the Worker owns request scope.
          Effect.provide(RuntimeContext.phantom),
        );
    }),
  );
}
