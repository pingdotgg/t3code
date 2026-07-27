import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as hostnames from "@distilled.cloud/cloudflare/hostnames";
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

// Per-hostname TLS settings are gated behind Advanced Certificate Manager
// (or Cloudflare for SaaS) — on the standard testing zone every PUT/DELETE
// fails with Cloudflare code 1450, surfaced as the typed
// `AdvancedCertificateManagerRequired` error. The full lifecycle test below
// is gated behind an entitled zone + hostname supplied via env.
const acmZoneId = process.env.CLOUDFLARE_TEST_ACM_ZONE_ID;
const acmHostname = process.env.CLOUDFLARE_TEST_ACM_HOSTNAME;

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

// Freshly-minted scoped tokens propagate eventually-consistently across
// Cloudflare's edge — ride out intermittent 403 blips on the test's
// out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const findSetting = (zoneId: string, settingId: string, hostname: string) =>
  hostnames.getSettingTls({ zoneId, settingId }).pipe(
    Effect.map((response) =>
      response.result.find((entry) => entry.hostname === hostname),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "lists overrides and surfaces the typed AdvancedCertificateManagerRequired error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // Listing a setting's per-hostname overrides works on any zone.
      const list = yield* hostnames
        .getSettingTls({ zoneId, settingId: "min_tls_version" })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );
      expect(Array.isArray(list.result)).toBe(true);

      // The standard testing zone lacks the ACM entitlement — a write must
      // fail with the typed entitlement tag (Cloudflare code 1450).
      const error = yield* hostnames
        .putSettingTls({
          zoneId,
          settingId: "min_tls_version",
          hostname: `alchemy-htls-gate.${zoneName}`,
          value: "1.2",
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("AdvancedCertificateManagerRequired");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Canonical `list()` test (zone-scoped collection): there is no account-wide
// API for per-hostname overrides, so `list()` enumerates every zone via
// `listAllZones` and lists each of the three TLS settings, paginating
// exhaustively. The standing test zone has no ACM entitlement and therefore
// no overrides, so the well-typed result is normally empty; when an entitled
// zone + hostname is supplied via env we deploy one and assert its presence.
test.provider(
  "list enumerates per-hostname TLS overrides",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      if (acmZoneId && acmHostname) {
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.HostnameTlsSetting.HostnameTlsSetting(
              "ListMinTls",
              {
                zoneId: acmZoneId,
                settingId: "min_tls_version",
                hostname: acmHostname,
                value: "1.2",
              },
            );
          }),
        );
      }

      const provider = yield* Provider.findProvider(
        Cloudflare.HostnameTlsSetting.HostnameTlsSetting,
      );
      const all = yield* provider.list();

      // Always a well-typed array (possibly empty on an unentitled account).
      expect(Array.isArray(all)).toBe(true);

      if (acmZoneId && acmHostname) {
        expect(
          all.some(
            (s) =>
              s.zoneId === acmZoneId &&
              s.settingId === "min_tls_version" &&
              s.hostname === acmHostname,
          ),
        ).toBe(true);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!acmZoneId || !acmHostname)(
  "create, update in place, and destroy a min_tls_version override",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = acmZoneId!;
      const hostname = acmHostname!;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.HostnameTlsSetting.HostnameTlsSetting(
            "MinTls",
            {
              zoneId,
              settingId: "min_tls_version",
              hostname,
              value: "1.2",
            },
          );
        }),
      );

      expect(created.zoneId).toEqual(zoneId);
      expect(created.settingId).toEqual("min_tls_version");
      expect(created.hostname).toEqual(hostname);
      expect(created.value).toEqual("1.2");

      // Out-of-band verification via the distilled API.
      const live = yield* findSetting(zoneId, "min_tls_version", hostname);
      expect(live).toBeDefined();
      expect(live!.value).toEqual("1.2");

      // Update in place — PUT upserts the same (settingId, hostname) pair.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.HostnameTlsSetting.HostnameTlsSetting(
            "MinTls",
            {
              zoneId,
              settingId: "min_tls_version",
              hostname,
              value: "1.3",
            },
          );
        }),
      );
      expect(updated.hostname).toEqual(hostname);
      expect(updated.value).toEqual("1.3");

      const liveUpdated = yield* findSetting(
        zoneId,
        "min_tls_version",
        hostname,
      );
      expect(liveUpdated!.value).toEqual("1.3");

      yield* stack.destroy();

      // Removal is eventually consistent — poll the list (bounded) until
      // the override disappears and the hostname reverts to zone defaults.
      const gone = yield* findSetting(zoneId, "min_tls_version", hostname).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (entry) => entry === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
