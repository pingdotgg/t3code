import { BetterAuth, type BetterAuthApiError } from "@alchemy.run/better-auth";
import type { RuntimeContext } from "alchemy";
import type { HttpEffect } from "alchemy/Http";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/** What the Worker needs from better-auth: its routes, and the session behind a request. */
export class Auth extends Context.Service<
  Auth,
  {
    readonly fetch: HttpEffect<RuntimeContext>;
    readonly getSession: (
      headers: Headers,
    ) => Effect.Effect<
      { readonly user: { readonly id: string; readonly name: string } } | null,
      BetterAuthApiError,
      RuntimeContext
    >;
  }
>()("Notes/Auth") {}

/** better-auth with GitHub and Google sign-in, its tables in the Worker's database. */
export const AuthLive = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const baseURL = yield* Config.String("AUTH_BASE_URL").pipe(Config.option);
    return yield* BetterAuth({
      basePath: "/api/auth",
      baseURL: Option.getOrUndefined(baseURL),
      socialProviders: {
        github: {
          clientId: yield* Config.String("GITHUB_CLIENT_ID"),
          clientSecret: Redacted.value(yield* Config.Redacted("GITHUB_CLIENT_SECRET")),
        },
        google: {
          clientId: yield* Config.String("GOOGLE_CLIENT_ID"),
          clientSecret: Redacted.value(yield* Config.Redacted("GOOGLE_CLIENT_SECRET")),
        },
      },
    });
  }),
);
