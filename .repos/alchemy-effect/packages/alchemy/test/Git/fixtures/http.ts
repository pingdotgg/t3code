import * as Http from "@/Http/index.ts";
import * as Layer from "effect/Layer";
/** Standard Effect HTTP group registration with an application user handler. */
import { GitApi, GroupsLive, InternalApiLive, Handlers } from "@/Git/index.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestCaller, TestAuthLive } from "./test-auth.ts";

export const GitHubLive = HttpApiBuilder.group(GitApi, "github", (h) =>
  Effect.map(Handlers, (git) =>
    h.handleAll({
      ...git.github,
      user: () =>
        Effect.gen(function* () {
          const caller = yield* Effect.serviceOption(TestCaller);
          const user = Option.isSome(caller) ? caller.value.user : null;
          return user === null
            ? HttpServerResponse.jsonUnsafe(
                { message: "Requires authentication" },
                { status: 401 },
              )
            : HttpServerResponse.jsonUnsafe({
                login: user.name,
                id: 1,
                type: "User",
              });
        }),
    }),
  ),
);

/** The test application's router: public Git routes plus the internal hash route. */
export const TestRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(GitApi).pipe(
    Layer.provide(Layer.mergeAll(GroupsLive, GitHubLive)),
    Layer.provide(TestAuthLive),
  ),
  InternalApiLive,
).pipe(Layer.provide(Http.Platform));
