import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as realtimeKit from "@distilled.cloud/cloudflare/realtime-kit";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// RealtimeKit (the acquired Dyte platform) is in beta and must be enabled
// per account. On unentitled accounts every call fails with the typed
// `Forbidden` error (HTTP 403). Probe once per test: either the account can
// list apps (entitled) or we pin the typed tag and no-op the lifecycle.
const probeEntitlement = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* realtimeKit.getApp({ accountId }).pipe(
    Effect.as(true),
    Effect.catchTag("Forbidden", () => Effect.succeed(false)),
  );
});

// The scoped API token the test harness mints propagates eventually-
// consistently — ride out 403 blips on out-of-band verification calls.
const listApps = (accountId: string) =>
  realtimeKit.getApp({ accountId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
    Effect.map((res) => res.data ?? []),
  );

// Deterministic name — RealtimeKit apps cannot be deleted, so every run of
// this suite adopts the same app instead of leaking a new one. The Preset
// and Webhook suites share this name and adopt the same app.
const APP_NAME = "alchemy-rtk-test-app";

// Adoption is deterministic: among same-named apps (duplicates can exist on
// Cloudflare's side), the provider picks the oldest by createdAt.
const oldestNamed = (
  apps: readonly ({
    id?: string | null;
    name?: string | null;
    createdAt?: string | null;
  } | null)[],
) =>
  apps
    .filter((a) => a?.name === APP_NAME)
    .sort((a, b) => (a?.createdAt ?? "").localeCompare(b?.createdAt ?? ""))
    .at(0);

test.provider(
  "unentitled accounts surface the typed Forbidden error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const entitled = yield* probeEntitlement;
      if (entitled) {
        yield* Effect.logInfo(
          "account is RealtimeKit-entitled; probe test is a no-op",
        );
        return;
      }

      const { accountId } = yield* yield* CloudflareEnvironment;
      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* realtimeKit.getApp({ accountId }).pipe(Effect.flip);
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "create (or adopt), verify out-of-band, destroy forgets but keeps the app",
  (stack) =>
    Effect.gen(function* () {
      const entitled = yield* probeEntitlement;
      if (!entitled) {
        yield* Effect.logInfo(
          "account is not RealtimeKit-entitled; skipping lifecycle",
        );
        return;
      }

      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // If an app with the deterministic name already exists (from any
      // previous run), the deploy must adopt the oldest one instead of
      // creating a duplicate.
      const preexisting = oldestNamed(yield* listApps(accountId));

      // Create — or adopt the app left over from a previous run (apps can
      // never be deleted, so adoption-by-name is the designed behavior).
      const app = yield* stack.deploy(
        Cloudflare.RealtimeKit.App("App", { name: APP_NAME }),
      );

      expect(app.appId).toBeTruthy();
      expect(app.accountId).toEqual(accountId);
      expect(app.name).toEqual(APP_NAME);
      if (preexisting) {
        expect(app.appId).toEqual(preexisting.id);
      }

      // Out-of-band verification via the distilled API.
      const live = (yield* listApps(accountId)).find(
        (a) => a?.id === app.appId,
      );
      expect(live?.name).toEqual(APP_NAME);

      // Re-deploy is a no-op update — same app, same id.
      const again = yield* stack.deploy(
        Cloudflare.RealtimeKit.App("App", { name: APP_NAME }),
      );
      expect(again.appId).toEqual(app.appId);

      // Destroy only forgets the app from state (no delete API) — the app
      // must still exist on the account afterwards.
      yield* stack.destroy();
      const after = (yield* listApps(accountId)).find(
        (a) => a?.id === app.appId,
      );
      expect(after?.id).toEqual(app.appId);

      // A fresh deploy after destroy adopts by name instead of creating a
      // duplicate — deterministically the oldest same-named app (which may
      // predate the one this run touched if duplicates leaked before
      // adoption-by-name existed).
      const expectedAdoptee = oldestNamed(yield* listApps(accountId));
      const adopted = yield* stack.deploy(
        Cloudflare.RealtimeKit.App("App", { name: APP_NAME }),
      );
      expect(adopted.appId).toEqual(expectedAdoptee?.id);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed RealtimeKit app",
  (stack) =>
    Effect.gen(function* () {
      const entitled = yield* probeEntitlement;
      if (!entitled) {
        // RealtimeKit beta is entitlement-gated: an unentitled account gets the
        // typed `Forbidden` (403) on `getApp`, which `list()` propagates. Skip
        // the live assertion; the probe test above pins the typed tag.
        yield* Effect.logInfo(
          "account is not RealtimeKit-entitled; skipping list",
        );
        return;
      }

      yield* stack.destroy();

      // Create — or adopt the same-named app left over from a previous run
      // (apps can never be deleted, so adoption-by-name is the designed
      // behavior).
      const deployed = yield* stack.deploy(
        Cloudflare.RealtimeKit.App("App", { name: APP_NAME }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.RealtimeKit.App);
      const all = yield* provider.list();

      expect(all.some((a) => a.appId === deployed.appId)).toBe(true);
      const found = all.find((a) => a.appId === deployed.appId);
      expect(found?.name).toEqual(APP_NAME);
      expect(found?.accountId).toEqual(deployed.accountId);

      // Destroy only forgets the app (no delete API) — it still exists, so a
      // subsequent list() would still observe it. That's the expected residue.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
