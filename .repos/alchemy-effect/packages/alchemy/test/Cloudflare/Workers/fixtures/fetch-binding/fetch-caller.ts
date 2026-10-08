import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import FetchTargetWorker from "./fetch-target.ts";

/**
 * Effect-native worker that calls {@link FetchTargetWorker} over an HTTP
 * service binding via the `Cloudflare.Workers.Fetch` capability (the
 * HttpClient-shaped sibling of `bindWorker`'s RPC stubs).
 *
 * GET /?name=foo  →  forwards to the target and pipes its body back, prefixed
 * with `caller saw:` so the test can assert the response crossed both hops.
 * Upstream HTTP statuses are preserved. Effect failures return 500 with the cause.
 */
export default class FetchCallerWorker extends Cloudflare.Worker<FetchCallerWorker>()(
  "FetchCallerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const fetchTarget = yield* Cloudflare.Workers.Fetch(FetchTargetWorker);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const name =
          new URL(request.url, "http://x").searchParams.get("name") ?? "world";
        const res = yield* fetchTarget(
          HttpClientRequest.get("https://target/").pipe(
            HttpClientRequest.setUrlParam("name", name),
          ),
        );
        const body = yield* res.text;
        return HttpServerResponse.text(`caller saw: ${body}`, {
          status: res.status,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`caller failed: ${String(cause)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.FetchBinding)),
) {}
