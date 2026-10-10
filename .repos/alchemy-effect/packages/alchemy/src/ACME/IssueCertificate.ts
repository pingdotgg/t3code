import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Account } from "./Account.ts";
import type {
  IssueError,
  IssueRequest,
  IssuedCertificate,
  RevokeError,
  RevokeRequest,
} from "./Client.ts";

/**
 * Issue (and revoke) certificates at runtime as an {@link Account} — for
 * services that terminate TLS themselves and need certificates on demand,
 * like a relay minting `*.<tenant>.example.com` when a tenant first
 * connects.
 *
 * Init transports the account's directory URL, account URL and redacted
 * private key through resource Outputs. Protect the runtime and state store
 * as secret material. The caller chooses where to store the issued PEMs.
 *
 * ### Issue on demand
 * Publish the DNS-01 record through any runtime DNS write client wrapped
 * as a solver (`Cloudflare.DNS.acmeDnsSolver(dns)`).
 *
 * **Example:** Mint a wildcard from a Fly Service and upload it to its App
 * ```typescript
 * export default class Relay extends Fly.Service<Relay>()(
 *   "Relay",
 *   { app: RelayApp, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const acme = yield* ACME.IssueCertificate(ZeroSsl);
 *     const dns = yield* Cloudflare.DNS.WriteDns(Zone);
 *     const certs = yield* Fly.WriteCertificates(RelayApp);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const issued = yield* acme.issue({
 *           identifiers: ["*.tenant.example.com"],
 *           solver: Cloudflare.DNS.acmeDnsSolver(dns),
 *         });
 *         yield* certs.upload({
 *           hostname: "*.tenant.example.com",
 *           fullchain: issued.chain,
 *           privateKey: issued.privateKey,
 *         });
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(ACME.IssueCertificateHttp),
 *     Effect.provide(Cloudflare.DNS.WriteDnsHttp),
 *     Effect.provide(Fly.WriteCertificatesHttp),
 *   ),
 * ) {}
 * ```
 *
 * ### Rate limits
 * The SDK retry policy applies to individual requests. Apply
 * `Acme.Retry.none` from `@distilled.cloud/acme` to surface failures
 * immediately; `AcmeRateLimited.retryAfter` carries the CA's retry hint.
 *
 * ### Which CA from a Cloudflare Worker
 * CA reachability depends on the host's egress. Let's Encrypt has returned
 * TLS failures from deployed Cloudflare Workers in live testing; the
 * deployed-Worker example uses ZeroSSL instead. Verify the selected CA
 * from the runtime where issuance will run.
 *
 * @binding
 * @product Certificate
 * @category Certificates
 */
export interface IssueCertificate extends Binding.Service<
  IssueCertificate,
  "ACME.IssueCertificate",
  (account: Account) => Effect.Effect<IssueCertificateClient>
> {}

export const IssueCertificate = Binding.Service<IssueCertificate>(
  "ACME.IssueCertificate",
);

/** Runtime issuance client bound to one account. */
export interface IssueCertificateClient {
  /** Order, solve DNS-01, finalize and download a certificate. */
  issue<R = never>(
    request: IssueRequest<R>,
  ): Effect.Effect<IssuedCertificate, IssueError, RuntimeContext | R>;
  /** Revoke a certificate (`AcmeAlreadyRevoked` counts as success). */
  revoke(
    request: RevokeRequest,
  ): Effect.Effect<void, RevokeError, RuntimeContext>;
}
