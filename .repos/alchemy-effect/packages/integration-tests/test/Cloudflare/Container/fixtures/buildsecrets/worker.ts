import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { BuildSecretsObject } from "./object.ts";

export const BuildSecretsWorker = Cloudflare.Worker(
  "BuildSecretsWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* BuildSecretsObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        if (url.pathname === "/build") {
          return HttpServerResponse.text(
            yield* objects.getByName("build").build().pipe(Effect.orDie),
          );
        }
        return HttpServerResponse.text("ready");
      }),
    };
  }),
);

export default BuildSecretsWorker;
