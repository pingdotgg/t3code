import * as AWS from "@/AWS";
import { Record } from "@/AWS/Route53";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic zone name so a crashed run's leftover zone is reclaimed by
// the next run's lookup-first `resolveZone` (and then deleted by `teardownZone`).
// (`example.com` is reserved by AWS, hence the bespoke name.)
const zoneName = "alchemy-route53-list-test.com.";
const callerReference = "alchemy-route53-record-list-test-v2";
const recordName = `list-record.${zoneName}`;
const recordValue = '"alchemy-list-test"';

const normalizeId = (id: string) => id.replace(/^\/hostedzone\//, "");

const listZoneIdsByName = route53.listHostedZones.pages({}).pipe(
  Stream.runCollect,
  Effect.map((chunk) =>
    Array.from(chunk).flatMap((page) => page.HostedZones ?? []),
  ),
  Effect.map((zones) =>
    zones
      .filter((zone) => zone.Name === zoneName)
      .flatMap((zone) => (zone.Id !== undefined ? [zone.Id] : [])),
  ),
);

const findZoneIdByName = listZoneIdsByName.pipe(Effect.map((ids) => ids[0]));

// The hosted zone is a *suite-scoped* fixture — resolved once (lookup-first,
// create on a genuine miss) and shared by both tests in this file, then
// deleted by the `teardownZone` finalizer below so a passing run leaves the
// account clean. A short retry absorbs the brief list eventual-consistency
// right after a first-time create, when a create can race ahead of the zone
// appearing in `listHostedZones`.
const zoneNotYetListable =
  "hosted zone not found after HostedZoneAlreadyExists";

// List first, create only on a genuine miss. The previous create-first design
// got permanently poisoned whenever the zone was deleted (as the `teardownZone`
// teardown now does every run): a stable `CallerReference` stays claimed
// during a long propagation window, so `createHostedZone` keeps returning
// `HostedZoneAlreadyExists` while `listHostedZones` still shows nothing.
// Looking the zone up first (and only creating with a *fresh* CallerReference
// when it's truly absent) sidesteps that trap — an absent/poisoned zone
// always re-creates cleanly, and a present zone is reused without ever
// hitting the conflict path.
const resolveZone = findZoneIdByName.pipe(
  Effect.flatMap((existing) =>
    existing !== undefined
      ? Effect.succeed(normalizeId(existing))
      : route53
          .createHostedZone({
            Name: zoneName,
            CallerReference: `${callerReference}-${crypto.randomUUID()}`,
          })
          .pipe(
            Effect.map((response) => normalizeId(response.HostedZone.Id)),
            // A concurrent attempt won the race — fall back to the lookup.
            Effect.catchTag("HostedZoneAlreadyExists", () =>
              findZoneIdByName.pipe(
                Effect.flatMap((id) =>
                  id !== undefined
                    ? Effect.succeed(normalizeId(id))
                    : Effect.fail(new Error(zoneNotYetListable)),
                ),
              ),
            ),
          ),
  ),
  Effect.retry({
    while: (e) => e instanceof Error && e.message === zoneNotYetListable,
    schedule: Schedule.spaced("5 seconds"),
    times: 24,
  }),
);

// Cache the resolved id at module scope: both tests in this file run
// sequentially in the same fork, and a first-time create can lag
// `listHostedZones` long enough that the second test's lookup misses and
// creates a DUPLICATE zone (same name + fresh CallerReference succeeds).
let standingZoneId: string | undefined;
const ensureZone = Effect.suspend(() =>
  standingZoneId !== undefined
    ? Effect.succeed(standingZoneId)
    : resolveZone.pipe(
        Effect.tap((id) =>
          Effect.sync(() => {
            standingZoneId = id;
          }),
        ),
      ),
);

// Suite teardown: purge any test records still in the zone (idempotent — the
// happy path already deleted them) and delete the zone itself so a passing
// run leaves ZERO Route53 leftovers. Runs as `Effect.ensuring` on the LAST
// test in this file (test-body cleanup keeps the provider environment in
// scope, unlike `afterAll`). Re-creation on the next run is safe because
// `resolveZone` is lookup-first with a fresh CallerReference — and if a run
// dies before the teardown fires, the deterministic zone name lets the next
// run reclaim AND delete the leftover.
const purgeAndDeleteZone = (zoneId: string) =>
  Effect.gen(function* () {
    const sets = yield* route53
      .listResourceRecordSets({ HostedZoneId: zoneId, MaxItems: 100 })
      .pipe(
        Effect.map((r) => r.ResourceRecordSets ?? []),
        Effect.catchTag("NoSuchHostedZone", () => Effect.succeed([])),
      );
    const deletable = sets.filter((s) => s.Type !== "SOA" && s.Type !== "NS");
    if (deletable.length > 0) {
      yield* route53
        .changeResourceRecordSets({
          HostedZoneId: zoneId,
          ChangeBatch: {
            Comment: "Record.test.ts suite teardown",
            Changes: deletable.map((set) => ({
              Action: "DELETE" as const,
              ResourceRecordSet: set,
            })),
          },
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("InvalidChangeBatch", () => Effect.void),
          Effect.catchTag("NoSuchHostedZone", () => Effect.void),
        );
    }
    yield* route53.deleteHostedZone({ Id: zoneId }).pipe(
      Effect.asVoid,
      Effect.catchTag("NoSuchHostedZone", () => Effect.void),
      // Route 53 serializes changes per zone; a delete racing the record
      // purge above can bounce with PriorRequestNotComplete.
      Effect.retry({
        while: (e) => e._tag === "PriorRequestNotComplete",
        schedule: Schedule.spaced("3 seconds"),
        times: 8,
      }),
    );
    // Verify the delete actually landed (authoritative read, not the
    // eventually-consistent list) — a silent no-op here would orphan the zone.
    yield* route53.getHostedZone({ Id: zoneId }).pipe(
      Effect.flatMap(() =>
        Effect.fail(new Error(`teardown: zone ${zoneId} still exists`)),
      ),
      Effect.catchTag("NoSuchHostedZone", () => Effect.void),
      Effect.retry({
        while: (e): boolean => e instanceof Error,
        schedule: Schedule.spaced("2 seconds"),
        times: 10,
      }),
    );
  });

const teardownZone = Effect.gen(function* () {
  // Delete EVERY incarnation bearing the test zone name, not just one id:
  // a transient failure (or vitest retry) between a server-side create and
  // the caller observing it can mint a duplicate same-name zone while the
  // eventually-consistent list still hides the sibling. Union the in-run
  // cached id (the list may not show a moments-old zone yet) with every
  // listed match; anything the stale list hides this run is reclaimed by
  // the NEXT run's teardown via the same name lookup.
  const listed = yield* listZoneIdsByName;
  const candidates = [
    ...new Set(
      [
        ...(standingZoneId !== undefined ? [standingZoneId] : []),
        ...listed,
      ].map(normalizeId),
    ),
  ];
  yield* Effect.forEach(candidates, purgeAndDeleteZone);
  // Drop the module-scope cache so a hypothetical later user re-resolves.
  standingZoneId = undefined;
}).pipe(Effect.orDie);

// Create/delete the record set out of band. The Alchemy engine's own deploy
// path is currently blocked by a distilled schema bug (see the file footer),
// so we seed the record directly to exercise `list()` against real Route53.
const changeRecord = (hostedZoneId: string, action: "UPSERT" | "DELETE") =>
  route53
    .changeResourceRecordSets({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Comment: "Route53 Record list() test",
        Changes: [
          {
            Action: action,
            ResourceRecordSet: {
              Name: recordName,
              Type: "TXT",
              TTL: 60,
              ResourceRecords: [{ Value: recordValue }],
            },
          },
        ],
      },
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("InvalidChangeBatch", () => Effect.void),
      Effect.catchTag("NoSuchHostedZone", () => Effect.void),
    );

test.provider(
  "list enumerates the deployed record across hosted zones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hostedZoneId = yield* ensureZone;
      yield* changeRecord(hostedZoneId, "UPSERT");

      const provider = yield* Provider.findProvider(Record);

      // `list()` fans out across every hosted zone; assert our seeded record
      // appears. Retry briefly to absorb Route53's create eventual consistency.
      const found = yield* provider.list().pipe(
        Effect.map((all) =>
          all.some(
            (r) =>
              normalizeId(r.hostedZoneId) === normalizeId(hostedZoneId) &&
              r.name === recordName &&
              r.type === "TXT",
          ),
        ),
        Effect.flatMap((present) =>
          present
            ? Effect.succeed(true)
            : Effect.fail(new Error("record not yet listable")),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("3 seconds"),
            Schedule.recurs(10),
          ]),
        }),
        Effect.catch(() => Effect.succeed(false)),
      );

      yield* changeRecord(hostedZoneId, "DELETE");
      // The zone stays up for the next test in this file; the `teardownZone`
      // teardown deletes it once the suite is done.
      yield* stack.destroy();

      expect(found).toBe(true);
    }),
  { timeout: 240_000 },
);

