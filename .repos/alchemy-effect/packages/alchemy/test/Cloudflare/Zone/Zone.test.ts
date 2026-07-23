import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import { destroy } from "@/RemovalPolicy";
import * as Test from "@/Test/Vitest";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

// Cloudflare's POST /zones rejects reserved pseudo-TLDs (`.test`, `.local`,
// `.example`) with "unable to identify ... as a registered domain". A
// syntactically-valid, registerable name is accepted into a `pending` zone
// even when the domain isn't actually registered to us — which is all these
// create/delete lifecycle tests need. Derive the name from the test account id
// so it's deterministic and never collides with a real zone.
const zoneNameFor = (accountId: string, label: string) =>
  process.env.TEST_ZONE_NAME ?? `alchemy-${label}-${accountId}.com`;

test.provider(
  "create zone retains by default — destroy() opts in to deletion",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const TEST_ZONE = zoneNameFor(accountId, "destroy");

      const zone = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone("CreatedZone", {
            name: TEST_ZONE,
          }).pipe(destroy());
        }),
      );

      expect(zone.name).toBe(TEST_ZONE);
      expect(zone.accountId).toBe(accountId);

      // The mapped attributes should match what the Cloudflare API reports,
      // with the API's `null`s normalized to `undefined`.
      const live = yield* zones.getZone({ zoneId: zone.zoneId });
      expect(zone.zoneId).toBe(live.id);
      expect(zone.name).toBe(live.name);
      expect(zone.accountName).toBe(live.account.name ?? undefined);
      expect(zone.type).toBe(live.type ?? "full");
      expect(zone.status).toBe(live.status ?? undefined);
      expect(zone.paused).toBe(live.paused ?? false);
      expect(zone.nameServers).toEqual(live.nameServers);
      expect(zone.originalNameServers).toEqual(
        live.originalNameServers ?? undefined,
      );
      expect(zone.vanityNameServers).toEqual(
        live.vanityNameServers ?? undefined,
      );
      expect(zone.activatedOn).toBe(live.activatedOn ?? undefined);
      expect(zone.createdOn).toBe(live.createdOn);
      expect(zone.modifiedOn).toBe(live.modifiedOn);
      expect(zone.developmentMode).toBe(live.developmentMode);
      expect(zone.originalDnshost).toBe(live.originalDnshost ?? undefined);
      expect(zone.originalRegistrar).toBe(live.originalRegistrar ?? undefined);
      expect(zone.cnameSuffix).toBe(live.cnameSuffix ?? undefined);
      expect(zone.verificationKey).toBe(live.verificationKey ?? undefined);
      expect(zone.owner.id).toBe(live.owner.id ?? undefined);
      expect(zone.meta.foundationDns).toBe(
        live.meta.foundationDns ?? undefined,
      );

      yield* stack.destroy();

      yield* waitForZoneToBeDeleted(zone.zoneId);
    }),
);

test.provider(
  "create zone retains by default — survives stack.destroy()",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const TEST_ZONE = zoneNameFor(accountId, "retain");

      const zone = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Zone("RetainedZone", {
            name: TEST_ZONE,
          });
        }),
      );

      expect(zone.name).toBe(TEST_ZONE);
      expect(zone.accountId).toBe(accountId);

      yield* stack.destroy();

      const live = yield* zones.getZone({ zoneId: zone.zoneId });
      expect(live.id).toBe(zone.zoneId);

      // clean up the retained zone so the test is repeatable
      yield* zones.deleteZone({ zoneId: zone.zoneId });
      yield* waitForZoneToBeDeleted(zone.zoneId);
    }),
);

test.provider(
  "adoption — existing zone errors without adopt, takes over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const TEST_ZONE = zoneNameFor(accountId, "adopt");

      // Create the zone out-of-band so the stack has no state of its own for
      // it — exactly the "the zone already exists" scenario. Tolerate a zone
      // left behind by an interrupted run so the test stays repeatable.
      const existing = yield* zones
        .createZone({
          account: { id: accountId },
          name: TEST_ZONE,
          type: "full",
        })
        .pipe(
          Effect.catchTag("ZoneAlreadyExists", () =>
            findZoneByName({ accountId, name: TEST_ZONE }).pipe(
              Effect.flatMap((match) =>
                match
                  ? Effect.succeed(match)
                  : Effect.die(new Error(`zone ${TEST_ZONE} not found`)),
              ),
            ),
          ),
        );

      // Without `adopt`: a Cloudflare zone carries no ownership markers, so the
      // engine cannot prove we created it and refuses to take it over. The
      // engine surfaces this as a defect, so catch the whole cause and pull the
      // typed error back out rather than string-matching the message.
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Zone("AdoptedZone", { name: TEST_ZONE });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing zone instead
      // of creating a new one. `destroy()` opts the adopted zone into deletion
      // on teardown so the test stays repeatable.
      const adopted = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Zone("AdoptedZone", {
              name: TEST_ZONE,
            }).pipe(destroy());
          }),
        )
        .pipe(adopt(true));
      expect(adopted.zoneId).toBe(existing.id);
      expect(adopted.name).toBe(TEST_ZONE);

      yield* stack.destroy();
      yield* waitForZoneToBeDeleted(existing.id);
    }),
);

const waitForZoneToBeDeleted = Effect.fn(function* (zoneId: string) {
  yield* zones.getZone({ zoneId }).pipe(
    // A successful read means the zone is still around — force a retry.
    Effect.flatMap(() => new ZoneStillExists()),
    // Any other failure (e.g. `Invalid zone identifier` / 404) means the zone
    // is gone, which is exactly what we're waiting for.
    Effect.catch((e) =>
      e instanceof ZoneStillExists ? Effect.fail(e) : Effect.void,
    ),
    Effect.retry({
      while: (e): e is ZoneStillExists => e instanceof ZoneStillExists,
      schedule: Schedule.exponential(100),
      times: 20,
    }),
  );
});

class ZoneStillExists extends Data.TaggedError("ZoneStillExists") {}

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );
