import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as customNameservers from "@distilled.cloud/cloudflare/custom-nameservers";
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

// Account custom nameservers require a Business/Enterprise plan (or paid
// add-on). On the testing account every call — even the list — fails with
// Cloudflare code 1002 "This feature is not enabled for your account.",
// surfaced as the typed `CustomNameserversNotEnabled` error. The full
// lifecycle test below is gated behind an env flag for entitled accounts.
const entitled = !!process.env.CLOUDFLARE_TEST_CUSTOM_NS_ENTITLED;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out generic 403 blips
// (`Forbidden`) on out-of-band verification calls. The entitlement
// failure is a *different* typed tag (`CustomNameserversNotEnabled`),
// so this retry never loops on it.
const listNameservers = (accountId: string) =>
  customNameservers.getCustomNameserver({ accountId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const findByName = (accountId: string, nsName: string) =>
  listNameservers(accountId).pipe(
    Effect.map((page) => page.result.find((ns) => ns.nsName === nsName)),
  );

const expectGone = (accountId: string, nsName: string) =>
  findByName(accountId, nsName).pipe(
    Effect.flatMap((found) =>
      found
        ? Effect.fail({ _tag: "CustomNameserverNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "CustomNameserverNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "surfaces the typed CustomNameserversNotEnabled error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // The testing account lacks the account custom nameservers
      // entitlement — the distilled list call must fail with the typed
      // entitlement tag (not the generic 403 catch-all).
      const error = yield* listNameservers(accountId).pipe(Effect.flip);
      expect(error._tag).toEqual("CustomNameserversNotEnabled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Canonical `list()` test (account collection). On the unentitled testing
// account the collection endpoint rejects with `CustomNameserversNotEnabled`,
// which `list()` maps to an empty collection — so the read-only assertion is
// "list returns a well-typed array" (here, `[]`). An entitled account also
// runs the deploy+presence variant below.
test.provider("list enumerates account custom nameservers", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(
      Cloudflare.CustomNameserver.CustomNameserver,
    );
    const all = yield* provider.list();

    // Always a well-typed array; `[]` on unentitled accounts.
    expect(Array.isArray(all)).toBe(true);
    if (!entitled) {
      expect(all).toEqual([]);
    }

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(!entitled)(
  "list includes a deployed custom nameserver",
  (stack) =>
    Effect.gen(function* () {
      const nsName = `alchemy-ns-list.${zoneName}`;

      yield* stack.destroy();

      const ns = yield* stack.deploy(
        Cloudflare.CustomNameserver.CustomNameserver("NsList", { nsName }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.CustomNameserver.CustomNameserver,
      );
      const all = yield* provider.list();
      expect(all.some((x) => x.nsName === ns.nsName)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "create, replace on nsSet change, and destroy a custom nameserver",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const nsName = `alchemy-ns1.${zoneName}`;

      yield* stack.destroy();

      // Create on the default set.
      const ns = yield* stack.deploy(
        Cloudflare.CustomNameserver.CustomNameserver("Ns", { nsName }),
      );
      expect(ns.nsName).toEqual(nsName);
      expect(ns.accountId).toEqual(accountId);
      expect(ns.zoneTag).toBeTruthy();
      expect(ns.dnsRecords).toBeDefined();

      // Out-of-band verification via the distilled API.
      const live = yield* findByName(accountId, nsName);
      expect(live?.nsName).toEqual(nsName);

      // Redeploying identical props is a no-op (reconcile observes the
      // existing nameserver and converges without an API write).
      const noop = yield* stack.deploy(
        Cloudflare.CustomNameserver.CustomNameserver("Ns", { nsName }),
      );
      expect(noop.nsName).toEqual(nsName);
      expect(noop.zoneTag).toEqual(ns.zoneTag);

      // nsSet is immutable — changing it must replace the nameserver.
      const replaced = yield* stack.deploy(
        Cloudflare.CustomNameserver.CustomNameserver("Ns", {
          nsName,
          nsSet: 2,
        }),
      );
      expect(replaced.nsName).toEqual(nsName);
      expect(replaced.nsSet).toEqual(2);

      yield* stack.destroy();

      // The nameserver is gone; a second destroy is a no-op.
      yield* expectGone(accountId, nsName);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
