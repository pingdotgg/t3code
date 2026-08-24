import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as acm from "@distilled.cloud/aws/acm";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AcmTestFunctionLive, {
  AcmTestFunction,
  FIXTURE_DOMAIN,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ACMBindings");

// ACM operations (and the bindings) are pinned to us-east-1, matching where
// the Certificate resource provider requests certificates. Every out-of-band
// ACM call in this file must target the same region.
const withUsEast1 = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the shared Lambda fixture (cold re-init, IAM
// propagation on the freshly attached acm policy surfaced as a 500 by the
// handler's `Effect.orDie`). Genuine 4xx/assertion failures return
// immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

// The revoke probe below mutates shared fixture state if it were ever to
// succeed, and list/search are eventually consistent against the fixture
// certificate — run the file sequentially.
describe.sequential("ACM Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("ACM test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("ACM test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AcmTestFunction;
        }).pipe(Effect.provide(AcmTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/describe`;

      yield* Effect.logInfo(
        `ACM test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("DescribeCertificate", () => {
    test.provider("reads the bound certificate's metadata", (_stack) =>
      Effect.gen(function* () {
        const body = (yield* send(
          HttpClientRequest.get(`${baseUrl}/describe`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;

        expect(body.arn).toContain("arn:aws:acm:us-east-1:");
        expect(body.domainName).toBe(FIXTURE_DOMAIN);
        // example.com is not ours — the DNS-validated fixture certificate
        // stays pending forever.
        expect(body.status).toBe("PENDING_VALIDATION");
      }),
    );
  });

  describe("GetCertificate", () => {
    test.provider(
      "fails with the typed RequestInProgressException while pending",
      (_stack) =>
        Effect.gen(function* () {
          const body = (yield* send(
            HttpClientRequest.get(`${baseUrl}/get`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;

          expect(body.errorTag).toBe("RequestInProgressException");
        }),
    );
  });

  describe("ListCertificates", () => {
    test.provider("lists the bound certificate", (_stack) =>
      Effect.gen(function* () {
        const described = (yield* send(
          HttpClientRequest.get(`${baseUrl}/describe`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;

        // ListCertificates is eventually consistent for fresh requests.
        const body = yield* fetchUntil(
          send(HttpClientRequest.get(`${baseUrl}/list`)).pipe(
            Effect.flatMap((r) => r.json),
          ),
          (b) => Array.isArray(b?.arns) && b.arns.includes(described.arn),
        );

        expect((body as any).arns).toContain(described.arn);
      }),
    );
  });

  describe("SearchCertificates", () => {
    test.provider("finds the bound certificate by ARN filter", (_stack) =>
      Effect.gen(function* () {
        const described = (yield* send(
          HttpClientRequest.get(`${baseUrl}/describe`),
        ).pipe(Effect.flatMap((r) => r.json))) as any;

        const body = yield* fetchUntil(
          send(HttpClientRequest.get(`${baseUrl}/search`)).pipe(
            Effect.flatMap((r) => r.json),
          ),
          (b) => Array.isArray(b?.arns) && b.arns.includes(described.arn),
        );

        expect((body as any).arns).toContain(described.arn);
      }),
    );
  });

  describe("ExportCertificate", () => {
    test.provider(
      "fails with a typed error on a non-exportable pending certificate",
      (_stack) =>
        Effect.gen(function* () {
          const body = (yield* send(
            HttpClientRequest.post(`${baseUrl}/export`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;

          // The fixture certificate is pending and was not requested with
          // `export: "ENABLED"` — the export must be rejected with a TYPED
          // tag (an untyped catch-all would crash the handler into a 500).
          expect(typeof body.errorTag).toBe("string");
          expect(body.errorTag.length).toBeGreaterThan(0);
        }),
    );
  });

  describe("RenewCertificate", () => {
    test.provider(
      "fails with a typed error on a pending certificate",
      (_stack) =>
        Effect.gen(function* () {
          const body = (yield* send(
            HttpClientRequest.post(`${baseUrl}/renew`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;

          expect(typeof body.errorTag).toBe("string");
          expect(body.errorTag.length).toBeGreaterThan(0);
        }),
    );
  });

  describe("ResendValidationEmail", () => {
    test.provider(
      "fails with a typed error on a DNS-validated certificate",
      (_stack) =>
        Effect.gen(function* () {
          const body = (yield* send(
            HttpClientRequest.post(`${baseUrl}/resend-email`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;

          // Email validation cannot be (re)sent for a DNS-validated
          // certificate; ACM reports the invalid state with a typed tag.
          expect(typeof body.errorTag).toBe("string");
          expect(body.errorTag.length).toBeGreaterThan(0);
        }),
    );
  });

  describe("RevokeCertificate", () => {
    test.provider(
      "fails with a typed error on a never-exported certificate",
      (_stack) =>
        Effect.gen(function* () {
          const body = (yield* send(
            HttpClientRequest.post(`${baseUrl}/revoke`),
          ).pipe(Effect.flatMap((r) => r.json))) as any;

          // Only previously exported certificates can be revoked — the
          // pending fixture must be rejected with a typed tag.
          expect(typeof body.errorTag).toBe("string");
          expect(body.errorTag.length).toBeGreaterThan(0);
        }),
    );
  });

  describe("ImportCertificate", () => {
    test.provider(
      "imports and rotates an externally issued certificate",
      (_stack) =>
        Effect.gen(function* () {
          const imported = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/import`),
              {},
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as any;

          expect(imported.arn).toContain("arn:aws:acm:us-east-1:");
          expect(imported.arn).toContain(":certificate/");

          // The imported certificate is created outside IaC management —
          // reclaim it even if the assertions below fail.
          yield* Effect.addFinalizer(() =>
            withUsEast1(
              acm.deleteCertificate({ CertificateArn: imported.arn }),
            ).pipe(Effect.ignore),
          );

          // Rotation path: re-importing over the existing ARN keeps the ARN.
          const reimported = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/import`),
              { reimportArn: imported.arn },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as any;

          expect(reimported.arn).toBe(imported.arn);

          // Deleting a freshly imported certificate can hit eventual
          // consistency; retry the typed conflict, tolerate already-gone.
          yield* withUsEast1(
            acm.deleteCertificate({ CertificateArn: imported.arn }).pipe(
              Effect.retry({
                while: (e) => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(10),
                ]),
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            ),
          );
        }),
      { timeout: 120_000 },
    );
  });
});

// A request observed not-yet-consistent control-plane state (ListCertificates
// lags fresh requests by a few seconds). Retry, bounded.
class BindingNotConsistent extends Data.TaggedError("BindingNotConsistent") {}

const fetchUntil = <A>(
  fetch: Effect.Effect<unknown, any, HttpClient.HttpClient>,
  ready: (body: any) => boolean,
) =>
  fetch.pipe(
    Effect.flatMap((body) =>
      ready(body)
        ? Effect.succeed(body as A)
        : Effect.fail(new BindingNotConsistent()),
    ),
    Effect.retry({
      while: (e) => e._tag === "BindingNotConsistent",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
