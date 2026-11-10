import * as Http from "alchemy/Http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { ShortyApi } from "./ShortyApi.ts";

/** Serve ShortyApi from a Worker's fetch, given the handlers for its endpoints. */
export const serve = <E, R>(
  handlers: Layer.Layer<HttpApiGroup.Service<"ShortyApi", "links">, E, R>,
) =>
  HttpRouter.toHttpEffect(
    HttpApiBuilder.layer(ShortyApi).pipe(
      Layer.provide(handlers),
      Layer.provide(Http.Platform),
      Layer.provide(HttpRouter.cors()),
    ),
  );
