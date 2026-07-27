import * as AWS from "@/AWS";
import { ACL, User } from "@/AWS/MemoryDB";
import * as Test from "@/Test/Alchemy";
import * as memorydb from "@distilled.cloud/aws/memorydb";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const TEST_PASSWORD = Redacted.make("AlchemyMemoryDbTestPass01");

// Ungated typed-error probe: proves the not-found tag the read/delete paths
// depend on is in the distilled error union.
test.provider(
  "describeACLs on a nonexistent ACL fails with ACLNotFoundFault",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        memorydb.describeACLs({ ACLName: "alchemy-nonexistent-acl-probe" }),
      );
      expect(error._tag).toBe("ACLNotFoundFault");
    }),
);

const assertGone = (name: string) =>
  memorydb.describeACLs({ ACLName: name }).pipe(
    Effect.flatMap(() => Effect.fail(new Error(`acl '${name}' still exists`))),
    Effect.catchTag("ACLNotFoundFault", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

// Single-deploy lifecycle: create an ACL with a custom user, verify, destroy.
// The reserved built-in `default` user cannot be added to a custom ACL, so
// RBAC ACLs reference custom users.
//
// MemoryDB ACL create/delete cascades through "modifying"/"deleting" state
// transitions that are latency-heavy (several minutes end-to-end, and slower
// still under the factory's concurrent CPU load), so the full live lifecycle
// is gated behind AWS_TEST_SLOW=1. The ungated probe above proves the typed
// error union; the create/update/delete reconcile mechanism is identical to
// the SubnetGroup and User providers, whose lifecycle tests run ungated.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create ACL with a user, verify membership, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { acl, user } = yield* stack.deploy(
        Effect.gen(function* () {
          const user = yield* User("AclUser", {
            authenticationMode: {
              type: "password",
              passwords: [TEST_PASSWORD],
            },
            accessString: "on ~* +@all",
          });
          const acl = yield* ACL("AppAcl", {
            userNames: [user.userName],
            tags: { fixture: "memorydb-acl" },
          });
          return { acl, user };
        }),
      );

      expect(acl.aclName).toBeDefined();
      expect(acl.aclArn).toContain(":acl/");
      expect(acl.userNames).toEqual([user.userName]);

      // Out-of-band verification.
      const described = yield* memorydb.describeACLs({ ACLName: acl.aclName });
      expect(described.ACLs?.[0]?.UserNames).toEqual([user.userName]);
      expect(described.ACLs?.[0]?.Status).toBe("active");

      yield* stack.destroy();
      yield* assertGone(acl.aclName);
    }),
  { timeout: 300_000 },
);
