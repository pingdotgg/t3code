import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { Auth, AuthLive } from "./Auth.ts";
import { AuthDb } from "./Database.ts";
import { NotesModel } from "./Notes.model.ts";
import { NotesApi } from "./NotesApi.api.ts";
import { SessionLive } from "./Session.ts";

const NotesLive = SessionLive.pipe(
  Layer.provideMerge(AuthLive),
  Layer.provideMerge(NotesModel.layer(Layer.empty)),
  Layer.provide(Layer.mergeAll(DomainCloudflare.layerDurableObjects(), CloudflareD1(AuthDb))),
);

/** Serves better-auth's routes under /api/auth, and the NotesApi under /api. */
export default class NotesWorker extends Cloudflare.Worker<NotesWorker>()(
  "NotesWorker",
  {
    main: import.meta.url,
    compatibility: { flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const auth = yield* Auth;
    const api = yield* NotesApi;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path.startsWith("/api/auth/")) return yield* auth.fetch;
        return yield* api.fetch;
      }),
    };
  }).pipe(Effect.provide(NotesLive)),
) {}
