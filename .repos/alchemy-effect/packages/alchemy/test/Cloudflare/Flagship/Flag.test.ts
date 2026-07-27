import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { poll } from "@/Util/poll.ts";
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

class FlagStillExists extends Data.TaggedError("FlagStillExists") {}

// A deleted flag surfaces as `FlagshipFlagNotFound` (or, when the parent app
// was destroyed too, `FlagshipAppNotFound`) — either way it's gone.
const expectFlagGone = (accountId: string, appId: string, flagKey: string) =>
  flagship.getAppFlag({ accountId, appId, flagKey }).pipe(
    Effect.flatMap(() => Effect.fail(new FlagStillExists())),
    Effect.retry({
      while: (e): e is FlagStillExists => e instanceof FlagStillExists,
      schedule: Schedule.max([
        Schedule.exponential("250 millis"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag(
      ["FlagshipFlagNotFound", "FlagshipAppNotFound"],
      () => Effect.void,
    ),
  );

test.provider("create, update, delete a flag in an app", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("FlagApp", {
          name: "alchemy-test-flagship-flags",
        });
        const flag = yield* Cloudflare.Flagship.Flag("Flag", {
          appId: app.appId,
          key: "alchemy-test-flag",
          defaultVariation: "off",
          variations: { off: false, on: true },
        });
        return { app, flag };
      }),
    );

    expect(initial.flag.accountId).toEqual(accountId);
    expect(initial.flag.appId).toEqual(initial.app.appId);
    expect(initial.flag.key).toEqual("alchemy-test-flag");
    expect(initial.flag.enabled).toBe(true);
    expect(initial.flag.defaultVariation).toEqual("off");
    expect(initial.flag.variations).toEqual({ off: false, on: true });
    expect(initial.flag.rules).toEqual([]);

    // Verify out-of-band via the API.
    const live = yield* flagship.getAppFlag({
      accountId,
      appId: initial.app.appId,
      flagKey: "alchemy-test-flag",
    });
    expect(live.enabled).toBe(true);
    expect(live.defaultVariation).toEqual("off");
    expect(live.type).toEqual("boolean");

    // Update mutable props in place — same key, same app.
    const updated = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("FlagApp", {
          name: "alchemy-test-flagship-flags",
        });
        const flag = yield* Cloudflare.Flagship.Flag("Flag", {
          appId: app.appId,
          key: "alchemy-test-flag",
          enabled: false,
          defaultVariation: "on",
          variations: { off: false, on: true },
          description: "managed by alchemy",
          rules: [
            {
              priority: 1,
              conditions: [
                { attribute: "country", operator: "equals", value: "US" },
              ],
              serveVariation: "on",
              rollout: { percentage: 50 },
            },
          ],
        });
        return { app, flag };
      }),
    );

    expect(updated.flag.key).toEqual("alchemy-test-flag");
    expect(updated.flag.appId).toEqual(initial.app.appId);
    expect(updated.flag.enabled).toBe(false);
    expect(updated.flag.defaultVariation).toEqual("on");
    expect(updated.flag.description).toEqual("managed by alchemy");
    expect(updated.flag.rules).toEqual([
      {
        priority: 1,
        conditions: [{ attribute: "country", operator: "equals", value: "US" }],
        serveVariation: "on",
        rollout: { percentage: 50 },
      },
    ]);

    const liveUpdated = yield* flagship.getAppFlag({
      accountId,
      appId: initial.app.appId,
      flagKey: "alchemy-test-flag",
    });
    expect(liveUpdated.enabled).toBe(false);
    expect(liveUpdated.defaultVariation).toEqual("on");
    expect(liveUpdated.rules).toHaveLength(1);

    // Redeploying identical props is a no-op.
    const noop = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("FlagApp", {
          name: "alchemy-test-flagship-flags",
        });
        const flag = yield* Cloudflare.Flagship.Flag("Flag", {
          appId: app.appId,
          key: "alchemy-test-flag",
          enabled: false,
          defaultVariation: "on",
          variations: { off: false, on: true },
          description: "managed by alchemy",
          rules: [
            {
              priority: 1,
              conditions: [
                { attribute: "country", operator: "equals", value: "US" },
              ],
              serveVariation: "on",
              rollout: { percentage: 50 },
            },
          ],
        });
        return { app, flag };
      }),
    );
    expect(noop.flag.updatedAt).toEqual(updated.flag.updatedAt);

    yield* stack.destroy();

    yield* expectFlagGone(accountId, initial.app.appId, "alchemy-test-flag");
  }).pipe(logLevel),
);

