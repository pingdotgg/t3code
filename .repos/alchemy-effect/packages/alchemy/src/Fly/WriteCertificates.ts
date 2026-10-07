import type {
  CertificateCheckResponse,
  CertificateDetail,
  CheckAppCertificateError,
  CreateAppAcmeCertificateError,
  CreateAppCustomCertificateError,
  DeleteAppCertificateError,
  DeleteAppCustomCertificateError,
  GetAppCertificateError,
} from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { App } from "./App.ts";

/**
 * Manage an App's TLS certificates at runtime — the companion to the
 * deploy-time {@link Certificate} resource, for services that mint or
 * rotate certificates on their own (a relay adding a tenant's wildcard,
 * a renewal loop).
 *
 * The App is fixed by `WriteCertificates(app)`; calls take a hostname.
 *
 * ### Fly-managed (Let's Encrypt)
 * **Example:** Request and check
 * ```typescript
 * const certs = yield* Fly.WriteCertificates(Site);
 * const requested = yield* certs.request("www.example.com");
 * // publish requested.dns_requirements, then:
 * const status = yield* certs.check("www.example.com");
 * ```
 *
 * ### Bring your own PEM
 * A certificate issued elsewhere (an `ACME.IssueCertificate` wildcard
 * from ZeroSSL, say) goes up as a custom certificate.
 *
 * **Example:** Upload
 * ```typescript
 * yield* certs.upload({
 *   hostname: "*.tenant.example.com",
 *   fullchain: issued.chain,
 *   privateKey: issued.privateKey,
 * });
 * ```
 *
 * @binding
 * @product Certificate
 */
export interface WriteCertificates extends Binding.Service<
  WriteCertificates,
  "Fly.WriteCertificates",
  (app: App) => Effect.Effect<WriteCertificatesClient>
> {}

export const WriteCertificates = Binding.Service<WriteCertificates>(
  "Fly.WriteCertificates",
);

export interface UploadCertificateRequest {
  readonly hostname: string;
  /** PEM chain, leaf first. */
  readonly fullchain: string;
  /** PEM private key. */
  readonly privateKey: Redacted.Redacted<string> | string;
}

/** Certificate operations on one App. */
export interface WriteCertificatesClient {
  /** Request a Fly-managed (Let's Encrypt) certificate. Idempotent. */
  request(
    hostname: string,
  ): Effect.Effect<
    CertificateDetail | undefined,
    CreateAppAcmeCertificateError,
    RuntimeContext
  >;
  /** Upload a custom PEM. Replaces an existing custom certificate. */
  upload(
    request: UploadCertificateRequest,
  ): Effect.Effect<
    CertificateDetail | undefined,
    CreateAppCustomCertificateError | DeleteAppCustomCertificateError,
    RuntimeContext
  >;
  /** Re-run Fly's validation checks for the hostname. */
  check(
    hostname: string,
  ): Effect.Effect<
    CertificateCheckResponse,
    CheckAppCertificateError,
    RuntimeContext
  >;
  /** The certificate for a hostname, or `undefined`. */
  get(
    hostname: string,
  ): Effect.Effect<
    CertificateDetail | undefined,
    GetAppCertificateError,
    RuntimeContext
  >;
  /** Remove the hostname's certificate. Missing counts as removed. */
  remove(
    hostname: string,
  ): Effect.Effect<void, DeleteAppCertificateError, RuntimeContext>;
}
