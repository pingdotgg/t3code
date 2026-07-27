import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as acmpca from "@distilled.cloud/aws/acm-pca";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ACMPCATestFunctionLive, { ACMPCATestFunction } from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ACMPCABindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take
// well over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let caArn: string;
let caCsr: string;
let caCertificateArn: string;

const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new Error(`Fixture answered ${response.status}: ${body}`),
              ),
            ),
          ),
    ),
  );

// A private CA bills a monthly fee (prorated) for as long as it exists, and
// this suite ACTIVATES its CA (self-signed root, short-lived certificate
// mode — the cheaper tier), so the whole suite is gated behind
// AWS_TEST_ACMPCA=1.
//
// vitest runs the tests of a file CONCURRENTLY (sequence.concurrent), so all
// state-ordered steps live in `beforeAll`: the CSR is captured while the CA
// is still PENDING_CERTIFICATE (GetCertificateAuthorityCsr only answers in
// that state), then the CA is activated. Every test below is
// order-independent against the ACTIVE CA; the issue→revoke chain runs
// inside a single test.
describe.skipIf(!process.env.AWS_TEST_ACMPCA)("ACMPCA Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ACMPCATestFunction;
        }).pipe(Effect.provide(ACMPCATestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // /csr works while the CA is still PENDING_CERTIFICATE, so it doubles
      // as the readiness probe. It also reports the CA's ARN for the
      // out-of-band assertions below.
      const ready = yield* HttpClient.get(`${baseUrl}/csr`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      caArn = (ready as { caArn: string }).caArn;
      caCsr = (ready as { csr: string }).csr;
      expect(caArn).toContain(":certificate-authority/");

      // Activate the CA: self-sign its CSR with the root template and
      // install the result (GetCertificateAuthorityCsr + IssueCertificate +
      // GetCertificate + ImportCertificateAuthorityCertificate).
      const activated = (yield* send(
        HttpClientRequest.post(`${baseUrl}/activate`),
      ).pipe(
        Effect.retry({
          schedule: Schedule.spaced("3 seconds"),
          times: 3,
        }),
      )) as { certificateArn: string };
      caCertificateArn = activated.certificateArn;
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("GetCertificateAuthorityCsr", () => {
    test.provider(
      "returned the CA's PEM CSR while it was pending",
      () =>
        Effect.gen(function* () {
          expect(caCsr).toContain("BEGIN CERTIFICATE REQUEST");
        }),
      { timeout: 60_000 },
    );
  });

  describe("IssueCertificate + GetCertificate + ImportCertificateAuthorityCertificate", () => {
    test.provider(
      "activated the CA by self-signing its CSR with the root template",
      () =>
        Effect.gen(function* () {
          expect(caCertificateArn).toContain(caArn);

          // Out-of-band verification via distilled: the CA is now ACTIVE.
          const described = yield* acmpca.describeCertificateAuthority({
            CertificateAuthorityArn: caArn,
          });
          expect(described.CertificateAuthority?.Status).toBe("ACTIVE");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetCertificateAuthorityCertificate", () => {
    test.provider(
      "returns the installed CA certificate",
      () =>
        Effect.gen(function* () {
          const body = (yield* send(
            HttpClientRequest.get(`${baseUrl}/ca-certificate`),
          )) as { certificate: string };
          expect(body.certificate).toContain("BEGIN CERTIFICATE");
        }),
      { timeout: 60_000 },
    );
  });

  describe("IssueCertificate + RevokeCertificate", () => {
    test.provider(
      "issues a short-lived end-entity certificate, then revokes it by serial",
      () =>
        Effect.gen(function* () {
          const issued = (yield* send(
            HttpClientRequest.post(`${baseUrl}/issue`),
          )) as { certificateArn: string; certificate: string };
          expect(issued.certificateArn).toContain("/certificate/");
          expect(issued.certificate).toContain("BEGIN CERTIFICATE");

          const revoked = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/revoke`),
              { certificateArn: issued.certificateArn },
            ),
          )) as { revoked: boolean; serial: string };
          expect(revoked.revoked).toBe(true);
          expect(revoked.serial).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("CreateCertificateAuthorityAuditReport + DescribeCertificateAuthorityAuditReport", () => {
    test.provider(
      "generates an audit report into S3 and polls it",
      () =>
        Effect.gen(function* () {
          const body = (yield* send(
            HttpClientRequest.post(`${baseUrl}/audit`),
          )) as { auditReportId: string; s3Key: string; status: string };
          expect(body.auditReportId).toBeTruthy();
          expect(body.status).toBe("SUCCESS");
        }),
      { timeout: 120_000 },
    );
  });
});
