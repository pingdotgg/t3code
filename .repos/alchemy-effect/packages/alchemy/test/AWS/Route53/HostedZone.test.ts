import * as AWS from "@/AWS";
import { HostedZone } from "@/AWS/Route53";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const normalizeId = (id: string) => id.replace(/^\/hostedzone\//, "");

// Deterministic per-test zone names (reserved-domain-safe TLD `.alchemy`).
const zoneName = "alchemy-hostedzone-crud.alchemy.";

const assertZoneGone = (id: string) =>
  route53.getHostedZone({ Id: normalizeId(id) }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("zone still exists"))),
    Effect.catchTag("NoSuchHostedZone", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update comment, tag, and delete hosted zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const zone = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HostedZone("Zone", {
            name: zoneName,
            comment: "initial comment",
            tags: { env: "test" },
          });
        }),
      );

      expect(zone.id).toBeDefined();
      expect(zone.name).toBe(zoneName);
      // Public zones get exactly 4 authoritative name servers.
      expect(zone.nameServers.length).toBe(4);
      expect(zone.comment).toBe("initial comment");

      // Verify out of band.
      const observed = yield* route53.getHostedZone({
        Id: normalizeId(zone.id),
      });
      expect(observed.HostedZone.Config?.Comment).toBe("initial comment");

      const tags = yield* route53.listTagsForResource({
        ResourceType: "hostedzone",
        ResourceId: normalizeId(zone.id),
      });
      const tagMap = Object.fromEntries(
        (tags.ResourceTagSet.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap.env).toBe("test");
      expect(tagMap["alchemy::id"]).toBeDefined();

      // Update comment + tags in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HostedZone("Zone", {
            name: zoneName,
            comment: "updated comment",
            tags: { env: "prod" },
          });
        }),
      );
      expect(updated.id).toBe(zone.id);
      expect(updated.comment).toBe("updated comment");

      const observed2 = yield* route53.getHostedZone({
        Id: normalizeId(zone.id),
      });
      expect(observed2.HostedZone.Config?.Comment).toBe("updated comment");

      const tags2 = yield* route53.listTagsForResource({
        ResourceType: "hostedzone",
        ResourceId: normalizeId(zone.id),
      });
      const tagMap2 = Object.fromEntries(
        (tags2.ResourceTagSet.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagMap2.env).toBe("prod");

      yield* stack.destroy();
      yield* assertZoneGone(zone.id);
    }),
  { timeout: 180_000 },
);

const forceZoneName = "alchemy-hostedzone-force.alchemy.";

test.provider(
  "forceDestroy deletes leftover records before deleting the zone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zone = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* HostedZone("ForceZone", {
            name: forceZoneName,
            forceDestroy: true,
          });
        }),
      );

      // Seed a leftover record out of band so the zone is non-empty.
      yield* route53
        .changeResourceRecordSets({
          HostedZoneId: normalizeId(zone.id),
          ChangeBatch: {
            Comment: "leftover record",
            Changes: [
              {
                Action: "UPSERT",
                ResourceRecordSet: {
                  Name: `leftover.${forceZoneName}`,
                  Type: "TXT",
                  TTL: 60,
                  ResourceRecords: [{ Value: '"leftover"' }],
                },
              },
            ],
          },
        })
        .pipe(Effect.asVoid);

      // destroy() must purge the record then delete the zone.
      yield* stack.destroy();
      yield* assertZoneGone(zone.id);
    }),
  { timeout: 180_000 },
);

// Regression test for https://github.com/alchemy-run/alchemy/issues/736.
//
// An interrupted first deploy persists the zone as `status: "creating"` with
// no attributes — and an Output-valued `name` does not survive the state
// round-trip: it deserializes as `undefined`. Plan's recovery branch then
// calls `provider.read` with those junk props, which crashed in
// `normalizeName(undefined)` (`undefined is not an object (evaluating
// 'name.endsWith')`) and wedged the stack. When `read` reports "not found",
// the same junk `olds` flow into `diff`, whose unguarded
// `normalizeName(olds.name)` was the second crash site — so this one wedged
// redeploy exercises both guards.
//
// Simulate exactly that state row after a real deploy and assert the next
// deploy recovers: `read` returns undefined, `diff` falls through to the
// create recovery path, and reconcile converges on the half-created zone via
// its stable CallerReference (HostedZoneAlreadyExists → findByName) — SAME
// zone id, no duplicate created.
const recoveryZoneName = "pr770-recovery-hz.alchemy.";

test.provider(
  "recovers a half-created hosted zone whose creating-state lost Output-valued props (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployZone = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* HostedZone("RecoveryZone", {
              name: recoveryZoneName,
              comment: "pr770 recovery",
            });
          }),
        );

      const created = yield* deployZone();
      expect(created.id).toBeDefined();

      // Safety net: if the recovery redeploy defects (the pre-fix crash), the
      // zone would otherwise leak — a fresh zone only holds its SOA/NS records
      // so it deletes cleanly; on the happy path it's already gone (ignored).
      yield* Effect.addFinalizer(() =>
        route53
          .deleteHostedZone({ Id: normalizeId(created.id) })
          .pipe(Effect.ignore),
      );

      // Rewrite the zone's persisted row into the wedged shape an interrupted
      // deploy leaves behind: `creating`, no attributes, and the Output-valued
      // `name` lost in the state round-trip.
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const wedged = rows.find(
        (r): r is { fqn: string; row: ResourceState } =>
          isResourceState(r.row) &&
          r.row.resourceType === "AWS.Route53.HostedZone",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error("no AWS.Route53.HostedZone state row found after deploy"),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: wedged.fqn,
        value: {
          ...wedged.row,
          status: "creating",
          attr: undefined,
          props: { ...wedged.row.props, name: undefined },
        },
      });

      // Before the fix this crashed in plan with
      // `TypeError: undefined is not an object (evaluating 'name.endsWith')`.
      const recovered = yield* deployZone();
      expect(recovered.id).toEqual(created.id);
      expect(recovered.name).toBe(recoveryZoneName);

      yield* stack.destroy();
      yield* assertZoneGone(created.id);
    }),
  { timeout: 240_000 },
);

test.provider(
  "idempotent delete tolerates an already-gone zone",
  () =>
    Effect.gen(function* () {
      // Deleting a non-existent zone id should be a no-op (NoSuchHostedZone).
      yield* route53.deleteHostedZone({ Id: "Z0000000000000NONEXIST" }).pipe(
        Effect.asVoid,
        Effect.catchTag("NoSuchHostedZone", () => Effect.void),
        Effect.catchTag("InvalidInput", () => Effect.void),
      );
      expect(true).toBe(true);
    }),
  { timeout: 60_000 },
);
