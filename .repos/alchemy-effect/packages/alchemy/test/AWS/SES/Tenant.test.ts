import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy.ts";
import * as AWS from "@/AWS";
import { Tenant } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class TenantStillExists extends Data.TaggedError("TenantStillExists")<{
  readonly name: string;
}> {}

const getTenant = (name: string) =>
  sesv2.getTenant({ TenantName: name }).pipe(
    Effect.map((response) => response.Tenant),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

const assertTenantDeleted = (name: string) =>
  getTenant(name).pipe(
    Effect.flatMap((found) =>
      found ? Effect.fail(new TenantStillExists({ name })) : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "TenantStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "tenant lifecycle: create, update suppression/tags, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const tenant = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Tenant("CustomerA", {
            suppression: { reasons: ["BOUNCE"], scope: "TENANT" },
            tags: { Environment: "test" },
          });
        }),
      );

      expect(tenant.tenantName).toBeDefined();
      expect(tenant.tenantId).toBeDefined();
      expect(tenant.tenantArn).toContain(":tenant");

      // out-of-band verification via distilled
      const observed = yield* getTenant(tenant.tenantName);
      expect(observed?.SuppressionAttributes?.SuppressedReasons).toEqual([
        "BOUNCE",
      ]);
      const tags = Object.fromEntries(
        (observed?.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("CustomerA");

      // update suppression reasons and add a tag
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Tenant("CustomerA", {
            suppression: { reasons: ["BOUNCE", "COMPLAINT"], scope: "TENANT" },
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      const updated = yield* getTenant(tenant.tenantName);
      expect(
        [...(updated?.SuppressionAttributes?.SuppressedReasons ?? [])].sort(),
      ).toEqual(["BOUNCE", "COMPLAINT"]);
      const updatedTags = Object.fromEntries(
        (updated?.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(updatedTags.Extra).toBe("1");

      yield* stack.destroy();
      yield* assertTenantDeleted(tenant.tenantName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom name replaces on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Tenant("Named", {
            tenantName: "alchemy-test-tenant-a",
          });
        }),
      );
      expect(first.tenantName).toBe("alchemy-test-tenant-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Tenant("Named", {
            tenantName: "alchemy-test-tenant-b",
          });
        }),
      );
      expect(second.tenantName).toBe("alchemy-test-tenant-b");
      yield* assertTenantDeleted("alchemy-test-tenant-a");

      yield* stack.destroy();
      yield* assertTenantDeleted("alchemy-test-tenant-b");
    }),
  { timeout: 120_000 },
);

// Second adoption-gate proof, on a different taggable resource than the
// dedicated IP pool. Tenants are free and create/delete in seconds, and
// unlike ContactList they are not an account singleton, so a foreign tenant
// can coexist with the other tests in this file.
const FOREIGN_TENANT = "alchemy-test-foreign-tenant";

const deleteTenantIfExists = (name: string) =>
  sesv2
    .deleteTenant({ TenantName: name })
    .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

test.provider(
  "a tenant without alchemy tags is not adopted without --adopt",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // Idempotent pre-clean: reclaim a leftover from an interrupted run.
      yield* deleteTenantIfExists(FOREIGN_TENANT);

      // Someone else's tenant: same name, no alchemy tags.
      yield* sesv2.createTenant({ TenantName: FOREIGN_TENANT });

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Tenant("ForeignTenant", {
              tenantName: FOREIGN_TENANT,
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // The refusal touched nothing.
      const untouched = yield* getTenant(FOREIGN_TENANT);
      expect(untouched?.TenantName).toBe(FOREIGN_TENANT);

      // adopt(true) takes it over and brands it, so it converges thereafter.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Tenant("ForeignTenant", {
            tenantName: FOREIGN_TENANT,
          }).pipe(adopt(true));
        }),
      );
      expect(adopted.tenantName).toBe(FOREIGN_TENANT);

      const branded = yield* getTenant(FOREIGN_TENANT);
      const tags = Object.fromEntries(
        (branded?.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags["alchemy::id"]).toBe("ForeignTenant");

      yield* stack.destroy();
      yield* assertTenantDeleted(FOREIGN_TENANT);
    }),
  { timeout: 120_000 },
);
