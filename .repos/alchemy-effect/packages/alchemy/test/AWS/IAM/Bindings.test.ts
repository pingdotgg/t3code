import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import IamTestFunctionLive, { IamTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "IamBindings");

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

// The shared Lambda fixture occasionally answers a transient 5xx (cold
// re-init, IAM propagation on the freshly attached policy that the handler's
// `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine 4xx/assertion
// failure surfaces immediately.
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

describe.sequential("IAM Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("IAM test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("IAM test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* IamTestFunction;
        }).pipe(Effect.provide(IamTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `IAM test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `IAM test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 13 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(13);
      }),
    );
  });

  describe("GetAccountSummary", () => {
    test.provider(
      "reads the account entity/quota counters",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/account-summary")) as any;
          expect(response.keys).toBeGreaterThan(0);
          // The fixture user exists, so the account has at least one user.
          expect(response.users).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetAccountAuthorizationDetails", () => {
    test.provider(
      "snapshots the account's users (fixture user included)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/authorization-details")) as any;
          expect(response.users).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GenerateCredentialReport + GetCredentialReport", () => {
    test.provider(
      "generates and downloads the credential report (or reports not-ready, typed)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/credential-report")) as any;
          // First-ever generation in an account can exceed the fixture's
          // bounded poll — the typed not-ready tags are the accepted
          // alternative (an IAM gap would 500 as AccessDeniedException).
          expect([
            "Ok",
            "CredentialReportNotReadyException",
            "CredentialReportNotPresentException",
          ]).toContain(response.tag);
          if (response.tag === "Ok") {
            expect(response.bytes).toBeGreaterThan(0);
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("Access advisor (Generate/Get ServiceLastAccessedDetails + WithEntities)", () => {
    test.provider(
      "runs the access-advisor job for the fixture user and drills into s3",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/service-last-accessed")) as any;
          expect(["COMPLETED", "IN_PROGRESS"]).toContain(response.status);
          if (response.status === "COMPLETED") {
            // The inline policy allows s3, so the job lists >= 1 service.
            expect(response.services).toBeGreaterThanOrEqual(1);
            expect(response.entities).toBeGreaterThanOrEqual(0);
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListPoliciesGrantingServiceAccess", () => {
    test.provider(
      "finds the inline policy granting the fixture user s3 access",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/policies-granting-access")) as any;
          expect(response.policies).toBeGreaterThanOrEqual(1);
        }),
      { timeout: 60_000 },
    );
  });

  describe("SimulateCustomPolicy", () => {
    test.provider(
      "evaluates the custom policy to allowed",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/simulate-custom")) as any;
          expect(response.decision).toBe("allowed");
        }),
      { timeout: 60_000 },
    );
  });

  describe("SimulatePrincipalPolicy", () => {
    test.provider(
      "evaluates the fixture user's inline policy to allowed",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/simulate-principal")) as any;
          expect(response.decision).toBe("allowed");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetContextKeysForCustomPolicy", () => {
    test.provider(
      "extracts aws:username from the custom policy's condition",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/context-keys-custom")) as any;
          expect(response.contextKeys).toContain("aws:username");
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetContextKeysForPrincipalPolicy", () => {
    test.provider(
      "resolves context keys for the fixture user (none expected, typed success)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/context-keys-principal")) as any;
          expect(Array.isArray(response.contextKeys)).toBe(true);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetAccessKeyLastUsed", () => {
    test.provider(
      "echoes the owning user for the bound access key (proving AccessKeyId injection)",
      (_stack) =>
        Effect.gen(function* () {
          // GetAccessKeyLastUsed on a just-created key is eventually
          // consistent: IAM answers 200 with UserName absent until the key
          // propagates (its error union is CommonErrors only — there is no
          // typed NotFound to observe). Poll, bounded, until the owning user
          // is echoed.
          const response = (yield* getJson("/access-key-last-used").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r): boolean => Boolean((r as any).userName),
              times: 10,
            }),
          )) as any;
          expect(response.userName).toBeTruthy();
          expect(response.userName).toBe(response.expectedUserName);
        }),
      { timeout: 60_000 },
    );
  });
});
