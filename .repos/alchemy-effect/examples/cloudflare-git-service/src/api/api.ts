import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { Session, Unauthorized } from "./auth.ts";
/** The application owns the API, including Git's groups and its middleware. */
import * as Git from "alchemy/Git";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import { Authentication } from "./middleware.ts";
import { AppRoutes } from "./routes.ts";

export class AppApi extends HttpApi.make("app")
  .addHttpApi(Git.Api)
  .add(AppRoutes)
  .middleware(Authentication) {}

export const MeLive = HttpApiBuilder.group(AppApi, "app", (h) =>
  h.handle("me", () =>
    Effect.gen(function* () {
      const { user } = yield* Session;
      if (user === null) return yield* new Unauthorized();
      return user;
    }),
  ),
);
