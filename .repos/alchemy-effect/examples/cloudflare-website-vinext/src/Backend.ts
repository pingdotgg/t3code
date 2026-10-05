import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { BackendApi } from "./BackendApi";
import { BackendHandlers } from "./BackendHandlers";

const platformLayer = Layer.mergeAll(
  Etag.layer,
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  FileSystem.layerNoop({}),
  Path.layer,
);

export default class Backend extends Cloudflare.Worker<Backend>()(
  "Backend",
  {
    main: import.meta.url,
    dev: { port: 1338 },
    compatibility: {
      date: "2026-03-17",
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    return {
      fetch: yield* HttpApiBuilder.layer(BackendApi).pipe(
        Layer.provide(BackendHandlers),
        Layer.provide(platformLayer),
        HttpRouter.toHttpEffect,
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
) {}
