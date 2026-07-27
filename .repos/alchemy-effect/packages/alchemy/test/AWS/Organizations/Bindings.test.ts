import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import OrganizationsTestFunctionLive, {
  OrganizationsTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "OrganizationsBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

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

// The freshly attached IAM policy can take ~10-30s to propagate to the
// Lambda's role; until it does, granted calls surface a transient
// AccessDeniedException. Poll (bounded) until the response is no longer
// access-denied so grant-proof assertions see steady-state behavior.
const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (response): boolean =>
        (response as { tag?: string }).tag !== "AccessDeniedException",
      times: 10,
    }),
  );

// The testing account is the management account of a standing organization
// (SCPs available), so the tree/policy/delegation reads return live data.
// Every route still tolerates the typed not-in-organization tag so the suite
// stays correct on a detached account.
describe.sequential("Organizations Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Organizations test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Organizations test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* OrganizationsTestFunction;
        }).pipe(Effect.provide(OrganizationsTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Organizations test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Organizations test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 26 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as {
          bound: string[];
        };
        expect(response.bound).toHaveLength(26);
      }),
    );
  });

  describe("DescribeOrganization", () => {
    test.provider("reads the organization", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/organization")) as
          | { ok: true; id: string | null; managementAccountId: string | null }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.id).toMatch(/^o-/);
          expect(response.managementAccountId).toMatch(/^\d{12}$/);
        } else {
          expect(["AWSOrganizationsNotInUseException"]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListRoots", () => {
    test.provider("lists the organization roots", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/roots")) as
          | { ok: true; count: number; rootId: string | null }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(1);
          expect(response.rootId).toMatch(/^r-/);
        } else {
          expect(["AWSOrganizationsNotInUseException"]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListAccounts", () => {
    test.provider("lists the organization accounts", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/accounts")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(1);
        } else {
          expect(["AWSOrganizationsNotInUseException"]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListAccountsForParent", () => {
    test.provider("lists the accounts directly under the root", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/accounts-for-parent")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect(["AWSOrganizationsNotInUseException", "NoRoot"]).toContain(
            response.tag,
          );
        }
      }),
    );
  });

  describe("ListOrganizationalUnitsForParent", () => {
    test.provider("lists the OUs directly under the root", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/ous-for-parent")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect(["AWSOrganizationsNotInUseException", "NoRoot"]).toContain(
            response.tag,
          );
        }
      }),
    );
  });

  describe("ListChildren", () => {
    test.provider("lists the account children of the root", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/children")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect(["AWSOrganizationsNotInUseException", "NoRoot"]).toContain(
            response.tag,
          );
        }
      }),
    );
  });

  describe("ListParents", () => {
    test.provider("finds the management account's parent", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/parents")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(1);
        } else {
          expect([
            "AWSOrganizationsNotInUseException",
            "NoOrganization",
          ]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListPolicies", () => {
    test.provider("lists the service control policies", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/policies")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          // Every organization with SCPs available has p-FullAWSAccess.
          expect(response.count).toBeGreaterThanOrEqual(1);
        } else {
          expect(["AWSOrganizationsNotInUseException"]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListPoliciesForTarget", () => {
    test.provider("lists the SCPs attached to the root", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/policies-for-target")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect(["AWSOrganizationsNotInUseException", "NoRoot"]).toContain(
            response.tag,
          );
        }
      }),
    );
  });

  describe("ListTargetsForPolicy", () => {
    test.provider("lists the targets of a discovered SCP", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/targets-for-policy")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect(["AWSOrganizationsNotInUseException", "NoPolicy"]).toContain(
            response.tag,
          );
        }
      }),
    );
  });

  describe("DescribeEffectivePolicy", () => {
    test.provider(
      "yields the effective tag policy or the typed not-found tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/effective-policy")) as
            | { ok: true; policyType: string | null }
            | { ok: false; tag: string };
          if (response.ok) {
            expect(response.policyType).toBe("TAG_POLICY");
          } else {
            // No tag policies exist in the standing organization — the typed
            // tag proves the grant.
            expect([
              "AWSOrganizationsNotInUseException",
              "ConstraintViolationException",
              "EffectivePolicyNotFoundException",
              "TargetNotFoundException",
            ]).toContain(response.tag);
          }
        }),
    );
  });

  describe("ListAccountsWithInvalidEffectivePolicy", () => {
    test.provider(
      "yields a count or the policy-type-gated typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/invalid-effective-policy-accounts",
          )) as { ok: true; count: number } | { ok: false; tag: string };
          if (response.ok) {
            expect(response.count).toBeGreaterThanOrEqual(0);
          } else {
            expect([
              "AWSOrganizationsNotInUseException",
              "ConstraintViolationException",
              "EffectivePolicyNotFoundException",
              "InvalidInputException",
              "UnsupportedAPIEndpointException",
            ]).toContain(response.tag);
          }
        }),
    );
  });

  describe("ListEffectivePolicyValidationErrors", () => {
    test.provider(
      "yields a count or the policy-type-gated typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/effective-policy-validation-errors",
          )) as { ok: true; count: number } | { ok: false; tag: string };
          if (response.ok) {
            expect(response.count).toBeGreaterThanOrEqual(0);
          } else {
            expect([
              "AWSOrganizationsNotInUseException",
              "AccountNotFoundException",
              "ConstraintViolationException",
              "EffectivePolicyNotFoundException",
              "InvalidInputException",
              "UnsupportedAPIEndpointException",
              "NoOrganization",
            ]).toContain(response.tag);
          }
        }),
    );
  });

  describe("ListDelegatedAdministrators", () => {
    test.provider("lists the delegated administrators", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/delegated-administrators")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect(["AWSOrganizationsNotInUseException"]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListDelegatedServicesForAccount", () => {
    test.provider(
      "surfaces the typed not-registered tag for the management account",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/delegated-services")) as
            | { ok: true; count: number }
            | { ok: false; tag: string };
          if (response.ok) {
            expect(response.count).toBeGreaterThanOrEqual(0);
          } else {
            // The management account is never a delegated administrator —
            // the typed tag proves the grant.
            expect([
              "AWSOrganizationsNotInUseException",
              "AccountNotRegisteredException",
              "NoOrganization",
            ]).toContain(response.tag);
          }
        }),
    );
  });

  describe("ListAWSServiceAccessForOrganization", () => {
    test.provider("lists the trusted-access service principals", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/service-access")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect(["AWSOrganizationsNotInUseException"]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListTagsForResource", () => {
    test.provider("reads the management account's tags", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/tags")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect([
            "AWSOrganizationsNotInUseException",
            "TargetNotFoundException",
            "NoOrganization",
          ]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListCreateAccountStatus", () => {
    test.provider("lists the account-creation requests", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/create-account-statuses")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect([
            "AWSOrganizationsNotInUseException",
            "UnsupportedAPIEndpointException",
          ]).toContain(response.tag);
        }
      }),
    );
  });

  describe("DescribeCreateAccountStatus", () => {
    test.provider(
      "surfaces a typed error for a nonexistent request (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/create-account-status-not-found",
          )) as { tag: string };
          expect([
            "AWSOrganizationsNotInUseException",
            "CreateAccountStatusNotFoundException",
            "InvalidInputException",
            "UnsupportedAPIEndpointException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("ListHandshakesForAccount", () => {
    test.provider("lists the account's handshakes", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/handshakes-account")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect(["ConcurrentModificationException"]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListHandshakesForOrganization", () => {
    test.provider("lists the organization's handshakes", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/handshakes-org")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.count).toBeGreaterThanOrEqual(0);
        } else {
          expect([
            "AWSOrganizationsNotInUseException",
            "ConcurrentModificationException",
          ]).toContain(response.tag);
        }
      }),
    );
  });

  describe("DescribeHandshake", () => {
    test.provider(
      "surfaces a typed error for a nonexistent handshake (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/handshake-not-found")) as {
            tag: string;
          };
          expect([
            "HandshakeNotFoundException",
            "InvalidInputException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("AcceptHandshake", () => {
    test.provider(
      "surfaces a typed error for a nonexistent handshake (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/accept-handshake-not-found")) as {
            tag: string;
          };
          expect([
            "AWSOrganizationsNotInUseException",
            "HandshakeNotFoundException",
            "InvalidInputException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("DeclineHandshake", () => {
    test.provider(
      "surfaces a typed error for a nonexistent handshake (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/decline-handshake-not-found")) as {
            tag: string;
          };
          expect([
            "HandshakeNotFoundException",
            "InvalidInputException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("CancelHandshake", () => {
    test.provider(
      "surfaces a typed error for a nonexistent handshake (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/cancel-handshake-not-found")) as {
            tag: string;
          };
          expect([
            "HandshakeNotFoundException",
            "InvalidInputException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("InviteAccountToOrganization", () => {
    test.provider(
      "surfaces a typed error for an invalid target (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/invite-invalid")) as {
            tag: string;
          };
          expect([
            "AWSOrganizationsNotInUseException",
            "ConstraintViolationException",
            "HandshakeConstraintViolationException",
            "InvalidInputException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("consumeOrganizationsEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's
          // consumeOrganizationsEvents must have materialized as a rule on
          // the default bus with the Lambda as target. (Runtime firing needs
          // a real organization change surfaced through CloudTrail in
          // us-east-1, far slower than the speed doctrine allows.)
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
