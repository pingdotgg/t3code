import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Effect-native worker used as the *callee* of the `Fetch` capability
 * fixtures. Echoes the query-string `name` back so the caller can prove the
 * request actually crossed the service binding.
 */
export default class FetchTargetWorker extends Cloudflare.Worker<FetchTargetWorker>()(
  "FetchTargetWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const name =
          new URL(request.url, "http://x").searchParams.get("name") ?? "world";
        return HttpServerResponse.text(`fetch-binding-target: hello ${name}`);
      }),
    };
  }),
) {}
