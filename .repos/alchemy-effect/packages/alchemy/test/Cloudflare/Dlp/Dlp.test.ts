import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// DLP is a paid Zero Trust add-on. On the standard testing account
// `POST /accounts/{id}/dlp/profiles/custom` fails with HTTP 403 code
// 3314 "Forbidden" — surfaced as the typed `Forbidden` error. The
// lifecycle tests are gated behind an entitled account supplied via env;
// the probe test always runs and pins the typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_DLP;

test.provider.skipIf(entitled)(
  "unentitled accounts surface the typed Forbidden error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const profileError = yield* zeroTrust
        .createDlpProfileCustom({
          accountId,
          name: "alchemy-dlp-entitlement-probe",
          entries: [
            {
              enabled: true,
              name: "probe-entry",
              pattern: { regex: "x{9}" },
            },
          ],
        })
        .pipe(Effect.flip);
      expect(profileError._tag).toEqual("Forbidden");

      const entryError = yield* zeroTrust
        .createDlpEntryCustom({
          accountId,
          enabled: true,
          name: "alchemy-dlp-entry-probe",
          pattern: { regex: "y{9}" },
        })
        .pipe(Effect.flip);
      expect(entryError._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!entitled)(
  "create, update, and destroy a DLP profile with a standalone entry",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* Cloudflare.Dlp.Profile("EmployeeIds", {
            name: "alchemy-test-dlp-profile",
            description: "v1",
            allowedMatchCount: 0,
            entries: [
              {
                name: "employee-id",
                enabled: true,
                pattern: { regex: "EMP-[0-9]{6}" },
              },
            ],
          });
          const entry = yield* Cloudflare.Dlp.Entry("CardNumber", {
            name: "alchemy-test-dlp-entry",
            pattern: { regex: "[0-9]{13,16}", validation: "luhn" },
            profileId: profile.profileId,
          });
          return { profile, entry };
        }),
      );

      expect(created.profile.profileId).toBeDefined();
      expect(created.profile.entryIds["employee-id"]).toBeDefined();
      expect(created.entry.entryId).toBeDefined();
      expect(created.entry.profileId).toEqual(created.profile.profileId);

      // Description update converges in place — same profile id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* Cloudflare.Dlp.Profile("EmployeeIds", {
            name: "alchemy-test-dlp-profile",
            description: "v2",
            allowedMatchCount: 3,
            entries: [
              {
                name: "employee-id",
                enabled: true,
                pattern: { regex: "EMP-[0-9]{8}" },
              },
            ],
          });
          const entry = yield* Cloudflare.Dlp.Entry("CardNumber", {
            name: "alchemy-test-dlp-entry",
            pattern: { regex: "[0-9]{13,16}", validation: "luhn" },
            profileId: profile.profileId,
          });
          return { profile, entry };
        }),
      );
      expect(updated.profile.profileId).toEqual(created.profile.profileId);
      expect(updated.profile.description).toEqual("v2");
      expect(updated.profile.allowedMatchCount).toEqual(3);
      expect(updated.entry.entryId).toEqual(created.entry.entryId);

      yield* stack.destroy();

      const gone = yield* zeroTrust
        .getDlpProfileCustom({
          accountId,
          profileId: created.profile.profileId,
        })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("DlpProfileNotFound");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
