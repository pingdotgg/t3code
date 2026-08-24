import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as magicTransit from "@distilled.cloud/cloudflare/magic-transit";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Magic WAN custom apps are entitlement-gated. On the standard testing
// account every app call fails with the typed `MagicWanUnauthorized`
// error (Cloudflare code 1025) or `Forbidden` (403) depending on token
// scope. The lifecycle test below is gated behind an explicit opt-in env
// flag for entitled accounts; the probe test always runs and pins the
// typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_MAGIC_WAN;

// There is no getApp endpoint — scan the list for the app id.
const findApp = (accountId: string, appId: string) =>
  magicTransit
    .listApps({ accountId })
    .pipe(
      Effect.map((r) =>
        r.result.find(
          (app) => "accountAppId" in app && app.accountAppId === appId,
        ),
      ),
    );

// Poll until the app is gone from the list after destroy.
const expectGone = (accountId: string, appId: string) =>
  findApp(accountId, appId).pipe(
    Effect.flatMap((found) =>
      found ? Effect.fail({ _tag: "AppNotDeleted" } as const) : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "AppNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "unentitled accounts surface the typed MagicWanUnauthorized error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const canList = yield* magicTransit.listApps({ accountId }).pipe(
        Effect.as(true),
        Effect.catchTag(["MagicWanUnauthorized", "Forbidden"], () =>
          Effect.succeed(false),
        ),
      );
      if (canList) {
        // Entitled account — the gated lifecycle test covers real behavior.
        yield* Effect.logInfo(
          "account is Magic WAN-entitled; probe test is a no-op",
        );
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* magicTransit
        .listApps({ accountId })
        .pipe(Effect.flip);
      expect(["MagicWanUnauthorized", "Forbidden"]).toContain(error._tag);

      const createError = yield* magicTransit
        .createApp({
          accountId,
          name: "alchemy-app-probe",
          type: "Collaboration",
          hostnames: ["probe.alchemy.test"],
        })
        .pipe(Effect.flip);
      expect(["MagicWanUnauthorized", "Forbidden"]).toContain(createError._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!entitled)(
  "creates a custom app, updates mutable props in place, and destroys it",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const app = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicApp("App", {
          name: "alchemy-magic-app",
          type: "Collaboration",
          hostnames: ["crm.alchemy.test"],
        }),
      );

      expect(app.appId).toBeTruthy();
      expect(app.accountId).toEqual(accountId);
      expect(app.name).toEqual("alchemy-magic-app");
      expect(app.type).toEqual("Collaboration");
      expect(app.hostnames).toEqual(["crm.alchemy.test"]);

      // Out-of-band verification via the distilled API.
      const live = yield* findApp(accountId, app.appId);
      expect(live).toBeDefined();

      // Update mutable props in place — same appId.
      const updated = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicApp("App", {
          name: "alchemy-magic-app-v2",
          type: "Collaboration",
          hostnames: ["crm.alchemy.test", "erp.alchemy.test"],
        }),
      );

      expect(updated.appId).toEqual(app.appId);
      expect(updated.name).toEqual("alchemy-magic-app-v2");
      expect([...(updated.hostnames ?? [])].sort()).toEqual([
        "crm.alchemy.test",
        "erp.alchemy.test",
      ]);

      yield* stack.destroy();

      yield* expectGone(accountId, app.appId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Read-only list assertion. Always safe: on an unentitled account the
// account-scoped apps list rejects with the typed `MagicWanUnauthorized` /
// `Forbidden`, which `list()` maps to a well-typed empty array.
test.provider(
  "list enumerates account apps (well-typed [] when unentitled)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicApp,
      );
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const app of all) {
        expect(typeof app.appId).toBe("string");
        expect(typeof app.accountId).toBe("string");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Entitled-account variant: deploy a real app and assert it appears in the
// exhaustively-paginated list result.
test.provider.skipIf(!entitled)(
  "list includes a deployed custom app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Cloudflare.MagicTransit.MagicApp("ListApp", {
          name: "alchemy-magic-list-app",
          type: "Collaboration",
          hostnames: ["list.alchemy.test"],
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicTransit.MagicApp,
      );
      const all = yield* provider.list();

      expect(all.some((app) => app.appId === deployed.appId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
