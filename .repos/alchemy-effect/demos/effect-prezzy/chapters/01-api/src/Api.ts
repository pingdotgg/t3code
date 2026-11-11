import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { LinkNotFound, newCode, type Link } from "./Link.ts";
import { ShortyApi } from "./ShortyApi.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Lives in one isolate only: gone on the next deploy or cold start.
    const links = new Map<string, Link>();

    const handlers = HttpApiBuilder.group(ShortyApi, "links", (handlers) =>
      handlers
        .handle("create", ({ payload }) =>
          Effect.sync(() => {
            const link = { code: newCode(), url: payload.url, createdAt: new Date().toISOString() };
            links.set(link.code, link);
            return link;
          }),
        )
        .handle("list", () => Effect.sync(() => [...links.values()]))
        .handle("get", ({ params }) => {
          const link = links.get(params.code);
          return link ? Effect.succeed(link) : Effect.fail(new LinkNotFound({ code: params.code }));
        }),
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(ShortyApi).pipe(
          Layer.provide(handlers),
          Layer.provide(Http.Platform),
          Layer.provide(HttpRouter.cors()),
        ),
      ),
    };
  }),
) {}