// Regression test for https://github.com/alchemy-run/alchemy/issues/736.
//
// An interrupted first deploy persists the record as `status: "creating"`
// with no attributes — and the Output-valued props (`hostedZoneId` flows from
// the zone resource, `name` is typically derived from it) do not survive the
// state round-trip: they deserialize as `undefined`. Plan's recovery branch
// then calls `provider.read` with those junk props, which crashed in
// `normalizeHostedZoneId(undefined)` (`undefined is not an object (evaluating
// 'hostedZoneId.replace')`) and wedged the stack. When `read` reports "not
// found", the same junk `olds` flow into `diff`, whose unguarded
// `normalizeHostedZoneId(olds.hostedZoneId)` / `normalizeName(olds.name)`
// were the next crash sites — so one wedged redeploy exercises all the guards.
//
// Deploy into the standing zone (see `ensureZone`), wedge the persisted row
// into exactly that shape, and assert the next deploy recovers: `read`
// returns undefined, `diff` falls through to the create recovery path, and
// reconcile's UPSERT converges on the half-created record.
const recoveryRecordName = `pr770-recovery.${zoneName}`;
const recoveryRecordValue = '"pr770-recovery"';

const deleteRecoveryRecord = (hostedZoneId: string) =>
  route53
    .changeResourceRecordSets({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Comment: "pr770 recovery test cleanup",
        Changes: [
          {
            Action: "DELETE",
            ResourceRecordSet: {
              Name: recoveryRecordName,
              Type: "TXT",
              TTL: 60,
              ResourceRecords: [{ Value: recoveryRecordValue }],
            },
          },
        ],
      },
    })
    .pipe(Effect.ignore);

