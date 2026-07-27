import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// DLP is a paid Zero Trust add-on. Writes (create entry/profile) surface the
// typed `Forbidden` error on unentitled accounts (see Dlp.test.ts). The
// account-scoped list endpoint (GET /accounts/{id}/dlp/entries) is read-only
// and returns an empty collection on the standard testing account, so the
// read-only `list()` assertion runs ungated. The deploy+presence assertion is
// gated behind an entitled account supplied via CLOUDFLARE_TEST_DLP.
const entitled = !!process.env.CLOUDFLARE_TEST_DLP;

// Read-only: `list()` enumerates every custom DLP entry in the account,
// exhaustively paginated, hydrated into the exact `read` Attributes shape.
// On an unentitled account this is the empty array (well-typed []); the
// assertion proves the op is callable and returns the correct shape.
test.provider(
  "list returns the account's custom DLP entries",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cloudflare.Dlp.Entry);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const entry of all) {
        expect(typeof entry.entryId).toBe("string");
        expect(typeof entry.accountId).toBe("string");
        expect(typeof entry.name).toBe("string");
        expect(typeof entry.enabled).toBe("boolean");
        expect(typeof entry.pattern.regex).toBe("string");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// Entitled-only: deploy a profile + standalone entry and assert `list()`
// surfaces the deployed entry by id.
test.provider.skipIf(!entitled)(
  "list enumerates the deployed DLP entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const profile = yield* Cloudflare.Dlp.Profile("EmployeeIds", {
            name: "alchemy-test-dlp-entry-list-profile",
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
            name: "alchemy-test-dlp-entry-list",
            pattern: { regex: "[0-9]{13,16}", validation: "luhn" },
            profileId: profile.profileId,
          });
          return { entry };
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Dlp.Entry);
      const all = yield* provider.list();

      expect(all.some((e) => e.entryId === deployed.entry.entryId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
