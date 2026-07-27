import * as ACM from "@/AWS/ACM";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import {
  IMPORT_CERTIFICATE_PEM,
  IMPORT_PRIVATE_KEY_PEM,
} from "./fixtures/import-cert.ts";

const main = path.resolve(import.meta.dirname, "handler.ts");

// NOT under example.com: ACM deny-lists high-profile domains — a request for
// *.example.com fails within seconds with FAILED /
// ADDITIONAL_VERIFICATION_REQUIRED. An unregistered domain we never validate
// stays PENDING_VALIDATION for the life of the test.
export const FIXTURE_DOMAIN = "alchemy-acm-bindings.alchemy-effect-tests.com";

/**
 * Probe helper: run the bound operation and report either the success
 * projection or the typed error tag, so the test can assert that gated
 * operations fail with a TYPED tag (never an untyped catch-all) on the
 * perpetually-pending fixture certificate.
 */
const tagOr = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  onSuccess: (value: A) => Record<string, unknown>,
) =>
  Effect.result(effect).pipe(
    Effect.map((result) =>
      Result.isSuccess(result)
        ? onSuccess(result.success)
        : { errorTag: result.failure._tag },
    ),
  );

export class AcmTestFunction extends Lambda.Function<Lambda.Function>()(
  "AcmTestFunction",
) {}

export default AcmTestFunction.make(
  {
    main,
    url: true,
    // Above the 3s AWS default: distilled auto-retries retryable typed
    // errors (RequestInProgressException on /get is patched retryable, ~3s
    // of bounded backoff), which must complete within the invocation so the
    // typed tag is returned instead of a function-URL 502 timeout.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // A DNS-validated certificate on a domain we never validate stays
    // PENDING_VALIDATION forever: describe/list/search succeed against it,
    // while issuance-gated operations (get/export/renew) fail with typed
    // errors — both directions prove the binding + IAM wiring.
    const certificate = yield* ACM.Certificate("BindingsCertificate", {
      domainName: FIXTURE_DOMAIN,
      subjectAlternativeNames: [FIXTURE_DOMAIN],
    });

    const describeCertificate = yield* ACM.DescribeCertificate(certificate);
    const getCertificate = yield* ACM.GetCertificate(certificate);
    const exportCertificate = yield* ACM.ExportCertificate(certificate);
    const renewCertificate = yield* ACM.RenewCertificate(certificate);
    const resendValidationEmail = yield* ACM.ResendValidationEmail(certificate);
    const revokeCertificate = yield* ACM.RevokeCertificate(certificate);
    const listCertificates = yield* ACM.ListCertificates();
    const searchCertificates = yield* ACM.SearchCertificates();
    const importCertificate = yield* ACM.ImportCertificate();

    // Expiry event source: ACM emits "ACM Certificate Approaching
    // Expiration" daily per certificate nearing expiry — untriggerable on
    // demand, so the deploy itself (EventBridge rule + invoke permission)
    // is what this fixture verifies.
    yield* ACM.consumeExpiryEvents({}, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `acm expiry event: ${event.detail.CommonName} expires in ${event.detail.DaysToExpiry} days`,
        ),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/describe") {
          const result = yield* describeCertificate();
          return yield* HttpServerResponse.json({
            arn: result.Certificate?.CertificateArn,
            domainName: result.Certificate?.DomainName,
            status: result.Certificate?.Status,
          });
        }

        if (request.method === "GET" && pathname === "/get") {
          return yield* HttpServerResponse.json(
            yield* tagOr(getCertificate(), (result) => ({
              certificate: result.Certificate,
            })),
          );
        }

        if (request.method === "GET" && pathname === "/list") {
          const result = yield* listCertificates({
            CertificateStatuses: ["PENDING_VALIDATION", "ISSUED"],
          });
          return yield* HttpServerResponse.json({
            arns: (result.CertificateSummaryList ?? []).map(
              (summary) => summary.CertificateArn,
            ),
          });
        }

        if (request.method === "GET" && pathname === "/search") {
          const described = yield* describeCertificate();
          const arn = described.Certificate?.CertificateArn;
          if (!arn) {
            return HttpServerResponse.text("certificate has no ARN", {
              status: 500,
            });
          }
          const result = yield* searchCertificates({
            FilterStatement: { Filter: { CertificateArn: arn } },
          });
          return yield* HttpServerResponse.json({
            arns: (result.Results ?? []).map((r) => r.CertificateArn),
          });
        }

        if (request.method === "POST" && pathname === "/export") {
          const passphrase = yield* Effect.sync(() =>
            new TextEncoder().encode("alchemy-acm-test-passphrase"),
          );
          return yield* HttpServerResponse.json(
            yield* tagOr(
              exportCertificate({ Passphrase: Redacted.make(passphrase) }),
              (result) => ({
                certificate: result.Certificate,
                hasPrivateKey: result.PrivateKey !== undefined,
              }),
            ),
          );
        }

        if (request.method === "POST" && pathname === "/renew") {
          return yield* HttpServerResponse.json(
            yield* tagOr(renewCertificate(), () => ({ ok: true })),
          );
        }

        if (request.method === "POST" && pathname === "/resend-email") {
          return yield* HttpServerResponse.json(
            yield* tagOr(
              resendValidationEmail({
                Domain: FIXTURE_DOMAIN,
                // The registered-domain suffix of the fixture domain — the
                // ValidationDomain must be the domain itself or a superdomain.
                ValidationDomain: FIXTURE_DOMAIN.split(".").slice(1).join("."),
              }),
              () => ({ ok: true }),
            ),
          );
        }

        if (request.method === "POST" && pathname === "/revoke") {
          return yield* HttpServerResponse.json(
            yield* tagOr(
              revokeCertificate({ RevocationReason: "UNSPECIFIED" }),
              () => ({ ok: true }),
            ),
          );
        }

        if (request.method === "POST" && pathname === "/import") {
          const body = (yield* request.json) as unknown as {
            reimportArn?: string;
          };
          const payload = yield* Effect.sync(() => {
            const encoder = new TextEncoder();
            return {
              Certificate: encoder.encode(IMPORT_CERTIFICATE_PEM),
              PrivateKey: Redacted.make(encoder.encode(IMPORT_PRIVATE_KEY_PEM)),
            };
          });
          const result = yield* importCertificate({
            CertificateArn: body.reimportArn,
            ...payload,
          });
          return yield* HttpServerResponse.json({
            arn: result.CertificateArn,
          });
        }

        return yield* HttpServerResponse.json(
          {
            error: "Not found",
            method: request.method,
            pathname,
          },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        ACM.DescribeCertificateHttp,
        ACM.GetCertificateHttp,
        ACM.ExportCertificateHttp,
        ACM.RenewCertificateHttp,
        ACM.ResendValidationEmailHttp,
        ACM.RevokeCertificateHttp,
        ACM.ListCertificatesHttp,
        ACM.SearchCertificatesHttp,
        ACM.ImportCertificateHttp,
      ),
    ),
  ),
);
