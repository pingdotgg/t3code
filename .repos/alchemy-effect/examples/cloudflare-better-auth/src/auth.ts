import { BetterAuth } from "@alchemy.run/better-auth";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export const makeAuth = Effect.gen(function* () {
  const baseURL = yield* Config.String("AUTH_BASE_URL").pipe(Config.option);
  const githubEnabled = yield* Config.Boolean("GITHUB_ENABLED").pipe(Config.withDefault(false));
  const github = githubEnabled
    ? {
        clientId: yield* Config.String("GITHUB_CLIENT_ID"),
        clientSecret: Redacted.value(yield* Config.Redacted("GITHUB_CLIENT_SECRET")),
      }
    : undefined;

  return yield* BetterAuth({
    basePath: "/api/auth",
    emailAndPassword: { enabled: true },
    baseURL: Option.getOrUndefined(baseURL),
    socialProviders: github ? { github } : {},
  });
});

export class Auth extends Context.Service<Auth, Effect.Success<typeof makeAuth>>()("app/Auth") {
  static readonly layer = Layer.effect(Auth, makeAuth);
}
