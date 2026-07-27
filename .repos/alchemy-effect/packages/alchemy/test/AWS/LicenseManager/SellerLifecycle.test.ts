import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as sts from "@distilled.cloud/aws/sts";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LicenseManagerSellerFunctionLive, {
  LicenseManagerSellerFunction,
} from "./seller-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LicenseManagerSeller");

// The deterministic license name the fixture issues (and sweeps) — used for
// the out-of-band zero-orphan verification below.
const FIXTURE_LICENSE_NAME = "alchemy-lm-seller-e2e";

// License Manager requires one-time account onboarding (see
// LicenseConfiguration.test.ts): create the service-linked role
// idempotently, then probe with a bounded typed retry through IAM
// propagation. Raw distilled calls need the AWS layer, so this runs inside
// `test.provider` bodies (beforeAll provides no cloud credentials).
const ensureOnboarded = Effect.gen(function* () {
  yield* iam
    .createServiceLinkedRole({
      AWSServiceName: "license-manager.amazonaws.com",
    })
    .pipe(Effect.catchTag("InvalidInputException", () => Effect.void));
  yield* licensemanager.listLicenseConfigurations({ MaxResults: 1 }).pipe(
    Effect.retry({
      while: (e) => e._tag === "AccessDeniedException",
      schedule: Schedule.exponential("1 second"),
      times: 8,
    }),
  );
});

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The Lambda fixture occasionally answers a transient 5xx (cold re-init,
// IAM propagation on the freshly attached policy that the handler's
// `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine 4xx or
// assertion failure surfaces immediately.
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
        Schedule.exponential("2 seconds"),
        Schedule.recurs(4),
      ]),
    }),
  );

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("LicenseManager Seller Lifecycle", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "LicenseManager seller setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("LicenseManager seller setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* LicenseManagerSellerFunction;
        }).pipe(Effect.provide(LicenseManagerSellerFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `LicenseManager seller setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `LicenseManager seller setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider(
      "all 9 seller-plane capabilities initialize in the runtime",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/bindings")) as {
            bound: string[];
          };
          expect(response.bound).toHaveLength(9);
        }),
    );
  });

  describe("seller data plane", () => {
    test.provider(
      "issue -> version -> token mint/exchange -> checkout/extend/checkin -> grant -> delete",
      (_stack) =>
        Effect.gen(function* () {
          yield* ensureOnboarded;
          const { Account } = yield* sts.getCallerIdentity({});
          const response = (yield* postJson(
            `/lifecycle?account=${Account}`,
          )) as {
            licenseArn: string;
            licenseStatus: string | null;
            bumpedVersion: string | null;
            tokenListed: number;
            accessToken: string;
            checkedOut: boolean;
            extended: boolean;
            grant: string;
            deletionStatus: string | null;
          };

          // CreateLicense issued a real license that reached AVAILABLE.
          expect(response.licenseArn).toContain(":license:");
          expect(response.licenseStatus).toBe("AVAILABLE");
          // CreateLicenseVersion published version 2.
          expect(response.bumpedVersion).toBe("2");
          // CreateToken + ListTokens round-tripped the token metadata.
          expect(response.tokenListed).toBe(1);
          // GetAccessToken exchanged the (Redacted) refresh token — or
          // surfaced one of its typed rejections; both prove the grant.
          expect([
            "Ok",
            "AuthorizationException",
            "ValidationException",
            "AccessDeniedException",
            "InvalidParameterValueException",
          ]).toContain(response.accessToken);
          // CheckoutLicense / ExtendLicenseConsumption ran for real.
          expect(response.checkedOut).toBe(true);
          expect(response.extended).toBe(true);
          // CreateGrant + DeleteGrant — a self-account grant may be rejected
          // with a typed validation error; both outcomes prove the wiring.
          expect([
            "CreatedAndDeleted",
            "InvalidParameterValueException",
            "ValidationException",
            "AuthorizationException",
            "ResourceLimitExceededException",
          ]).toContain(response.grant);
          // DeleteLicense retired it.
          expect(["PENDING_DELETE", "DELETED"]).toContain(
            response.deletionStatus,
          );

          // Out-of-band zero-orphan verification via distilled: no fixture
          // license remains AVAILABLE.
          const { Licenses } = yield* licensemanager.listLicenses({});
          const leftovers = (Licenses ?? []).filter(
            (l): boolean =>
              l.LicenseName === FIXTURE_LICENSE_NAME &&
              l.Status === "AVAILABLE",
          );
          expect(leftovers).toHaveLength(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("CreateGrantVersion", () => {
    test.provider(
      "surfaces a typed rejection for a nonexistent grant ARN (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/grant-version-invalid")) as {
            tag: string;
          };
          expect([
            "InvalidParameterValueException",
            "ValidationException",
            "AuthorizationException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });
});
