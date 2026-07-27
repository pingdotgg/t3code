import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as securityTxt from "@distilled.cloud/cloudflare/security-txt";
import { describe, expect } from "alchemy-test";
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
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error (part of
// each security-txt operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getSecurityTxt = (zoneId: string) =>
  securityTxt.getSecurityTxt({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the zone to a known baseline (no security.txt configured) so
// each run starts from the same cloud state regardless of what a previous
// (possibly interrupted) run left behind. DELETE on an absent file
// succeeds, so this is safe to run unconditionally.
const clearBaseline = (zoneId: string) =>
  securityTxt.deleteSecurityTxt({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const contact = ["mailto:security@alchemy.run"];
const expires = "2030-01-01T00:00:00Z";

describe.sequential("SecurityTxt", () => {
  test.provider(
    "creates a security.txt, verifies out-of-band, and deletes on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* clearBaseline(zoneId);

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
              zoneId,
              contact,
              expires,
            });
          }),
        );

        expect(created.zoneId).toEqual(zoneId);
        expect(created.enabled).toEqual(true);
        expect(created.contact).toEqual(contact);
        expect(created.expires).toEqual(expires);
        expect(created.policy).toBeUndefined();
        expect(created.preferredLanguages).toBeUndefined();

        // Out-of-band: the file exists with the configured fields.
        const live = yield* getSecurityTxt(zoneId);
        expect(typeof live).not.toEqual("string");
        if (typeof live !== "string") {
          expect(live.enabled).toEqual(true);
          expect(live.contact).toEqual(contact);
          expect(live.expires).toEqual(expires);
        }

        yield* stack.destroy();

        // Destroy removed the file — Cloudflare reports the unconfigured
        // state as an empty-string sentinel.
        const gone = yield* getSecurityTxt(zoneId);
        expect(gone).toEqual("");

        // Destroying again is a no-op (idempotent delete).
        yield* stack.destroy();
      }).pipe(logLevel),
  );

  test.provider("updates mutable fields in place (full-replace PUT)", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* clearBaseline(zoneId);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
            zoneId,
            contact,
            expires,
          });
        }),
      );
      expect(created.policy).toBeUndefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
            zoneId,
            contact,
            expires,
            policy: ["https://alchemy.run/security-policy"],
            preferredLanguages: "en, es",
          });
        }),
      );

      // Same singleton replaced in place — zone identity is unchanged.
      expect(updated.zoneId).toEqual(zoneId);
      expect(updated.policy).toEqual(["https://alchemy.run/security-policy"]);
      expect(updated.preferredLanguages).toEqual("en, es");

      const live = yield* getSecurityTxt(zoneId);
      expect(typeof live).not.toEqual("string");
      if (typeof live !== "string") {
        expect(live.policy).toEqual(["https://alchemy.run/security-policy"]);
        expect(live.preferredLanguages).toEqual("en, es");
      }

      // Dropping the optional fields converges back to the minimal file.
      const reverted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
            zoneId,
            contact,
            expires,
          });
        }),
      );
      expect(reverted.policy).toBeUndefined();
      expect(reverted.preferredLanguages).toBeUndefined();

      yield* stack.destroy();

      const gone = yield* getSecurityTxt(zoneId);
      expect(gone).toEqual("");
    }).pipe(logLevel),
  );

  test.provider(
    "disables the file without deleting it, then destroy removes it",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* clearBaseline(zoneId);

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
              zoneId,
              contact,
              expires,
            });
          }),
        );

        const disabled = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
              zoneId,
              enabled: false,
              contact,
              expires,
            });
          }),
        );

        // The configuration survives but the file is no longer served.
        expect(disabled.enabled).toEqual(false);
        expect(disabled.contact).toEqual(contact);

        const live = yield* getSecurityTxt(zoneId);
        expect(typeof live).not.toEqual("string");
        if (typeof live !== "string") {
          expect(live.enabled).toEqual(false);
        }

        yield* stack.destroy();

        const gone = yield* getSecurityTxt(zoneId);
        expect(gone).toEqual("");
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone file, so `list()` enumerates every zone via
  // `listAllZones` and reads each. Only configured zones are emitted, so deploy
  // a security.txt on the standing test zone and assert it appears.
  test.provider("list enumerates configured security.txt files", (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();
      yield* clearBaseline(zoneId);

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.SecurityTxt.SecurityTxt("SecurityTxt", {
            zoneId,
            contact,
            expires,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.SecurityTxt.SecurityTxt,
      );
      // Ride out token eventual-consistency 403s on the per-zone reads.
      const all = yield* provider.list().pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: forbiddenRetrySchedule,
          times: 8,
        }),
      );

      expect(all.length).toBeGreaterThan(0);
      const entry = all.find((s) => s.zoneId === deployed.zoneId);
      expect(entry).toBeDefined();
      expect(entry?.contact).toEqual(contact);
      expect(entry?.expires).toEqual(expires);

      yield* stack.destroy();

      const gone = yield* getSecurityTxt(zoneId);
      expect(gone).toEqual("");
    }).pipe(logLevel),
  );
});
