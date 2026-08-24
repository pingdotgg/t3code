import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as identitystore from "@distilled.cloud/aws/identitystore";
import * as ssoAdmin from "@distilled.cloud/aws/sso-admin";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import IdentityCenterBindingsFunctionLive, {
  IdentityCenterBindingsFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// The testing account is an organization management account with no enabled
// Identity Center instance, and `CreateInstance` there fails with a typed
// ValidationException ("Organization management account is not allowed to
// perform the operation."), so the Lambda E2E — which binds a live instance —
// is gated behind ALCHEMY_TEST_IDENTITY_CENTER=1 for entitled accounts (same
// gate as the resource lifecycle tests in this suite).
const RUN_LIVE = !!process.env.ALCHEMY_TEST_IDENTITY_CENTER;

// Ungated typed-error probes: prove the distilled error unions the bindings
// depend on are typed on every account, entitled or not, at near-zero cost.
test.provider(
  "describeUser on a nonexistent identity store fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        identitystore.describeUser({
          IdentityStoreId: "d-9067000000",
          UserId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect([
        "ResourceNotFoundException",
        "ValidationException",
        "AccessDeniedException",
      ]).toContain(error._tag);
    }),
);

test.provider(
  "isMemberInGroups on a nonexistent identity store fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        identitystore.isMemberInGroups({
          IdentityStoreId: "d-9067000000",
          MemberId: { UserId: "00000000-0000-0000-0000-000000000000" },
          GroupIds: ["00000000-0000-0000-0000-000000000000"],
        }),
      );
      expect([
        "ResourceNotFoundException",
        "ValidationException",
        "AccessDeniedException",
      ]).toContain(error._tag);
    }),
);

test.provider(
  "listPermissionSets on a nonexistent instance fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        ssoAdmin.listPermissionSets({
          InstanceArn: "arn:aws:sso:::instance/ssoins-0000000000000000",
        }),
      );
      expect([
        "ResourceNotFoundException",
        "ValidationException",
        "AccessDeniedException",
      ]).toContain(error._tag);
    }),
);

const sharedStack = Core.scratchStack(testOptions, "IdentityCenterBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

const getJson = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
const postJson = (path: string) =>
  HttpClient.post(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

describe.sequential("IdentityCenter Bindings (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo(
        "IdentityCenter E2E setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("IdentityCenter E2E setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* IdentityCenterBindingsFunction;
        }).pipe(Effect.provide(IdentityCenterBindingsFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
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

  afterAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* sharedStack.destroy();
    }),
    { timeout: 180_000 },
  );

  describe("binding registration", () => {
    test.provider.skipIf(!RUN_LIVE)(
      "all twenty capabilities initialize in the runtime",
      () =>
        Effect.gen(function* () {
          const response = (yield* getJson("/bindings")) as {
            bound: string[];
          };
          expect(response.bound).toHaveLength(20);
        }),
    );
  });

  describe("group + user lookups", () => {
    test.provider.skipIf(!RUN_LIVE)(
      "listGroups sees the fixture group and getGroupId resolves it",
      () =>
        Effect.gen(function* () {
          const groups = (yield* getJson("/groups")) as {
            displayNames: string[];
          };
          expect(groups.displayNames).toContain("alchemy-idc-bindings-group");

          const groupId = (yield* getJson("/group-id")) as {
            groupId: string;
            matchesBoundGroup: boolean;
          };
          expect(groupId.matchesBoundGroup).toBe(true);
        }),
      { timeout: 120_000 },
    );

    test.provider.skipIf(!RUN_LIVE)(
      "listUsers enumerates the identity store",
      () =>
        Effect.gen(function* () {
          const users = (yield* getJson("/users")) as { userNames: string[] };
          expect(Array.isArray(users.userNames)).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("user lifecycle", () => {
    test.provider.skipIf(!RUN_LIVE)(
      "create/getUserId/describe/update/delete roundtrip",
      () =>
        Effect.gen(function* () {
          const result = (yield* postJson("/user-roundtrip")) as {
            userId: string;
            resolvedMatches: boolean;
            userName: string;
            displayNameBefore: string;
            displayNameAfter: string;
          };
          expect(result.userId).toBeTruthy();
          expect(result.resolvedMatches).toBe(true);
          expect(result.userName).toBe("alchemy-idc-bindings-user");
          expect(result.displayNameAfter).toBe(
            "Alchemy Bindings Test User (updated)",
          );
        }),
      { timeout: 120_000 },
    );
  });

  describe("membership lifecycle", () => {
    test.provider.skipIf(!RUN_LIVE)(
      "create/resolve/describe/list/check/delete roundtrip",
      () =>
        Effect.gen(function* () {
          const result = (yield* postJson("/membership-roundtrip")) as {
            membershipId: string;
            resolvedMatches: boolean;
            describedGroupMatches: boolean;
            memberCount: number;
            memberOfCount: number;
            isMember: boolean;
            isMemberAfterDelete: boolean;
          };
          expect(result.membershipId).toBeTruthy();
          expect(result.resolvedMatches).toBe(true);
          expect(result.describedGroupMatches).toBe(true);
          expect(result.memberCount).toBeGreaterThanOrEqual(1);
          expect(result.memberOfCount).toBeGreaterThanOrEqual(1);
          expect(result.isMember).toBe(true);
          expect(result.isMemberAfterDelete).toBe(false);
        }),
      { timeout: 120_000 },
    );
  });

  describe("permission set + assignment audit", () => {
    test.provider.skipIf(!RUN_LIVE)(
      "listPermissionSets/describePermissionSet see the fixture permission set",
      () =>
        Effect.gen(function* () {
          const result = (yield* getJson("/permission-sets")) as {
            containsFixturePermissionSet: boolean;
            name: string;
            sessionDuration: string;
            provisionedAccounts: string[];
          };
          expect(result.containsFixturePermissionSet).toBe(true);
          expect(result.name).toBe("AlchemyIdcBindings");
          expect(result.sessionDuration).toBe("PT1H");
        }),
      { timeout: 120_000 },
    );

    test.provider.skipIf(!RUN_LIVE)(
      "assignment audit reads answer for the fixture group",
      () =>
        Effect.gen(function* () {
          const result = (yield* getJson("/assignments")) as {
            forPrincipal:
              | { ok: true; count: number }
              | { ok: false; errorTag: string };
          };
          // Organization instances answer with a count; account instances
          // reject ListAccountAssignmentsForPrincipal with a typed tag.
          if (result.forPrincipal.ok) {
            expect(result.forPrincipal.count).toBeGreaterThanOrEqual(0);
          } else {
            expect(result.forPrincipal.errorTag).toBeTruthy();
          }
        }),
      { timeout: 120_000 },
    );
  });
});
