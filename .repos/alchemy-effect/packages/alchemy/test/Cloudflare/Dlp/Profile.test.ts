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

// DLP is a paid Zero Trust add-on. Custom-profile *writes* fail on the
// standard testing account with HTTP 403 code 3314 surfaced as the typed
// `Forbidden` error (see Dlp.test.ts). The account-scoped profiles list
// endpoint is read-only and returns predefined/custom profiles the account
// can see, so the read-only `list()` assertion below always runs; the
// deploy-then-list assertion is gated behind an entitled account.
const entitled = !!process.env.CLOUDFLARE_TEST_DLP;

// Read-only: resolve the provider via the typed helper and enumerate every
// custom DLP profile. The result is the exact `read` Attributes shape. On an
// unentitled account there may be zero custom profiles, so we only assert the
// result is a well-typed array whose elements have the Attributes shape.
test.provider(
  "list enumerates custom DLP profiles (read-only)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cloudflare.Dlp.Profile);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const profile of all) {
        expect(typeof profile.profileId).toBe("string");
        expect(typeof profile.accountId).toBe("string");
        expect(typeof profile.name).toBe("string");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

// Entitled: deploy a custom profile and confirm `list()` enumerates it.
test.provider.skipIf(!entitled)(
  "list includes a deployed custom DLP profile",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Dlp.Profile("ListResource", {
            name: "alchemy-test-dlp-list",
            description: "list coverage",
            entries: [
              {
                name: "probe-entry",
                enabled: true,
                pattern: { regex: "EMP-[0-9]{6}" },
              },
            ],
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Dlp.Profile);
      const all = yield* provider.list();

      expect(all.some((p) => p.profileId === deployed.profileId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
