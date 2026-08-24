import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as apiGateway from "@distilled.cloud/cloudflare/api-gateway";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test label names (Cloudflare caps them at 24 chars).
const NAME_DEFAULT = "alch-apishield-default";
const NAME_RENAME_A = "alch-apishield-ren-a";
const NAME_RENAME_B = "alch-apishield-ren-b";
const NAME_LIST = "alch-apishield-list";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// The scoped API token the test harness mints propagates eventually-
// consistently — a fresh token intermittently 403s. Ride out the blips on
// the test's own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

// Read a label out-of-band; `undefined` when gone.
const getLabel = (zoneId: string, name: string) =>
  apiGateway.getLabelUser({ zoneId, name }).pipe(
    Effect.map((label): apiGateway.GetLabelUserResponse | undefined => label),
    Effect.catchTag("LabelNotFound", () => Effect.succeed(undefined)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Purge a label left over from interrupted runs so each test starts clean.
const purgeLabel = (zoneId: string, name: string) =>
  apiGateway.deleteLabelUser({ zoneId, name }).pipe(
    Effect.catchTag("LabelNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider("create, update description in place, destroy a label", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeLabel(zoneId, NAME_DEFAULT);

    const label = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.ApiShield.Label("DefaultLabel", {
          zoneId,
          name: NAME_DEFAULT,
          description: "v1",
        }).pipe(adopt(true));
      }),
    );

    expect(label.zoneId).toEqual(zoneId);
    expect(label.name).toEqual(NAME_DEFAULT);
    expect(label.description).toEqual("v1");
    expect(label.source).toEqual("user");

    const live = yield* getLabel(zoneId, NAME_DEFAULT);
    expect(live?.name).toEqual(NAME_DEFAULT);
    expect(live?.description).toEqual("v1");

    // Update the mutable description — same identity, patched in place.
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.ApiShield.Label("DefaultLabel", {
          zoneId,
          name: NAME_DEFAULT,
          description: "v2",
        }).pipe(adopt(true));
      }),
    );
    expect(updated.name).toEqual(NAME_DEFAULT);
    expect(updated.createdAt).toEqual(label.createdAt);
    expect(updated.description).toEqual("v2");

    const patched = yield* getLabel(zoneId, NAME_DEFAULT);
    expect(patched?.description).toEqual("v2");

    yield* stack.destroy();

    const gone = yield* getLabel(zoneId, NAME_DEFAULT);
    expect(gone).toBeUndefined();
  }).pipe(logLevel),
);

test.provider("renaming a label triggers replacement", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeLabel(zoneId, NAME_RENAME_A);
    yield* purgeLabel(zoneId, NAME_RENAME_B);

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.ApiShield.Label("RenameLabel", {
          zoneId,
          name: NAME_RENAME_A,
          description: "before rename",
        }).pipe(adopt(true));
      }),
    );
    expect(initial.name).toEqual(NAME_RENAME_A);

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.ApiShield.Label("RenameLabel", {
          zoneId,
          name: NAME_RENAME_B,
          description: "after rename",
        }).pipe(adopt(true));
      }),
    );

    // The name is the label's identity — a new physical label exists.
    expect(replaced.name).toEqual(NAME_RENAME_B);
    expect(replaced.description).toEqual("after rename");

    // The old label was deleted as part of the replacement.
    const oldLabel = yield* getLabel(zoneId, NAME_RENAME_A);
    expect(oldLabel).toBeUndefined();

    const live = yield* getLabel(zoneId, NAME_RENAME_B);
    expect(live?.name).toEqual(NAME_RENAME_B);

    yield* stack.destroy();

    const gone = yield* getLabel(zoneId, NAME_RENAME_B);
    expect(gone).toBeUndefined();
  }).pipe(logLevel),
);

test.provider(
  "generated name respects Cloudflare's 24-character limit",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const label = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.Label("GeneratedNameLabel", {
            zoneId,
          }).pipe(adopt(true));
        }),
      );

      expect(label.name.length).toBeGreaterThan(0);
      expect(label.name.length).toBeLessThanOrEqual(24);
      expect(label.description).toEqual("");

      const live = yield* getLabel(zoneId, label.name);
      expect(live?.name).toEqual(label.name);

      yield* stack.destroy();

      const gone = yield* getLabel(zoneId, label.name);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
);

test.provider("list enumerates the deployed label", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();
    yield* purgeLabel(zoneId, NAME_LIST);

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.ApiShield.Label("ListLabel", {
          zoneId,
          name: NAME_LIST,
          description: "listed",
        }).pipe(adopt(true));
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.ApiShield.Label);

    // `list()` fans out over every zone and paginates each. Under a full
    // concurrent run two things can blip: the freshly-minted scoped token
    // 403s while it propagates (typed `Forbidden`), and a just-created label
    // lags the zone list endpoint. Retry the whole enumeration on either, so
    // the test rides out both instead of asserting on one snapshot.
    const appears = (all: readonly { zoneId: string; name: string }[]) =>
      all.some(
        (label) => label.zoneId === zoneId && label.name === deployed.name,
      );
    const all = yield* provider.list().pipe(
      Effect.flatMap((rows) =>
        appears(rows)
          ? Effect.succeed(rows)
          : Effect.fail({ _tag: "LabelNotListed" as const }),
      ),
      Effect.retry({
        while: (e) => e._tag === "Forbidden" || e._tag === "LabelNotListed",
        schedule: Schedule.spaced("1 seconds"),
        times: 15,
      }),
    );

    expect(appears(all)).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);
