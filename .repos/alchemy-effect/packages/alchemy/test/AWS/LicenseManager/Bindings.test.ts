import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/aws/iam";
import * as licensemanager from "@distilled.cloud/aws/license-manager";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LicenseManagerTestFunctionLive, {
  LicenseManagerTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LicenseManagerBindings");
const RUN_CREATE_LIFECYCLE =
  process.env.AWS_TEST_LICENSE_MANAGER_CREATE === "1";

// NOTE: CreateLicenseConfiguration has a small DAILY account quota (~10
// creates/day; deletes do NOT refund it — soft-deleted configurations still
// count). This suite's fixture consumes 1 create per run, so keep the whole
// shared fixture behind the same explicit gate as LicenseConfiguration.test.
// Otherwise a quota rejection in beforeAll cascades into 16 misleading test
// failures. Enable with AWS_TEST_LICENSE_MANAGER_CREATE=1 on a fresh quota
// day to exercise the live binding fixture.

// License Manager requires one-time account onboarding (see
// LicenseConfiguration.test.ts): create the service-linked role
// idempotently, then probe with a bounded typed retry through IAM
// propagation.
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

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const describeCreateLifecycle = describe.skipIf(!RUN_CREATE_LIFECYCLE);

describeCreateLifecycle.sequential("LicenseManager Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      // beforeAll runs outside the provider context — provide the AWS
      // client environment explicitly for the raw distilled calls.
      yield* Core.withProviders(
        ensureOnboarded,
        testOptions,
        "LicenseManagerBindings",
      );

      yield* Effect.logInfo(
        "LicenseManager test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("LicenseManager test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* LicenseManagerTestFunction;
        }).pipe(Effect.provide(LicenseManagerTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `LicenseManager test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `LicenseManager test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 23 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(23);
      }),
    );
  });

  describe("GetLicenseConfiguration", () => {
    test.provider(
      "reads the bound configuration (proving ARN injection + the scoped grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/configuration")) as any;
          expect(response.countingType).toBe("vCPU");
          expect(response.licenseCount).toBe(5);
          expect(response.name).toBeTruthy();
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListAssociationsForLicenseConfiguration", () => {
    test.provider(
      "lists the configuration's associations",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/associations")) as any;
          expect(response.count).toBe(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListUsageForLicenseConfiguration", () => {
    test.provider(
      "lists per-resource usage",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/usage")) as any;
          expect(response.count).toBe(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListFailuresForLicenseConfigurationOperations", () => {
    test.provider(
      "lists failed license operations",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/failures")) as any;
          expect(response.count).toBe(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListLicenses", () => {
    test.provider(
      "lists owned seller licenses",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/licenses")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListReceivedLicenses", () => {
    test.provider(
      "lists received licenses",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/received-licenses")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListReceivedGrants", () => {
    test.provider(
      "lists received grants",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/received-grants")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListDistributedGrants", () => {
    test.provider(
      "lists distributed grants",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/distributed-grants")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListResourceInventory", () => {
    test.provider(
      "lists the resource inventory (or the typed SSM dependency rejection)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/inventory")) as any;
          expect(["Ok", "FailedDependencyException"]).toContain(response.tag);
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetServiceSettings", () => {
    test.provider(
      "reads the account's service settings",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/service-settings")) as any;
          expect(response.tag).toBe("Ok");
          expect(typeof response.hasSnsTopic).toBe("boolean");
        }),
      { timeout: 60_000 },
    );
  });

  describe("CheckoutLicense", () => {
    test.provider(
      "surfaces a typed rejection for a nonexistent product SKU (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/checkout-invalid")) as any;
          expect([
            "ResourceNotFoundException",
            "NoEntitlementsAllowedException",
            "InvalidParameterValueException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetAccessToken", () => {
    test.provider(
      "surfaces a typed rejection for a malformed refresh token (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/access-token-invalid")) as any;
          expect([
            "InvalidParameterValueException",
            "ValidationException",
            "AuthorizationException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetLicense", () => {
    test.provider(
      "surfaces a typed rejection for a nonexistent license ARN (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/license-invalid")) as any;
          expect([
            "ResourceNotFoundException",
            "InvalidParameterValueException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetGrant", () => {
    test.provider(
      "surfaces a typed rejection for a nonexistent grant ARN (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/grant-invalid")) as any;
          expect([
            "ResourceNotFoundException",
            "InvalidParameterValueException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListLicenseSpecificationsForResource", () => {
    test.provider(
      "surfaces an empty list or the typed rejection for a bogus resource ARN",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/specifications-invalid")) as any;
          expect(["Ok", "InvalidParameterValueException"]).toContain(
            response.tag,
          );
        }),
      { timeout: 60_000 },
    );
  });
});
