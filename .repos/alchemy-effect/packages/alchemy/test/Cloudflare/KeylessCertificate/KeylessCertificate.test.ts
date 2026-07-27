import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as keylessCertificates from "@distilled.cloud/cloudflare/keyless-certificates";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { CERT_1, CERT_2 } from "./fixtures/certs.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Keyless SSL is Enterprise-only. On the testing account's zone every
// createKeylessCertificate fails with Cloudflare code 1067 ("Keyless SSL is
// not available for this zone. Please contact support."), surfaced as the
// typed `KeylessSslNotAvailable` error. The full lifecycle test below is
// gated behind an Enterprise zone id supplied via env.
const enterpriseZoneId = process.env.CLOUDFLARE_TEST_ENTERPRISE_ZONE_ID;

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
// consistently across Cloudflare's edge — ride out 403 blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getKeyless = (zoneId: string, keylessCertificateId: string) =>
  keylessCertificates
    .getKeylessCertificate({ zoneId, keylessCertificateId })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );

// A destroyed Keyless SSL configuration either disappears (typed
// `KeylessCertificateNotFound`, Cloudflare code 1005) or briefly lingers as
// a "deleted" tombstone — both count as gone.
const expectGone = (zoneId: string, keylessCertificateId: string) =>
  getKeyless(zoneId, keylessCertificateId).pipe(
    Effect.flatMap((observed) =>
      observed.status === "deleted"
        ? Effect.void
        : Effect.fail({ _tag: "KeylessNotDeleted" } as const),
    ),
    Effect.catchTag("KeylessCertificateNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "KeylessNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "surfaces the typed KeylessSslNotAvailable error on non-Enterprise zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // Listing works on every plan — verifies token scope and the typed
      // pagination surface out of band.
      const existing = yield* keylessCertificates.listKeylessCertificates
        .items({ zoneId })
        .pipe(
          Stream.runCollect,
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      expect(
        Array.from(existing).filter((k) => k.status !== "deleted"),
      ).toEqual([]);

      // Reading a non-existent configuration surfaces the typed
      // `KeylessCertificateNotFound` (Cloudflare code 1005).
      const readError = yield* getKeyless(
        zoneId,
        "00000000000000000000000000000000",
      ).pipe(Effect.flip);
      expect(readError._tag).toEqual("KeylessCertificateNotFound");

      // Deleting a non-existent configuration converges idempotently once
      // the typed not-found tag is absorbed — exactly what the provider's
      // delete does.
      yield* keylessCertificates
        .deleteKeylessCertificate({
          zoneId,
          keylessCertificateId: "00000000000000000000000000000000",
        })
        .pipe(
          Effect.catchTag("KeylessCertificateNotFound", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );

      // Creating on a non-Enterprise zone fails with the typed entitlement
      // tag (Cloudflare code 1067).
      const createError = yield* keylessCertificates
        .createKeylessCertificate({
          zoneId,
          certificate: CERT_1,
          host: `keyless.${zoneName}`,
          port: 24008,
          name: "alchemy-keyless-entitlement-probe",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(createError._tag).toEqual("KeylessSslNotAvailable");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// `list()` enumerates every zone in the account and lists its Keyless SSL
// configurations (zone-scoped collection, pattern (c)). This read-only
// assertion runs on every plan: the testing account has no Keyless SSL
// configurations (Enterprise-only), so the exhaustively-paginated result is a
// well-typed (possibly empty) array whose elements match `read`'s Attributes.
test.provider("list enumerates keyless certificates across zones", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.KeylessCertificate.KeylessCertificate,
    );
    const all = yield* provider.list().pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );

    expect(Array.isArray(all)).toBe(true);
    for (const item of all) {
      expect(typeof item.keylessCertificateId).toBe("string");
      expect(typeof item.zoneId).toBe("string");
      expect(item.status).not.toEqual("deleted");
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);

// On an entitled Enterprise zone, the deployed configuration must appear in the
// exhaustively-paginated `list()` result. Gated behind an Enterprise zone id
// (creation otherwise fails with the typed `KeylessSslNotAvailable`, code 1067).
test.provider.skipIf(!enterpriseZoneId)(
  "list includes a deployed keyless certificate",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = enterpriseZoneId!;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.KeylessCertificate.KeylessCertificate("ListKeyless", {
          zoneId,
          certificate: CERT_1,
          host: `keyless.${zoneName}`,
          port: 24008,
          name: "alchemy-keyless-list",
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.KeylessCertificate.KeylessCertificate,
      );
      const all = yield* provider.list().pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: forbiddenRetrySchedule,
          times: 8,
        }),
      );

      expect(
        all.some(
          (k) => k.keylessCertificateId === deployed.keylessCertificateId,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!enterpriseZoneId)(
  "creates, updates in place, replaces on certificate change, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = enterpriseZoneId!;

      yield* stack.destroy();

      // Create with an explicit name and conventional port.
      const created = yield* stack.deploy(
        Cloudflare.KeylessCertificate.KeylessCertificate("Keyless", {
          zoneId,
          certificate: CERT_1,
          host: `keyless.${zoneName}`,
          port: 24008,
          name: "alchemy-keyless-lifecycle",
        }),
      );

      expect(created.keylessCertificateId).toBeDefined();
      expect(created.zoneId).toEqual(zoneId);
      expect(created.name).toEqual("alchemy-keyless-lifecycle");
      expect(created.host).toEqual(`keyless.${zoneName}`);
      expect(created.port).toEqual(24008);
      expect(created.status).toEqual("active");

      // Out-of-band verify against the live API.
      const live = yield* getKeyless(zoneId, created.keylessCertificateId);
      expect(live.id).toEqual(created.keylessCertificateId);
      expect(live.host).toEqual(`keyless.${zoneName}`);
      expect(live.port).toEqual(24008);

      // Update mutable props in place — same identifier.
      const updated = yield* stack.deploy(
        Cloudflare.KeylessCertificate.KeylessCertificate("Keyless", {
          zoneId,
          certificate: CERT_1,
          host: `keyless2.${zoneName}`,
          port: 24009,
          name: "alchemy-keyless-lifecycle-v2",
          enabled: false,
        }),
      );
      expect(updated.keylessCertificateId).toEqual(
        created.keylessCertificateId,
      );
      expect(updated.host).toEqual(`keyless2.${zoneName}`);
      expect(updated.port).toEqual(24009);
      expect(updated.name).toEqual("alchemy-keyless-lifecycle-v2");
      expect(updated.enabled).toEqual(false);

      const liveUpdated = yield* getKeyless(
        zoneId,
        updated.keylessCertificateId,
      );
      expect(liveUpdated.host).toEqual(`keyless2.${zoneName}`);
      expect(liveUpdated.port).toEqual(24009);
      expect(liveUpdated.enabled).toEqual(false);

      // Changing the certificate replaces the configuration (the PATCH API
      // has no certificate field) — a new identifier is assigned.
      const replaced = yield* stack.deploy(
        Cloudflare.KeylessCertificate.KeylessCertificate("Keyless", {
          zoneId,
          certificate: CERT_2,
          host: `keyless2.${zoneName}`,
          port: 24009,
          name: "alchemy-keyless-lifecycle-v2",
          enabled: false,
        }),
      );
      expect(replaced.keylessCertificateId).not.toEqual(
        updated.keylessCertificateId,
      );
      yield* expectGone(zoneId, updated.keylessCertificateId);

      yield* stack.destroy();

      yield* expectGone(zoneId, replaced.keylessCertificateId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
