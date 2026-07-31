import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as emailSecurity from "@distilled.cloud/cloudflare/email-security";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Email Security (Area 1) is an enterprise add-on — the standard testing
// account is not entitled (typed `EmailSecurityNotEntitled`), so the
// lifecycle test is gated behind an entitled account flagged via env.
const entitled = !!process.env.CLOUDFLARE_EMAIL_SECURITY;

const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const name = "Alchemy Test VIP";
const email = "alchemy-vip@alchemy-test-2.us";

const findEntry = (accountId: string) =>
  emailSecurity.listSettingImpersonationRegistries
    .items({ accountId, search: email })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).find((e) => e.name === name && e.email === email),
      ),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );

test.provider.skipIf(!entitled)(
  "create, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Register the protected display name → legitimate address mapping.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.ImpersonationRegistryEntry("Vip", {
            name,
            email,
            comments: "v1",
          });
        }),
      );
      expect(created.entryId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.name).toEqual(name);
      expect(created.email).toEqual(email);
      expect(created.isEmailRegex).toEqual(false);
      expect(created.comments).toEqual("v1");
      // Manually created entries carry the internal provenance.
      expect(created.provenance).toEqual("A1S_INTERNAL");

      // Out-of-band verification via the distilled API.
      const live = yield* findEntry(accountId);
      expect(live?.id).toEqual(created.entryId);

      // Update mutable fields in place — same physical entry.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.ImpersonationRegistryEntry("Vip", {
            name,
            email,
            comments: "v2",
          });
        }),
      );
      expect(updated.entryId).toEqual(created.entryId);
      expect(updated.comments).toEqual("v2");

      yield* stack.destroy();

      // The entry is gone after destroy.
      const gone = yield* findEntry(accountId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (e) => e === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Read-only: `list()` enumerates the account registry. On the standard
// (non-entitled) testing account the provider catches the typed
// `EmailSecurityNotEntitled` error and returns a well-typed empty array, so
// this runs everywhere and proves the wiring (typed `findProvider`, exact
// Attributes shape).
test.provider(
  "list returns the account impersonation registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Email.ImpersonationRegistryEntry,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const entry of all) {
        expect(typeof entry.entryId).toBe("string");
        expect(typeof entry.accountId).toBe("string");
        expect(typeof entry.name).toBe("string");
        expect(typeof entry.email).toBe("string");
        expect(typeof entry.isEmailRegex).toBe("boolean");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Entitled accounts: deploy a real entry and assert `list()` includes it.
test.provider.skipIf(!entitled)(
  "list enumerates the deployed impersonation registry entry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.ImpersonationRegistryEntry("ListVip", {
            name,
            email,
            comments: "list",
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Email.ImpersonationRegistryEntry,
      );
      const all = yield* provider.list();
      expect(all.some((e) => e.entryId === created.entryId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
