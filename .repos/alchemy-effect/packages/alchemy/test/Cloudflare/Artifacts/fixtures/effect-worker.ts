import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Repos } from "./shared.ts";
import { artifactsRoutes } from "./routes.ts";

/**
 * Effect-native Worker fixture for the Artifacts namespace binding. Yielding
 * `Cloudflare.Artifacts.ReadWriteNamespace(Repos)` during Init registers the native
 * `{ type: "artifacts" }` binding and returns the Effect-native
 * {@link ReadWriteNamespaceClient}. Routes are shared with the async worker via
 * `routes.ts`.
 */
export default class ArtifactsEffectWorker extends Cloudflare.Worker<ArtifactsEffectWorker>()(
  "ArtifactsEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const repos = yield* Repos;
    const client = yield* Cloudflare.Artifacts.ReadWriteNamespace(repos);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled = yield* artifactsRoutes(client, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Artifacts.ReadWriteNamespaceBinding)),
) {}
