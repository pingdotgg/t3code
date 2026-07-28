import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as registrar from "@distilled.cloud/cloudflare/registrar";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A domain registered through Cloudflare Registrar on the testing account.
// Registrations cannot be created via the API, so the test adopts whatever
// is already there and always restores it on the way out.
const domainName =
  process.env.CLOUDFLARE_TEST_REGISTRAR_DOMAIN ?? "alchemy-test-3.us";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const findDomain = (accountId: string) =>
  registrar.listDomains.items({ accountId }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).find((domain) => domain.name === domainName),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Both cases mutate the same registered domain's settings; run them serially so they don't corrupt each other's captured `initialSettings` under the global concurrent test config.
describe.sequential("Domain", () => {
  test.provider(
    "adopts a registered domain, no-op syncs, and never releases it on destroy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const baseline = yield* findDomain(accountId);
        if (!baseline) {
          yield* Effect.log(
            `skipping: no Cloudflare Registrar domain "${domainName}" on account ${accountId}`,
          );
          return;
        }

        yield* stack.destroy();

        // Declare the settings the domain already has — a pure adoption with
        // a no-op sync, so no registrar write permission is needed.
        const props = {
          domainName,
          autoRenew: baseline.autoRenew ?? undefined,
          locked: baseline.locked ?? undefined,
          privacy: baseline.privacy ?? undefined,
        };

        const domain = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Registrar.Domain("Domain", props);
          }),
        );

        expect(domain.domainName).toEqual(domainName);
        expect(domain.accountId).toEqual(accountId);
        expect(domain.autoRenew).toEqual(baseline.autoRenew ?? undefined);
        expect(domain.locked).toEqual(baseline.locked ?? undefined);
        expect(domain.privacy).toEqual(baseline.privacy ?? undefined);
        expect(domain.currentRegistrar).toEqual("Cloudflare");
        expect(domain.supportedTld).toEqual(true);
        expect(domain.expiresAt).toBeDefined();
        // The pre-management settings were captured for restore-on-destroy.
        expect(domain.initialSettings).toEqual({
          autoRenew: baseline.autoRenew ?? undefined,
          locked: baseline.locked ?? undefined,
          privacy: baseline.privacy ?? undefined,
        });

        // Idempotent redeploy — still a no-op sync, initialSettings survive.
        const again = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Registrar.Domain("Domain", props);
          }),
        );
        expect(again.domainName).toEqual(domainName);
        expect(again.initialSettings).toEqual(domain.initialSettings);

        yield* stack.destroy();

        // Destroy must never release the registration — the domain is still
        // there with its settings intact.
        const after = yield* findDomain(accountId);
        expect(after).toBeDefined();
        expect(after?.autoRenew).toEqual(baseline.autoRenew);
        expect(after?.locked).toEqual(baseline.locked);
        expect(after?.privacy).toEqual(baseline.privacy);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "updates settings in place and restores the baseline on destroy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const baseline = yield* findDomain(accountId);
        if (!baseline) {
          yield* Effect.log(
            `skipping: no Cloudflare Registrar domain "${domainName}" on account ${accountId}`,
          );
          return;
        }

        // Probe write access with a same-value PUT (no actual change). The
        // testing token lacks registrar write permission, which surfaces as
        // the typed `RegistrarUpdateNotAllowed` (HTTP 422, "You are not
        // allowed to perform this action") — skip the mutation flow then.
        const probe = yield* registrar
          .putDomain({
            accountId,
            domainName,
            autoRenew: baseline.autoRenew ?? true,
          })
          .pipe(
            Effect.as("allowed" as const),
            Effect.catchTag("RegistrarUpdateNotAllowed", () =>
              Effect.succeed("blocked" as const),
            ),
            Effect.retry({
              while: (e) => e._tag === "Forbidden",
              schedule: forbiddenRetrySchedule,
              times: 8,
            }),
          );
        if (probe === "blocked") {
          yield* Effect.log(
            "skipping: API token lacks Cloudflare Registrar write permission " +
              "(putDomain failed with RegistrarUpdateNotAllowed)",
          );
          return;
        }

        yield* stack.destroy();

        const flipped = !(baseline.autoRenew ?? true);

        // In-place update: flip autoRenew away from the baseline.
        const domain = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Registrar.Domain("Domain", {
              domainName,
              autoRenew: flipped,
            });
          }),
        );
        expect(domain.autoRenew).toEqual(flipped);
        expect(domain.initialSettings.autoRenew).toEqual(
          baseline.autoRenew ?? undefined,
        );

        // Flip it back via an in-place update.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Registrar.Domain("Domain", {
              domainName,
              autoRenew: baseline.autoRenew ?? true,
            });
          }),
        );
        expect(updated.autoRenew).toEqual(baseline.autoRenew ?? true);
        // The captured pre-management settings survive updates.
        expect(updated.initialSettings.autoRenew).toEqual(
          baseline.autoRenew ?? undefined,
        );

        yield* stack.destroy();

        // Destroy restored the baseline settings and kept the registration.
        const restored = yield* findDomain(accountId);
        expect(restored).toBeDefined();
        expect(restored?.autoRenew).toEqual(baseline.autoRenew);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Registrar domains are real, pre-existing registrations that cannot be
  // created via the API, so this is read-only: `list()` enumerates whatever
  // is already on the account and we assert a well-typed Attributes[] (which
  // may legitimately be empty if the account has no registered domains).
  test.provider("list enumerates registrar domains on the account", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.Registrar.Domain,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const domain of all) {
        expect(typeof domain.domainName).toBe("string");
        expect(typeof domain.accountId).toBe("string");
        expect(domain.initialSettings).toBeDefined();
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  );
});
