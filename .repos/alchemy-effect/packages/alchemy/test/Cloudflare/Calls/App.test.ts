import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as calls from "@distilled.cloud/cloudflare/calls";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getApp = (accountId: string, appId: string) =>
  calls.getSfu({ accountId, appId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, appId: string) =>
  getApp(accountId, appId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "AppNotDeleted" } as const)),
    // A missing app surfaces as `CallsAppNotFound` (Cloudflare error
    // code 20007) — that's the success condition here.
    Effect.catchTag("CallsAppNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "AppNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create and delete an app with default name", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const app = yield* stack.deploy(Cloudflare.Calls.App("DefaultApp", {}));

    expect(app.appId).toBeTruthy();
    expect(Redacted.value(app.secret)).toBeTruthy();
    expect(app.accountId).toEqual(accountId);
    expect(app.name).toBeTruthy();

    const live = yield* getApp(accountId, app.appId);
    expect(live.uid).toEqual(app.appId);
    expect(live.name).toEqual(app.name);

    yield* stack.destroy();

    yield* expectGone(accountId, app.appId);
  }).pipe(logLevel),
);

test.provider("update name in place (same appId, secret preserved)", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.Calls.App("UpdateApp", {
        name: "alchemy-calls-app-update",
      }),
    );

    expect(initial.name).toEqual("alchemy-calls-app-update");
    const initialSecret = Redacted.value(initial.secret);
    expect(initialSecret).toBeTruthy();

    const updated = yield* stack.deploy(
      Cloudflare.Calls.App("UpdateApp", {
        name: "alchemy-calls-app-update-v2",
      }),
    );

    // Same app mutated in place — not a replacement — and the
    // create-only secret is carried forward across the update.
    expect(updated.appId).toEqual(initial.appId);
    expect(updated.name).toEqual("alchemy-calls-app-update-v2");
    expect(Redacted.value(updated.secret)).toEqual(initialSecret);

    const live = yield* getApp(accountId, updated.appId);
    expect(live.name).toEqual("alchemy-calls-app-update-v2");

    // Redeploying identical props is a no-op (still the same app).
    const noop = yield* stack.deploy(
      Cloudflare.Calls.App("UpdateApp", {
        name: "alchemy-calls-app-update-v2",
      }),
    );
    expect(noop.appId).toEqual(initial.appId);
    expect(Redacted.value(noop.secret)).toEqual(initialSecret);

    yield* stack.destroy();

    yield* expectGone(accountId, initial.appId);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed app", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const app = yield* stack.deploy(
      Cloudflare.Calls.App("ListApp", {
        name: "alchemy-calls-app-list",
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.Calls.App);
    const all = yield* provider.list();

    // The account-scoped enumeration must contain the just-deployed app.
    const found = all.find((a) => a.appId === app.appId);
    expect(found).toBeDefined();
    expect(found?.accountId).toEqual(accountId);
    expect(found?.name).toEqual("alchemy-calls-app-list");

    yield* stack.destroy();

    yield* expectGone(accountId, app.appId);
  }).pipe(logLevel),
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const app = yield* stack.deploy(
      Cloudflare.Calls.App("HealApp", {
        name: "alchemy-calls-app-heal",
      }),
    );

    // Delete the app out-of-band. A redeploy with identical props is a
    // planner no-op, so change a prop to force reconcile — it must observe
    // the app as missing and recreate it instead of failing on the 20007.
    yield* calls.deleteSfu({ accountId, appId: app.appId }).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    );

    const healed = yield* stack.deploy(
      Cloudflare.Calls.App("HealApp", {
        name: "alchemy-calls-app-heal-v2",
      }),
    );

    expect(healed.appId).not.toEqual(app.appId);
    expect(Redacted.value(healed.secret)).toBeTruthy();
    expect(Redacted.value(healed.secret)).not.toEqual(
      Redacted.value(app.secret),
    );
    const live = yield* getApp(accountId, healed.appId);
    expect(live.name).toEqual("alchemy-calls-app-heal-v2");

    yield* stack.destroy();

    yield* expectGone(accountId, healed.appId);
  }).pipe(logLevel),
);
