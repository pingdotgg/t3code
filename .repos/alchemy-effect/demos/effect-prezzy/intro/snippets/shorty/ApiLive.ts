import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { dieOnStore } from "./errors.ts";
import LinkRoom from "./LinkRoom.ts";
import { Links, LinksSql } from "./Links.ts";
import { serve } from "./serve.ts";
import { ShortyApi } from "./ShortyApi.ts";
import { NeonStorage } from "./Storage.ts";

// #region show
export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    // #region top
    const links = yield* Links;
    // #endregion top
    // #region rooms
    const rooms = yield* LinkRoom;
    // #endregion rooms
    // #region handlers

    const handlers = HttpApiBuilder.group(ShortyApi, "links", (h) =>
      h
        .handle("create", ({ payload }) => links.create(payload.url).pipe(Effect.orDie))
        .handle("get", ({ params }) => links.get(params.code).pipe(dieOnStore))
        .handle("list", () => links.list().pipe(Effect.orDie)),
    );
    // #endregion handlers
    const api = yield* serve(handlers);

    return {
      // #region fetchTop
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, code, action] = new URL(request.url).pathname.split("/");
        // #endregion fetchTop
        // #region live

        if (action === "live") {
          return yield* rooms.getByName(code!).fetch(request);
        }
        // #endregion live
        // #region click

        if (code && code !== "links") {
          const link = yield* links.get(code).pipe(dieOnStore);
          yield* rooms.getByName(code).record();
          return HttpServerResponse.redirect(link.url, { status: 302 });
        }
        // #endregion click

        // #region fetchEnd
        return yield* api;
        // #endregion fetchEnd
      }).pipe(
        Effect.catchTag("LinkNotFound", () =>
          Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        ),
      ),
    };
  }).pipe(Effect.provide(LinksSql.pipe(Layer.provide(NeonStorage)))),
);
// #endregion show
