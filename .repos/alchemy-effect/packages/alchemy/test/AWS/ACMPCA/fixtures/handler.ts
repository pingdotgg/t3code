import * as ACMPCA from "@/AWS/ACMPCA";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import crypto from "node:crypto";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Deterministic bucket for audit reports (S3 names are global, but the
 * testing account is fixed). The bucket policy must grant Amazon Web
 * Services Private CA write access for CreateCertificateAuthorityAuditReport
 * to succeed.
 */
export const AUDIT_BUCKET_NAME = "alchemy-test-acmpca-audit-reports";

/**
 * A static leaf CSR (checked in — fixtures are never generated at test
 * time). The private key was discarded; the tests only need a valid CSR
 * for the CA to sign.
 */
export const LEAF_CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIICgTCCAWkCAQAwPDEjMCEGA1UEAwwabGVhZi5hbGNoZW15LXRlc3QuaW50ZXJu
YWwxFTATBgNVBAoMDEFsY2hlbXkgVGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALGadvvgETlb8XMOiqRBUz/L+C3Ilc2d43TRYROvMXKnbzewzyA2
EyBhXYUvWvewXH6chrC8GqcgbHGLs4GyHfLE3qO6TAF8mBzdvZo8J0aKGBMZLASA
yq/JwwSawzGuQp818h/Qs85nxqEk8oxOQPMK3e6N7z81JC/nWEV/c9bQa5HGPiGF
0sMbNik5wPaMxxmt6Njx3P9DwbJWjcDaoslpY44iQrtWON3kiGVIFSE7jPX5B/Na
i3RZJofI/UhMZkS5sHrAboNuZ8p03AS7O+zCkLTvvD948N4FPIWUP0khZocaR+k1
xWgv/lFU0OBy3+SGifqb9QwcM5aD8ExN1UsCAwEAAaAAMA0GCSqGSIb3DQEBCwUA
A4IBAQAIk42ecyyxlCHTA6xarCx74SgptR3VyCvgFj4qErEJA/ST3l26Emx5uuAC
59hfZq42szQ/6VZwJTq71ThwUFPP+x3LpXRJnuHAOP2ORZ0x4LJwHlPiEZR2GFnZ
CWuYpynAYgAKUh0ubeFzyp/odXwemlbaFc52JuxA9gUPVuThsiFqIWH780cfA9NM
VIhBWsnInHBw0ffVQDbxcIRqP9qxwOIH9SHGKPXz1F5CfvSII9Z5QqeMuZwdXu7k
Sy1wRo1UPY6ot0Kstqs8TJVA6R220wEk5iUEg/d3Ft1W0T17I60Gx5P6LgxjTJbp
WDtemfBJScvPotEJ+xTh9kn81whi
-----END CERTIFICATE REQUEST-----`;

export class ACMPCATestFunction extends Lambda.Function<Lambda.Function>()(
  "ACMPCATestFunction",
) {}

export default ACMPCATestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const ca = yield* ACMPCA.CertificateAuthority("BindingsCA", {
      subject: { commonName: "bindings.alchemy-test.internal" },
      usageMode: "SHORT_LIVED_CERTIFICATE",
      permanentDeletionTime: "7 days",
      tags: { fixture: "acmpca-bindings" },
    });

    yield* S3.Bucket("AuditReports", {
      bucketName: AUDIT_BUCKET_NAME,
      forceDestroy: true,
      policy: [
        {
          Effect: "Allow",
          Principal: { Service: "acm-pca.amazonaws.com" },
          Action: ["s3:PutObject", "s3:GetBucketAcl", "s3:GetBucketLocation"],
          Resource: [
            `arn:aws:s3:::${AUDIT_BUCKET_NAME}`,
            `arn:aws:s3:::${AUDIT_BUCKET_NAME}/*`,
          ],
        },
      ],
    });

    const CaArn = yield* ca.certificateAuthorityArn;

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.acm-pca) targeting this Function. Runtime firing rides on the
    // certificates the suite issues/revokes; the test verifies the rule
    // deploys.
    yield* ACMPCA.consumeCertificateAuthorityEvents(
      { kinds: ["issuance", "revocation"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `acm-pca event: ${event["detail-type"]} -> ${event.resources.join(",")}`,
          ),
        ),
    );
    const getCsr = yield* ACMPCA.GetCertificateAuthorityCsr(ca);
    const getCaCertificate =
      yield* ACMPCA.GetCertificateAuthorityCertificate(ca);
    const issueCertificate = yield* ACMPCA.IssueCertificate(ca);
    const getCertificate = yield* ACMPCA.GetCertificate(ca);
    const importCaCertificate =
      yield* ACMPCA.ImportCertificateAuthorityCertificate(ca);
    const revokeCertificate = yield* ACMPCA.RevokeCertificate(ca);
    const createAuditReport =
      yield* ACMPCA.CreateCertificateAuthorityAuditReport(ca);
    const describeAuditReport =
      yield* ACMPCA.DescribeCertificateAuthorityAuditReport(ca);

    // ACM PCA activation is eventually consistent: for a few seconds after
    // ImportCertificateAuthorityCertificate flips the CA to ACTIVE, other
    // API nodes still answer with a typed InvalidStateException. Retry that
    // tag on a bounded schedule (~30s worst case).
    const retryInvalidState = <A, E extends { readonly _tag: string }, R>(
      self: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.retry(self, {
        while: (e): boolean => e._tag === "InvalidStateException",
        schedule: Schedule.max([
          Schedule.fixed("3 seconds"),
          Schedule.recurs(10),
        ]),
      });

    // Issuance is asynchronous — poll GetCertificate while the typed
    // in-progress tag (or a stale post-activation state read) is observed
    // (bounded, ~30s worst case).
    const waitForCertificate = (CertificateArn: string) =>
      getCertificate({ CertificateArn }).pipe(
        Effect.retry({
          while: (e): boolean =>
            e._tag === "RequestInProgressException" ||
            e._tag === "InvalidStateException",
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(10),
          ]),
        }),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/csr") {
          const { Csr } = yield* getCsr();
          return yield* HttpServerResponse.json({
            csr: Csr,
            caArn: yield* CaArn,
          });
        }

        if (request.method === "GET" && pathname === "/ca-certificate") {
          const result = yield* retryInvalidState(getCaCertificate());
          return yield* HttpServerResponse.json({
            certificate: result.Certificate,
            certificateChain: result.CertificateChain,
          });
        }

        // Full activation flow: fetch the CA's CSR, self-sign it with the
        // root template, then install the signed certificate. Exercises
        // GetCertificateAuthorityCsr + IssueCertificate + GetCertificate +
        // ImportCertificateAuthorityCertificate in one route.
        if (request.method === "POST" && pathname === "/activate") {
          const { Csr } = yield* getCsr();
          const issued = yield* retryInvalidState(
            issueCertificate({
              Csr: yield* Effect.sync(() => new TextEncoder().encode(Csr!)),
              SigningAlgorithm: "SHA256WITHRSA",
              TemplateArn: "arn:aws:acm-pca:::template/RootCACertificate/V1",
              Validity: { Type: "YEARS", Value: 10 },
            }),
          );
          const certificate = yield* waitForCertificate(issued.CertificateArn!);
          yield* retryInvalidState(
            importCaCertificate({
              Certificate: yield* Effect.sync(() =>
                new TextEncoder().encode(certificate.Certificate!),
              ),
            }),
          );
          return yield* HttpServerResponse.json({
            certificateArn: issued.CertificateArn,
          });
        }

        // Issue a short-lived end-entity certificate from the checked-in
        // leaf CSR and return its PEM.
        if (request.method === "POST" && pathname === "/issue") {
          const issued = yield* retryInvalidState(
            issueCertificate({
              Csr: yield* Effect.sync(() => new TextEncoder().encode(LEAF_CSR)),
              SigningAlgorithm: "SHA256WITHRSA",
              Validity: { Type: "DAYS", Value: 5 },
            }),
          );
          const certificate = yield* waitForCertificate(issued.CertificateArn!);
          return yield* HttpServerResponse.json({
            certificateArn: issued.CertificateArn,
            certificate: certificate.Certificate,
          });
        }

        if (request.method === "POST" && pathname === "/revoke") {
          const body = (yield* request.json) as unknown as {
            certificateArn: string;
          };
          const certificate = yield* waitForCertificate(body.certificateArn);
          const serial = yield* Effect.sync(
            () =>
              new crypto.X509Certificate(certificate.Certificate!).serialNumber,
          );
          yield* retryInvalidState(
            revokeCertificate({
              CertificateSerial: serial,
              RevocationReason: "CESSATION_OF_OPERATION",
            }),
          );
          return yield* HttpServerResponse.json({ revoked: true, serial });
        }

        // Generate an audit report into the fixture bucket and poll it out
        // of the CREATING state (reports land asynchronously in S3).
        if (request.method === "POST" && pathname === "/audit") {
          const report = yield* retryInvalidState(
            createAuditReport({
              S3BucketName: AUDIT_BUCKET_NAME,
              AuditReportResponseFormat: "JSON",
            }),
          );
          const status = yield* describeAuditReport({
            AuditReportId: report.AuditReportId!,
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (r): boolean => r.AuditReportStatus !== "CREATING",
              times: 10,
            }),
          );
          return yield* HttpServerResponse.json({
            auditReportId: report.AuditReportId,
            s3Key: report.S3Key,
            status: status.AuditReportStatus,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface the failure to the test instead of a generic Lambda 500 —
        // the suite's `send` helper includes non-200 bodies in its error.
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        ACMPCA.GetCertificateAuthorityCsrHttp,
        ACMPCA.GetCertificateAuthorityCertificateHttp,
        ACMPCA.IssueCertificateHttp,
        ACMPCA.GetCertificateHttp,
        ACMPCA.ImportCertificateAuthorityCertificateHttp,
        ACMPCA.RevokeCertificateHttp,
        ACMPCA.CreateCertificateAuthorityAuditReportHttp,
        ACMPCA.DescribeCertificateAuthorityAuditReportHttp,
      ),
    ),
  ),
);
