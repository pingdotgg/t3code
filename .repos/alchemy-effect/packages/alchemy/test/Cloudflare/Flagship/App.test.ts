import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as flagship from "@distilled.cloud/cloudflare/flagship";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class AppStillExists extends Data.TaggedError("AppStillExists") {}

class AppNotListedYet extends Data.TaggedError("AppNotListedYet") {}

// A deleted app surfaces as `FlagshipAppNotFound` — that's the success
// condition here.
const expectAppGone = (accountId: string, appId: string) =>
  flagship.getApp({ accountId, appId }).pipe(
    Effect.flatMap(() => Effect.fail(new AppStillExists())),
    Effect.retry({
      while: (e): e is AppStillExists => e instanceof AppStillExists,
      schedule: Schedule.max([
        Schedule.exponential("250 millis"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag("FlagshipAppNotFound", () => Effect.void),
  );

test.provider("create, update, delete a Flagship app", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("App", {
          name: "alchemy-test-flagship-app",
        });
        return { app };
      }),
    );

    expect(initial.app.appId).toBeDefined();
    expect(initial.app.accountId).toEqual(accountId);
    expect(initial.app.name).toEqual("alchemy-test-flagship-app");

    // Verify out-of-band via the API.
    const live = yield* flagship.getApp({
      accountId,
      appId: initial.app.appId,
    });
    expect(live.name).toEqual("alchemy-test-flagship-app");

    // Rename in place — same app id.
    const renamed = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("App", {
          name: "alchemy-test-flagship-app-v2",
        });
        return { app };
      }),
    );
    expect(renamed.app.appId).toEqual(initial.app.appId);
    expect(renamed.app.name).toEqual("alchemy-test-flagship-app-v2");

    const liveRenamed = yield* flagship.getApp({
      accountId,
      appId: initial.app.appId,
    });
    expect(liveRenamed.name).toEqual("alchemy-test-flagship-app-v2");

    // Redeploying identical props is a no-op (still the same app).
    const noop = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("App", {
          name: "alchemy-test-flagship-app-v2",
        });
        return { app };
      }),
    );
    expect(noop.app.appId).toEqual(initial.app.appId);

    yield* stack.destroy();

    yield* expectAppGone(accountId, initial.app.appId);
  }).pipe(logLevel),
);

test.provider("recreates an app after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("HealApp", {
          name: "alchemy-test-flagship-heal",
        });
        return { app };
      }),
    );

    // Delete the app out-of-band. A redeploy with identical props is a
    // planner no-op, so change a prop to force reconcile — it must observe
    // the app as missing and recreate it instead of failing on a 404.
    yield* flagship.deleteApp({ accountId, appId: initial.app.appId });

    const healed = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("HealApp", {
          name: "alchemy-test-flagship-heal-v2",
        });
        return { app };
      }),
    );

    expect(healed.app.appId).not.toEqual(initial.app.appId);
    expect(healed.app.name).toEqual("alchemy-test-flagship-heal-v2");

    const live = yield* flagship.getApp({
      accountId,
      appId: healed.app.appId,
    });
    expect(live.name).toEqual("alchemy-test-flagship-heal-v2");

    yield* stack.destroy();

    yield* expectAppGone(accountId, healed.app.appId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed Flagship app", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("ListApp", {
          name: "alchemy-test-flagship-list",
        });
        return { app };
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Flagship.App);

    // The flagship apps list endpoint is eventually consistent: a freshly
    // created app is strongly readable by id via getApp but takes a few
    // seconds to surface in the account-wide list. Retry until it appears.
    const all = yield* provider.list().pipe(
      Effect.flatMap((apps) =>
        apps.some((a) => a.appId === deployed.app.appId)
          ? Effect.succeed(apps)
          : Effect.fail(new AppNotListedYet()),
      ),
      Effect.retry({
        while: (e): e is AppNotListedYet => e instanceof AppNotListedYet,
        schedule: Schedule.max([
          Schedule.exponential("500 millis"),
          Schedule.recurs(8),
        ]),
      }),
    );

    expect(all.some((a) => a.appId === deployed.app.appId)).toBe(true);
    const found = all.find((a) => a.appId === deployed.app.appId);
    expect(found?.name).toEqual("alchemy-test-flagship-list");
    expect(found?.accountId).toEqual(deployed.app.accountId);

    yield* stack.destroy();
  }).pipe(logLevel),
);
