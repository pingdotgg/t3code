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

// Cloudflare Email Security (Area 1) is an enterprise add-on — the standard
// testing account has no entitlement and every settings call fails with the
// typed `EmailSecurityNotEntitled` error ("Email Security API access is not
// available in the current subscription"). The full lifecycle tests are
// gated behind an entitled account flagged via env.
const entitled = !!process.env.CLOUDFLARE_EMAIL_SECURITY;

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const pattern = "alchemy-allow-policy@alchemy-test-2.us";

const findByPattern = (accountId: string) =>
  emailSecurity.listSettingAllowPolicies.items({ accountId, pattern }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).find((p) => p.pattern === pattern)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Unentitlement probe — pins the typed EmailSecurityNotEntitled rejection and
// skips on entitled accounts, where the list call would succeed.
test.provider.skipIf(entitled)(
  "surfaces the typed EmailSecurityNotEntitled error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // The testing account lacks the Email Security entitlement — the
      // distilled list call must fail with the typed entitlement tag.
      const error = yield* emailSecurity.listSettingAllowPolicies
        .items({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
      expect(error._tag).toEqual("EmailSecurityNotEntitled");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Read-only list assertion that runs on every account. On unentitled
// accounts the provider's list() maps the typed EmailSecurityNotEntitled
// rejection to a well-typed empty array; entitled accounts return real rows.
test.provider(
  "list enumerates allow policies (read-only)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Email.AllowPolicy,
      );
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Requires the Email Security (Area 1) enterprise add-on — unentitled accounts fail
// with the typed EmailSecurityNotEntitled. Unlock with CLOUDFLARE_EMAIL_SECURITY=1.
test.provider.skipIf(!entitled)(
  "list includes the deployed allow policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.AllowPolicy("ListPolicy", {
            pattern,
            patternType: "EMAIL",
            isAcceptableSender: true,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Email.AllowPolicy,
      );
      const all = yield* provider.list();
      expect(all.some((p) => p.policyId === deployed.policyId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Requires the Email Security (Area 1) enterprise add-on — unentitled accounts fail
// with the typed EmailSecurityNotEntitled. Unlock with CLOUDFLARE_EMAIL_SECURITY=1.
test.provider.skipIf(!entitled)(
  "create, update in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create an acceptable-sender allow policy.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.AllowPolicy("Policy", {
            pattern,
            patternType: "EMAIL",
            isAcceptableSender: true,
            comments: "v1",
          });
        }),
      );
      expect(created.policyId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.pattern).toEqual(pattern);
      expect(created.patternType).toEqual("EMAIL");
      expect(created.isAcceptableSender).toEqual(true);
      expect(created.isTrustedSender).toEqual(false);
      expect(created.verifySender).toEqual(true);
      expect(created.comments).toEqual("v1");

      // Out-of-band verification via the distilled API.
      const live = yield* findByPattern(accountId);
      expect(live?.id).toEqual(created.policyId);

      // Update mutable fields in place — same physical policy.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Email.AllowPolicy("Policy", {
            pattern,
            patternType: "EMAIL",
            isAcceptableSender: true,
            isExemptRecipient: true,
            verifySender: false,
            comments: "v2",
          });
        }),
      );
      expect(updated.policyId).toEqual(created.policyId);
      expect(updated.isExemptRecipient).toEqual(true);
      expect(updated.verifySender).toEqual(false);
      expect(updated.comments).toEqual("v2");

      yield* stack.destroy();

      // The policy is gone after destroy.
      const gone = yield* findByPattern(accountId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (p) => p === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
