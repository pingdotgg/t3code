import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Creating accounts is tenant/partner-entitled. The standard testing
// account is NOT entitled, so by default only the read paths and the typed
// entitlement-rejection path run. Set CLOUDFLARE_TENANT_TEST=1 under tenant
// credentials to exercise the full CRUD lifecycle on a real subaccount.
const tenantEntitled = !!process.env.CLOUDFLARE_TENANT_TEST;

// A syntactically valid account id that cannot exist.
const missingAccountId = "00000000000000000000000000000000";

test.provider("read path: getAccount observes the testing account", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const observed = yield* accounts.getAccount({ accountId });
    expect(observed.id).toEqual(accountId);
    expect(observed.name).toBeTruthy();
    expect(["standard", "enterprise"]).toContain(observed.type);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("inaccessible account surfaces a typed tag", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // With an account-scoped token, an account id outside the token's
    // scope is rejected with the typed `Unauthorized` tag before routing.
    // (A tenant-owned account that has been deleted surfaces as
    // `InvalidRoute`, code 7003 — the tag the provider's `read` and
    // `delete` treat as "gone".)
    const error = yield* accounts
      .getAccount({ accountId: missingAccountId })
      .pipe(Effect.flip);
    expect(error._tag).toEqual("Unauthorized");

    yield* stack.destroy();
  }).pipe(logLevel),
);

// Account creation is tenant-gated, so list() is verified read-only: a
// standard token can LIST every account it can access, and the token's own
// testing account must appear in the exhaustively-paginated result with the
// exact `Attributes` shape `read` produces.
test.provider("list enumerates accessible accounts (read-only)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const provider = yield* Provider.findProvider(Cloudflare.Account.Account);
    const all = yield* provider.list();

    expect(all.length).toBeGreaterThan(0);

    const self = all.find((a) => a.accountId === accountId);
    expect(self).toBeDefined();
    expect(self?.name).toBeTruthy();
    expect(["standard", "enterprise"]).toContain(self?.type);
    expect(typeof self?.enforceTwofactor).toEqual("boolean");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider.skipIf(tenantEntitled)(
  "createAccount is entitlement-gated: typed AccountCreationForbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The standard testing account lacks the tenant entitlement, so
      // account creation fails with the typed tag (code 1002). Never
      // touches the real testing account.
      const error = yield* accounts
        .createAccount({ name: "alchemy-test-entitlement-probe" })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AccountCreationForbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
);

// Full lifecycle — only under tenant credentials (CLOUDFLARE_TENANT_TEST=1).
// Creates a brand-new subaccount; the real testing account is never mutated.
test.provider.skipIf(!tenantEntitled)(
  "create subaccount, update name and settings in place, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* stack.deploy(
        Cloudflare.Account.Account("TestSubaccount", {
          name: "alchemy-test-subaccount",
        }),
      );

      expect(account.accountId).toBeTruthy();
      expect(account.name).toEqual("alchemy-test-subaccount");
      expect(account.type).toEqual("standard");

      // Out-of-band verify.
      const live = yield* accounts.getAccount({
        accountId: account.accountId,
      });
      expect(live.name).toEqual("alchemy-test-subaccount");

      // Rename + settings update happen in place (same account id).
      const updated = yield* stack.deploy(
        Cloudflare.Account.Account("TestSubaccount", {
          name: "alchemy-test-subaccount-renamed",
          enforceTwofactor: true,
        }),
      );
      expect(updated.accountId).toEqual(account.accountId);
      expect(updated.name).toEqual("alchemy-test-subaccount-renamed");
      expect(updated.enforceTwofactor).toEqual(true);

      yield* stack.destroy();

      // Deletion is queued on Cloudflare's side; the account becomes
      // unreadable (`InvalidRoute`) once it leaves the tenant.
      yield* accounts.getAccount({ accountId: account.accountId }).pipe(
        Effect.flatMap(() =>
          Effect.fail({ _tag: "AccountNotDeleted" } as const),
        ),
        Effect.catchTag("InvalidRoute", () => Effect.void),
        Effect.retry({
          while: (e) => e._tag === "AccountNotDeleted",
          schedule: Schedule.max([
            Schedule.exponential("500 millis"),
            Schedule.recurs(10),
          ]),
        }),
      );
    }).pipe(logLevel),
);
