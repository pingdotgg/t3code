import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as ddos from "@distilled.cloud/cloudflare/ddos-protection";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Advanced TCP Protection is a Magic Transit (Enterprise add-on)
// entitlement that the testing account does not have — every API call fails
// with the typed `AdvancedTcpProtectionNotEntitled` error (Cloudflare code
// 8888; asserted in AllowlistEntry.test.ts). The lifecycle suite is gated
// behind an opt-in env var for entitled accounts.
const magicTransit = process.env.CLOUDFLARE_TEST_MAGIC_TRANSIT;

const accountId = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  return accountId;
});

test.provider.skipIf(!magicTransit)(
  "creates a SYN protection filter, updates it in place, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const acct = yield* accountId;

      yield* stack.destroy();

      // Create.
      const filter = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.SynProtectionFilter(
            "Filter",
            {
              expression: "tcp.dstport in {443}",
              mode: "monitoring",
            },
          );
        }),
      );
      expect(filter.expression).toEqual("tcp.dstport in {443}");
      expect(filter.mode).toEqual("monitoring");

      // Out-of-band verification via the distilled API.
      const live = yield* ddos.getAdvancedTcpProtectionSynProtectionFilterItem({
        accountId: acct,
        filterId: filter.filterId,
      });
      expect(live.expression).toEqual("tcp.dstport in {443}");

      // In-place update — expression and mode are patched, id is stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.SynProtectionFilter(
            "Filter",
            {
              expression: "tcp.dstport in {443 8443}",
              mode: "enabled",
            },
          );
        }),
      );
      expect(updated.filterId).toEqual(filter.filterId);
      expect(updated.expression).toEqual("tcp.dstport in {443 8443}");
      expect(updated.mode).toEqual("enabled");

      yield* stack.destroy();

      // Gone — the typed SynProtectionFilterNotFound error proves deletion.
      const error = yield* ddos
        .getAdvancedTcpProtectionSynProtectionFilterItem({
          accountId: acct,
          filterId: filter.filterId,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SynProtectionFilterNotFound");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Ungated: list() enumerates every filter in the ambient account. On the
// unentitled testing account the typed `AdvancedTcpProtectionNotEntitled`
// (Cloudflare code 8888) / `Forbidden` rejection is caught and surfaces as a
// well-typed empty array — proving list() is resilient on accounts without
// the Advanced TCP Protection entitlement.
test.provider(
  "list returns a well-typed array of SYN protection filters",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(
        Cloudflare.DdosProtection.SynProtectionFilter,
      );
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      for (const f of all) {
        expect(typeof f.filterId).toBe("string");
        expect(typeof f.accountId).toBe("string");
      }
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Gated full lifecycle: on an entitled account, a deployed filter must appear
// in the exhaustively-paginated list().
test.provider.skipIf(!magicTransit)(
  "list enumerates the deployed SYN protection filter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const filter = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DdosProtection.SynProtectionFilter(
            "ListFilter",
            {
              expression: "tcp.dstport in {8443}",
              mode: "monitoring",
            },
          );
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.DdosProtection.SynProtectionFilter,
      );
      const all = yield* provider.list();
      expect(all.some((f) => f.filterId === filter.filterId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
