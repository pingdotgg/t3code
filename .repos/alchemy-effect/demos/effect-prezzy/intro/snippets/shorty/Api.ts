import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import { dieOnStore } from "./errors.ts";
import { Links, LinksSql } from "./Links.ts";
import { serve } from "./serve.ts";
import { ShortyApi } from "./ShortyApi.ts";
import { D1Storage } from "./Storage.ts";

// #region show
export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const links = yield* Links;
    // #region handlers

    const handlers = HttpApiBuilder.group(
      ShortyApi,
      "links",
      (h) =>
        h
          .handle("create", ({ payload }) => links.create(payload.url).pipe(Effect.orDie))
          // #region get
          .handle("get", ({ params }) => links.get(params.code).pipe(dieOnStore))
          // #endregion get
          // #region list
          .handle("list", () => links.list().pipe(Effect.orDie)),
      // #endregion list
    );
    // #endregion handlers
    // #region fetch

    return { fetch: yield* serve(handlers) };
    // #endregion fetch
  }).pipe(Effect.provide(LinksSql.pipe(Layer.provide(D1Storage)))),
);
// #endregion show
