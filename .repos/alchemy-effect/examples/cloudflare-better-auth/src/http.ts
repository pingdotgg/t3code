import * as Http from "alchemy/Http";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import { Api } from "./api.ts";
import { CurrentUser } from "./current-user.ts";
import { Authentication } from "./middleware.ts";

export const PublicLive = HttpApiBuilder.group(Api, "public", (handlers) =>
  Effect.gen(function* () {
    const github = yield* Config.Boolean("GITHUB_ENABLED").pipe(Config.withDefault(false));
    return handlers
      .handle("health", () => Effect.succeed({ ok: true as const }))
      .handle("providers", () => Effect.succeed({ github }));
  }),
);

export const PrivateLive = HttpApiBuilder.group(Api, "private", (handlers) =>
  handlers.handle("me", () =>
    Effect.gen(function* () {
      return yield* CurrentUser;
    }),
  ),
);

export const HttpLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([PublicLive, PrivateLive]),
  Layer.provide(Authentication.layer),
  Layer.provide(Http.Platform),
);
