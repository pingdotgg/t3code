import * as AWS from "@/AWS";
import { EventDataStore } from "@/AWS/CloudTrail";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Alchemy";
import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import { expect } from "alchemy-test";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: a well-formed ARN pointing at a nonexistent
// store must surface the typed not-found the provider's read/delete paths
// depend on.
test.provider(
  "getEventDataStore on a nonexistent store fails with EventDataStoreNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        cloudtrail.getEventDataStore({
          EventDataStore: `arn:aws:cloudtrail:${region}:${accountId}:eventdatastore/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toBe("EventDataStoreNotFoundException");
    }),
);

// Ungated entitlement probe: CloudTrail Lake stopped accepting NEW
// customers (InvalidParameterException "CloudTrail Lake is no longer
// accepting new customers..."), which the distilled patch surfaces as the
// typed `CloudTrailLakeOnboardingClosed` tag. On a non-onboarded account
// this proves the patch; on an onboarded account the create succeeds and
// is immediately deleted (PENDING_DELETION incurs no cost).
const PROBE_STORE_NAME = "alchemy-test-cloudtrail-lake-probe";

// Idempotent, name-keyed cleanup for the out-of-band probe store. Because
// the probe's name is deterministic, this reclaims a leftover from a
// previously-killed run as well as the one created by this run. A store
// already in PENDING_DELETION is considered cleaned (Lake deletion always
// goes through a 7-day, zero-cost PENDING_DELETION window — there is no
// harder delete).
const deleteProbeStoreIfExists = Effect.gen(function* () {
  const stores = yield* cloudtrail.listEventDataStores({});
  const existing = (stores.EventDataStores ?? []).find(
    (s) => s.Name === PROBE_STORE_NAME && s.Status !== "PENDING_DELETION",
  );
  if (existing?.EventDataStoreArn !== undefined) {
    yield* cloudtrail
      .deleteEventDataStore({ EventDataStore: existing.EventDataStoreArn })
      .pipe(
        // A store still finishing creation can transiently conflict.
        Effect.retry({
          while: (e) => e._tag === "ConflictException",
          schedule: Schedule.exponential("2 seconds"),
          times: 8,
        }),
        Effect.catchTag(
          [
            "EventDataStoreNotFoundException",
            "InactiveEventDataStoreException",
          ],
          () => Effect.void,
        ),
      );
  }
});

test.provider(
  "createEventDataStore is either typed onboarding-closed or a real create",
  () =>
    Effect.gen(function* () {
      // Pre-clean: reclaim a leftover probe store from a killed prior run
      // so the deterministic name is free and the test converges.
      yield* deleteProbeStoreIfExists;
      const attempt = yield* Effect.result(
        cloudtrail.createEventDataStore({
          Name: PROBE_STORE_NAME,
          MultiRegionEnabled: false,
          RetentionPeriod: 7,
          TerminationProtectionEnabled: false,
        }),
      );
      if (Result.isFailure(attempt)) {
        expect([
          "CloudTrailLakeOnboardingClosed",
          // A prior probe's store still pending deletion holds the name on
          // an onboarded account.
          "EventDataStoreAlreadyExistsException",
        ]).toContain(attempt.failure._tag);
      }
      // Onboarded-account success path: the ensuring finalizer below
      // deletes the store (PENDING_DELETION incurs no cost).
    }).pipe(
      // Guaranteed cleanup on success, failure, AND interruption. Keyed on
      // the deterministic name, so it also covers the create-succeeded-but-
      // fiber-killed-before-response window on the next run's pre-clean.
      // orDie (not swallow): a failed cleanup must fail the test loudly —
      // a green run must imply zero leftovers.
      Effect.ensuring(deleteProbeStoreIfExists.pipe(Effect.orDie)),
    ),
);

const STORE_NAME = "alchemy-test-cloudtrail-eds";

// A deleted store sits in PENDING_DELETION for 7 days (no cost) and keeps
// its name; the provider restores such a store instead of creating a
// duplicate, which is what makes this test re-runnable day after day.
//
// GATED: CloudTrail Lake is closed to new customers (see the ungated probe
// above) — the full lifecycle only runs on an account that was onboarded
// to Lake before the closure. Set AWS_TEST_CLOUDTRAIL_LAKE=1 to run it.
test.provider.skipIf(!process.env.AWS_TEST_CLOUDTRAIL_LAKE)(
  "create event data store, update retention, delete (PENDING_DELETION)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const make = (props: {
        retentionPeriod: Duration.Input;
        tags?: Record<string, string>;
        ingestionEnabled?: boolean;
      }) =>
        Effect.gen(function* () {
          const store = yield* EventDataStore("Lake", {
            name: STORE_NAME,
            multiRegionEnabled: false,
            retentionPeriod: props.retentionPeriod,
            terminationProtectionEnabled: false,
            ingestionEnabled: props.ingestionEnabled,
            tags: props.tags,
          });
          return { store };
        });

      // 1. Create with the 7-day minimum retention.
      const { store } = yield* stack.deploy(
        make({
          retentionPeriod: "7 days",
          tags: { fixture: "cloudtrail-eds" },
        }),
      );
      expect(store.name).toBe(STORE_NAME);
      expect(store.eventDataStoreArn).toContain(":eventdatastore/");
      expect(["CREATED", "ENABLED", "STARTING_INGESTION"]).toContain(
        store.status,
      );

      // Out-of-band verification via distilled.
      const observed = yield* cloudtrail.getEventDataStore({
        EventDataStore: store.eventDataStoreArn,
      });
      expect(observed.Name).toBe(STORE_NAME);
      expect(observed.RetentionPeriod).toBe(7);
      expect(observed.TerminationProtectionEnabled).toBe(false);
      expect(observed.MultiRegionEnabled).toBe(false);
      const tags = yield* cloudtrail.listTags({
        ResourceIdList: [store.eventDataStoreArn],
      });
      const tagRecord = Object.fromEntries(
        (tags.ResourceTagList?.[0]?.TagsList ?? []).map((t) => [
          t.Key,
          t.Value,
        ]),
      );
      expect(tagRecord.fixture).toBe("cloudtrail-eds");
      expect(tagRecord["alchemy::id"]).toBe("Lake");

      // 2. Update retention in place — the ARN is the stable identity.
      const { store: updated } = yield* stack.deploy(
        make({ retentionPeriod: "14 days", tags: { team: "audit" } }),
      );
      expect(updated.eventDataStoreArn).toBe(store.eventDataStoreArn);
      const observedAfter = yield* cloudtrail.getEventDataStore({
        EventDataStore: store.eventDataStoreArn,
      });
      expect(observedAfter.RetentionPeriod).toBe(14);
      const tagsAfter = yield* cloudtrail.listTags({
        ResourceIdList: [store.eventDataStoreArn],
      });
      const tagRecordAfter = Object.fromEntries(
        (tagsAfter.ResourceTagList?.[0]?.TagsList ?? []).map((t) => [
          t.Key,
          t.Value,
        ]),
      );
      expect(tagRecordAfter.team).toBe("audit");
      expect(tagRecordAfter.fixture).toBeUndefined();

      // 2b. Stop ingestion — the store's Status converges to
      // STOPPED_INGESTION; collected events stay queryable.
      const { store: stopped } = yield* stack.deploy(
        make({
          retentionPeriod: "14 days",
          tags: { team: "audit" },
          ingestionEnabled: false,
        }),
      );
      expect(stopped.eventDataStoreArn).toBe(store.eventDataStoreArn);
      const observedStopped = yield* cloudtrail.getEventDataStore({
        EventDataStore: store.eventDataStoreArn,
      });
      expect(["STOPPING_INGESTION", "STOPPED_INGESTION"]).toContain(
        observedStopped.Status,
      );

      // 3. Delete — schedules PENDING_DELETION (7-day wait, zero cost);
      // do NOT wait for the store to disappear.
      yield* stack.destroy();
      const afterDelete = yield* cloudtrail
        .getEventDataStore({ EventDataStore: store.eventDataStoreArn })
        .pipe(
          Effect.map((r) => r.Status ?? "UNKNOWN"),
          Effect.catchTag("EventDataStoreNotFoundException", () =>
            Effect.succeed("GONE" as const),
          ),
        );
      expect(["PENDING_DELETION", "GONE"]).toContain(afterDelete);
    }),
  { timeout: 180_000 },
);
