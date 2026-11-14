import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { artifactsReadRoutes } from "./read-routes.ts";
import { Repos } from "./shared.ts";

/**
 * Read-only Worker fixture: `Cloudflare.Artifacts.ReadNamespace(Repos)` hands
 * out repos as `ReadRepoClient`, which the routes in `read-routes.ts` drive
 * through metadata, history and Git object reads.
 */
export default class ArtifactsReadWorker extends Cloudflare.Worker<ArtifactsReadWorker>()(
  "ArtifactsReadWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const repos = yield* Repos;
    const client = yield* Cloudflare.Artifacts.ReadNamespace(repos);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled = yield* artifactsReadRoutes(client, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Artifacts.ReadNamespaceBinding)),
) {}
