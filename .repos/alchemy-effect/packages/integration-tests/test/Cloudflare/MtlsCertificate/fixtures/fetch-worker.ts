import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { LEAF_CERT, LEAF_KEY } from "./certs.ts";

/** The leaf certificate the Worker presents on its subrequests. */
export const FetchCert = Cloudflare.MtlsCertificate.MtlsCertificate("FetchCert", {
  ca: false,
  certificates: LEAF_CERT,
  privateKey: Redacted.make(LEAF_KEY),
});

/**
 * Effect Worker that binds {@link FetchCert} through
 * `Cloudflare.MtlsCertificate.Fetch` and sends a request with it, so a 200
 * proves the binding was attached and the Effect client sends through it.
 */
export default class MtlsFetchWorker extends Cloudflare.Worker<MtlsFetchWorker>()(
  "MtlsFetchWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const fetchWithCert = yield* Cloudflare.MtlsCertificate.Fetch(yield* FetchCert);
    return {
      fetch: Effect.gen(function* () {
        const response = yield* fetchWithCert(HttpClientRequest.get("https://example.com/"));
        return HttpServerResponse.text(`origin-status:${response.status}`);
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(HttpServerResponse.text(String(error), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.MtlsCertificate.FetchBinding)),
) {}