test.provider(
  "recovers a half-created record whose creating-state lost Output-valued props (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const hostedZoneId = yield* ensureZone;

      // Safety net: if the recovery redeploy defects (the pre-fix crash), the
      // half-created record would otherwise leak into the standing zone; on
      // the happy path the DELETE finds nothing (InvalidChangeBatch, ignored).
      yield* Effect.addFinalizer(() => deleteRecoveryRecord(hostedZoneId));

      const deployRecord = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Record("RecoveryRecord", {
              hostedZoneId,
              name: recoveryRecordName,
              type: "TXT",
              ttl: "60 seconds",
              records: [recoveryRecordValue],
            });
          }),
        );

      const created = yield* deployRecord();
      expect(created.name).toBe(recoveryRecordName);

      // Rewrite the record's persisted row into the wedged shape: `creating`,
      // no attributes, and the Output-valued identity props lost in the
      // state round-trip.
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
          isResourceState(r.row) && r.row.resourceType === "AWS.Route53.Record",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error("no AWS.Route53.Record state row found after deploy"),
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
          props: {
            ...wedged.row.props,
            hostedZoneId: undefined,
            name: undefined,
          },
        },
      });

      // Before the fix this crashed in plan with
      // `TypeError: undefined is not an object (evaluating 'hostedZoneId.replace')`.
      const recovered = yield* deployRecord();
      expect(normalizeId(recovered.hostedZoneId)).toBe(
        normalizeId(hostedZoneId),
      );
      expect(recovered.name).toBe(recoveryRecordName);
      expect(recovered.type).toBe("TXT");

      // Verify out of band the record actually exists.
      const observed = yield* route53.listResourceRecordSets({
        HostedZoneId: hostedZoneId,
        StartRecordName: recoveryRecordName,
        StartRecordType: "TXT",
        MaxItems: 1,
      });
      expect(
        (observed.ResourceRecordSets ?? []).some(
          (set) => set.Name === recoveryRecordName && set.Type === "TXT",
        ),
      ).toBe(true);

      // destroy() removes the record; the zone itself is deleted by the
      // `teardownZone` ensuring below.
      yield* stack.destroy();
    }).pipe(
      // This is the LAST test in the file, so it owns the shared zone's
      // teardown — success, failure, or interruption all leave the account
      // Route53-clean.
      Effect.ensuring(teardownZone),
    ),
  { timeout: 240_000 },
);
