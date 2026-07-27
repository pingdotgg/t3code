import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as spectrum from "@distilled.cloud/cloudflare/spectrum";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Spectrum is plan-gated: the standard testing zone (Free plan) rejects
// every protocol — even `tcp/22` — with Cloudflare code 13002 "The
// requested protocol is not available", surfaced as the typed
// `SpectrumProtocolNotAvailable` error. The full lifecycle tests below are
// gated behind a Spectrum-entitled zone id supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_SPECTRUM_ZONE_ID;

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
// consistently across Cloudflare's edge — ride out 403 blips on the
// out-of-band verification calls by retrying the typed `Forbidden` tag.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getApp = (zoneId: string, appId: string) =>
  spectrum.getApp({ zoneId, appId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const findApp = (zoneId: string, dnsName: string, protocol: string) =>
  spectrum.listApps.items({ zoneId }).pipe(
    Stream.filter((a) => a.dns.name === dnsName && a.protocol === protocol),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)[0]),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Delete every app matching (dns.name, protocol) — purges leftovers from
// interrupted runs so the adoption test starts from a clean slate.
const purgeApps = (zoneId: string, dnsName: string, protocol: string) =>
  spectrum.listApps.items({ zoneId }).pipe(
    Stream.filter((a) => a.dns.name === dnsName && a.protocol === protocol),
    Stream.runCollect,
    Effect.flatMap(
      Effect.forEach((a) =>
        spectrum
          .deleteApp({ zoneId, appId: a.id })
          .pipe(Effect.catchTag("SpectrumAppNotFound", () => Effect.void)),
      ),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Hostname of the entitled zone, resolved from its id so the gated tests
// can build deterministic edge hostnames inside that zone. (No Forbidden
// retry here — `zones.getZone`'s typed error union does not include it.)
const resolveEntitledZoneName = (zoneId: string) =>
  zones.getZone({ zoneId }).pipe(Effect.map((z) => z.name));

test.provider(
  "surfaces the typed SpectrumProtocolNotAvailable error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The standard testing zone has no Spectrum entitlement — the
      // distilled create must fail with the typed plan-gate tag.
      const error = yield* spectrum
        .createApp({
          zoneId,
          dns: { type: "CNAME", name: `alchemy-spectrum-gate.${zoneName}` },
          protocol: "tcp/22",
          originDirect: ["tcp://192.0.2.1:22"],
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("SpectrumProtocolNotAvailable");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitledZoneId)(
  "create, update in place, and destroy a tcp/22 application",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;
      const entitledZoneName = yield* resolveEntitledZoneName(zoneId);
      const dnsName = `alchemy-spectrum-lifecycle.${entitledZoneName}`;

      yield* stack.destroy();
      yield* purgeApps(zoneId, dnsName, "tcp/22");

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Spectrum.Application("Ssh", {
            zoneId,
            dns: { type: "CNAME", name: dnsName },
            protocol: "tcp/22",
            originDirect: ["tcp://192.0.2.1:22"],
          }).pipe(adopt(true));
        }),
      );

      expect(app.appId).toBeDefined();
      expect(app.zoneId).toEqual(zoneId);
      expect(app.dnsName).toEqual(dnsName);
      expect(app.protocol).toEqual("tcp/22");
      expect(app.originDirect).toEqual(["tcp://192.0.2.1:22"]);
      expect(app.ipFirewall).toEqual(false);

      // Out-of-band verification via the distilled API.
      const live = yield* getApp(zoneId, app.appId);
      expect(live.id).toEqual(app.appId);
      expect(live.dns.name).toEqual(dnsName);
      expect(live.protocol).toEqual("tcp/22");

      // Update in place: new origin address + ipFirewall on. Same appId —
      // not a replacement.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Spectrum.Application("Ssh", {
            zoneId,
            dns: { type: "CNAME", name: dnsName },
            protocol: "tcp/22",
            originDirect: ["tcp://192.0.2.2:22"],
            ipFirewall: true,
          }).pipe(adopt(true));
        }),
      );

      expect(updated.appId).toEqual(app.appId);
      expect(updated.originDirect).toEqual(["tcp://192.0.2.2:22"]);
      expect(updated.ipFirewall).toEqual(true);

      const converged = yield* getApp(zoneId, updated.appId);
      expect(converged.originDirect).toEqual(["tcp://192.0.2.2:22"]);

      yield* stack.destroy();

      // Destroy removed the application (and its Spectrum-managed edge
      // DNS record with it).
      const gone = yield* findApp(zoneId, dnsName, "tcp/22");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitledZoneId)(
  "adoption — existing app errors without adopt, takes over with adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;
      const entitledZoneName = yield* resolveEntitledZoneName(zoneId);
      const dnsName = `alchemy-spectrum-adopt.${entitledZoneName}`;

      yield* stack.destroy();
      yield* purgeApps(zoneId, dnsName, "tcp/22");

      // Create the application out-of-band so the stack has no state of
      // its own for it — exactly the "the app already exists" scenario.
      const pre = yield* spectrum
        .createApp({
          zoneId,
          dns: { type: "CNAME", name: dnsName },
          protocol: "tcp/22",
          originDirect: ["tcp://192.0.2.10:22"],
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      expect(pre.id).toBeDefined();

      // Without `adopt`: Spectrum apps carry no ownership markers, so the
      // engine cannot prove we created it and refuses to take it over.
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Spectrum.Application("Adopted", {
              zoneId,
              dns: { type: "CNAME", name: dnsName },
              protocol: "tcp/22",
              originDirect: ["tcp://192.0.2.11:22"],
            });
          }),
        )
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
        );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // With `adopt(true)`: the engine takes over the pre-existing app
      // (same physical id) and converges it to the desired origin.
      const adopted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Spectrum.Application("Adopted", {
            zoneId,
            dns: { type: "CNAME", name: dnsName },
            protocol: "tcp/22",
            originDirect: ["tcp://192.0.2.11:22"],
          }).pipe(adopt(true));
        }),
      );

      expect(adopted.appId).toEqual(pre.id);
      expect(adopted.originDirect).toEqual(["tcp://192.0.2.11:22"]);

      const live = yield* getApp(zoneId, adopted.appId);
      expect(live.originDirect).toEqual(["tcp://192.0.2.11:22"]);

      yield* stack.destroy();

      const gone = yield* findApp(zoneId, dnsName, "tcp/22");
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped collection): `list()` fans out over
// every zone via `listAllZones`, exhaustively paginates the Spectrum apps in
// each, and hydrates them into the exact `read` Attributes shape. Listing is
// not entitlement-gated — the standing test zone (no Spectrum) simply yields
// no apps for that zone — so this read-only assertion runs unconditionally:
// `list()` must resolve to a well-typed array without throwing.
test.provider(
  "list enumerates Spectrum applications across all zones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Spectrum.Application,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      // Every hydrated item carries the full `read` Attributes shape.
      for (const app of all) {
        expect(typeof app.appId).toBe("string");
        expect(typeof app.zoneId).toBe("string");
        expect(typeof app.protocol).toBe("string");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Full deploy + list assertion: requires a Spectrum-entitled zone (create is
// gated by `SpectrumProtocolNotAvailable`, Cloudflare code 13002, on
// unentitled zones). When supplied, deploy a tcp/22 app and assert `list()`
// surfaces it.
test.provider.skipIf(!entitledZoneId)(
  "list surfaces a deployed Spectrum application (entitled zone)",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;
      const entitledZoneName = yield* resolveEntitledZoneName(zoneId);
      const dnsName = `alchemy-spectrum-list.${entitledZoneName}`;

      yield* stack.destroy();
      yield* purgeApps(zoneId, dnsName, "tcp/22");

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Spectrum.Application("Listed", {
            zoneId,
            dns: { type: "CNAME", name: dnsName },
            protocol: "tcp/22",
            originDirect: ["tcp://192.0.2.1:22"],
          }).pipe(adopt(true));
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Spectrum.Application,
      );
      const all = yield* provider.list();

      expect(all.some((a) => a.appId === app.appId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

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