test.provider("replaces the flag when the key changes", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("ReplaceApp", {
          name: "alchemy-test-flagship-replace",
        });
        const flag = yield* Cloudflare.Flagship.Flag("ReplaceFlag", {
          appId: app.appId,
          key: "alchemy-test-flag-a",
          defaultVariation: "off",
          variations: { off: false, on: true },
        });
        return { app, flag };
      }),
    );
    expect(initial.flag.key).toEqual("alchemy-test-flag-a");

    // Changing the key is a replacement: a new flag is created and the old
    // one is deleted.
    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("ReplaceApp", {
          name: "alchemy-test-flagship-replace",
        });
        const flag = yield* Cloudflare.Flagship.Flag("ReplaceFlag", {
          appId: app.appId,
          key: "alchemy-test-flag-b",
          defaultVariation: "off",
          variations: { off: false, on: true },
        });
        return { app, flag };
      }),
    );

    expect(replaced.flag.key).toEqual("alchemy-test-flag-b");
    yield* expectFlagGone(accountId, initial.app.appId, "alchemy-test-flag-a");

    yield* stack.destroy();

    yield* expectFlagGone(accountId, initial.app.appId, "alchemy-test-flag-b");
  }).pipe(logLevel),
);

test.provider("recreates a flag after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("HealApp", {
          name: "alchemy-test-flagship-heal-flag",
        });
        const flag = yield* Cloudflare.Flagship.Flag("HealFlag", {
          appId: app.appId,
          key: "alchemy-test-flag-heal",
          defaultVariation: "off",
          variations: { off: false, on: true },
        });
        return { app, flag };
      }),
    );

    // Delete the flag out-of-band. A redeploy with identical props is a
    // planner no-op, so change a prop to force reconcile — it must observe
    // the flag as missing and recreate it instead of failing on a 404.
    yield* flagship.deleteAppFlag({
      accountId,
      appId: initial.app.appId,
      flagKey: "alchemy-test-flag-heal",
    });

    const healed = yield* stack.deploy(
      Effect.gen(function* () {
        const app = yield* Cloudflare.Flagship.App("HealApp", {
          name: "alchemy-test-flagship-heal-flag",
        });
        const flag = yield* Cloudflare.Flagship.Flag("HealFlag", {
          appId: app.appId,
          key: "alchemy-test-flag-heal",
          enabled: false,
          defaultVariation: "off",
          variations: { off: false, on: true },
        });
        return { app, flag };
      }),
    );

    expect(healed.flag.key).toEqual("alchemy-test-flag-heal");
    expect(healed.flag.enabled).toBe(false);

    const live = yield* flagship.getAppFlag({
      accountId,
      appId: initial.app.appId,
      flagKey: "alchemy-test-flag-heal",
    });
    expect(live.enabled).toBe(false);

    yield* stack.destroy();

    yield* expectFlagGone(
      accountId,
      initial.app.appId,
      "alchemy-test-flag-heal",
    );
  }).pipe(logLevel),
);

test.provider(
  "list enumerates the deployed flag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.Flagship.App("ListApp", {
            name: "alchemy-test-flagship-list",
          });
          const flag = yield* Cloudflare.Flagship.Flag("ListFlag", {
            appId: app.appId,
            key: "alchemy-test-flag-list",
            defaultVariation: "off",
            variations: { off: false, on: true },
          });
          return { app, flag };
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.Flagship.Flag);

      // The flag itself is readable immediately (see the other tests' direct
      // `getAppFlag` right after deploy). What lags is the account-wide
      // `list()` path: the provider has no account-wide flag enumeration, so it
      // goes `listApps -> listAppFlags`, and a freshly-created app appears in
      // the account-wide `listApps` slower than the flag does under its own
      // parent. Poll the full path until that app-list consistency catches up.
      const all = yield* poll({
        description: "list() includes the deployed flag",
        effect: provider.list(),
        predicate: (all) =>
          all.some(
            (f) =>
              f.appId === deployed.app.appId && f.key === deployed.flag.key,
          ),
        schedule: Schedule.max([
          Schedule.spaced("3 seconds"),
          Schedule.recurs(30),
        ]),
      });

      expect(
        all.some(
          (f) => f.appId === deployed.app.appId && f.key === deployed.flag.key,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  // The `listApps` consistency poll above is bounded at ~90s (30 x 3s) plus
  // per-iteration `list()` latency, on top of two deploys; size the test over
  // that bounded worst case rather than the 120s default.
  { timeout: 180_000 },
);
