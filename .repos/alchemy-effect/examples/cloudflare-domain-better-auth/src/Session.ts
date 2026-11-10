import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Auth } from "./Auth.ts";
import { CurrentUser } from "./CurrentUser.context.ts";
import { Session, Unauthorized } from "./Session.middleware.ts";
import { UserId } from "./User.id.ts";

/** The {@link Session} middleware: the user better-auth signed in, or Unauthorized. */
export const SessionLive = Layer.effect(
  Session,
  Effect.gen(function* () {
    const auth = yield* Auth;
    return (effect, { headers }) =>
      Effect.gen(function* () {
        const session = yield* auth
          .getSession(new Headers(Object.entries(headers)))
          .pipe(Effect.orDie);
        if (session === null) return yield* new Unauthorized();
        return yield* effect.pipe(
          Effect.provideService(CurrentUser, {
            userId: UserId.make(session.user.id),
            name: session.user.name,
          }),
        );
      }).pipe(Effect.provide(RuntimeContext.phantom));
  }),
);
