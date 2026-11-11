import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { MtlsCertificate } from "./MtlsCertificate.ts";

/**
 * Send requests from an Effect Worker that present a leaf
 * {@link MtlsCertificate} to the origin.
 *
 * `Fetch` is a single identifier that is the binding's Context tag, its type,
 * and the callable: `yield* Cloudflare.MtlsCertificate.Fetch(cert)` binds the
 * certificate to the Worker as an `mtls_certificate` binding and returns a
 * function from `HttpClientRequest` to `HttpClientResponse`. Every request it
 * sends goes out over TLS presenting the certificate, so origins that require
 * client authentication (mTLS) accept it.
 *
 * Bind a leaf certificate uploaded with its private key (`ca: false`). Provide
 * {@link FetchBinding} on the Worker's Effect to resolve the native binding at
 * request time. Async Workers get the same binding by passing the certificate
 * in `env` instead, where it is typed as a `Fetcher`.
 *
 * ### Calling an mTLS origin
 * **Example:** Present a client certificate from an Effect Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as HttpClientRequest from "effect/http/HttpClientRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const OriginCert = Effect.gen(function* () {
 *   return yield* Cloudflare.MtlsCertificate.MtlsCertificate("OriginCert", {
 *     ca: false,
 *     certificates: leafPem,
 *     privateKey: yield* Config.Redacted("ORIGIN_CLIENT_KEY"),
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const fetchOrigin = yield* Cloudflare.MtlsCertificate.Fetch(yield* OriginCert);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const response = yield* fetchOrigin(
 *           HttpClientRequest.get("https://origin.example.com/orders"),
 *         );
 *         return HttpServerResponse.text(yield* response.text);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.MtlsCertificate.FetchBinding)),
 * ) {}
 * ```
 *
 * ### Requests with bodies
 * **Example:** POST JSON to the origin
 * ```typescript
 * const response = yield* fetchOrigin(
 *   HttpClientRequest.post("https://origin.example.com/orders").pipe(
 *     HttpClientRequest.bodyJsonUnsafe({ sku: "abc", quantity: 1 }),
 *   ),
 * );
 * ```
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/
 *
 * @binding
 * @product mTLS Certificates
 * @category SSL/TLS & Certificates
 */
export interface Fetch extends Binding.Service<
  Fetch,
  "Cloudflare.MtlsCertificate.Fetch",
  (
    certificate: MtlsCertificate,
  ) => Effect.Effect<
    (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      HttpClientError.RequestError,
      RuntimeContext
    >
  >
> {}

export const Fetch = Binding.Service<Fetch>("Cloudflare.MtlsCertificate.Fetch");
