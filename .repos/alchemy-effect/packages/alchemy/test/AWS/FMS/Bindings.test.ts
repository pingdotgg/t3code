import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import FMSTestFunctionLive, { FMSTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "FMSBindings");

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

// The testing organization is deliberately NOT onboarded to Firewall Manager
// (see AdminAccount.test.ts — offboarding is blocked for >10 minutes after
// onboarding, so the AdminAccount lifecycle is gated behind AWS_TEST_FMS).
// Each route therefore proves its binding + IAM grant by observing either
// real data (an FMS-onboarded account) or the exact typed
// not-an-FMS-admin rejection captured by live probe. A genuine IAM gap
// surfaces as an uncaught "not authorized to perform" AccessDeniedException
// that 500s the route and fails the test.
describe.sequential("FMS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("FMS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("FMS test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* FMSTestFunction;
        }).pipe(Effect.provide(FMSTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `FMS test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `FMS test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 35 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(35);
      }),
    );
  });

  describe("ListAdminsManagingAccount", () => {
    test.provider(
      "lists the admins managing this account (typed ResourceNotFoundException when none exist)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/admins-managing-account")) as any;
          expect(["Ok", "ResourceNotFoundException"]).toContain(response.tag);
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListAdminAccountsForOrganization", () => {
    test.provider(
      "lists the organization's FMS admins (typed InvalidOperationException when none designated)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/admin-accounts-for-organization",
          )) as any;
          expect([
            "Ok",
            "InvalidOperationException",
            "ResourceNotFoundException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListPolicies", () => {
    test.provider(
      "lists FMS policies (typed AccessDeniedException on a non-admin account)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/policies")) as any;
          expect([
            "Ok",
            "AccessDeniedException",
            "InvalidOperationException",
          ]).toContain(response.tag);
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListResourceSets", () => {
    test.provider(
      "lists resource sets (typed AccessDeniedException on a non-admin account)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/resource-sets")) as any;
          expect([
            "Ok",
            "AccessDeniedException",
            "InvalidOperationException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListMemberAccounts", () => {
    test.provider(
      "lists member accounts (typed AccessDeniedException on a non-admin account)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/member-accounts")) as any;
          expect([
            "Ok",
            "AccessDeniedException",
            "ResourceNotFoundException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetNotificationChannel", () => {
    test.provider(
      "reads the notification channel (typed AccessDeniedException on a non-admin account)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/notification-channel")) as any;
          expect([
            "Ok",
            "AccessDeniedException",
            "InvalidOperationException",
            "ResourceNotFoundException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListAppsLists", () => {
    test.provider(
      "lists applications lists (typed AccessDeniedException on a non-admin account)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/apps-lists")) as any;
          expect([
            "Ok",
            "AccessDeniedException",
            "InvalidOperationException",
            "ResourceNotFoundException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListProtocolsLists", () => {
    test.provider(
      "lists protocols lists (typed AccessDeniedException on a non-admin account)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/protocols-lists")) as any;
          expect([
            "Ok",
            "AccessDeniedException",
            "InvalidOperationException",
            "ResourceNotFoundException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetThirdPartyFirewallAssociationStatus", () => {
    test.provider(
      "reads third-party firewall onboarding status (typed rejection on a non-onboarded account)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/third-party-firewall-status",
          )) as any;
          expect([
            "Ok",
            "AccessDeniedException",
            "InvalidOperationException",
            "InvalidInputException",
            "ResourceNotFoundException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });
});
