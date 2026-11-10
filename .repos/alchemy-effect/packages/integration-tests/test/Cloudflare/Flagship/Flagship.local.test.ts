import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as flagship from "@distilled.cloud/cloudflare/flagship";
import * as Alchemy from "alchemy";
import { Action } from "alchemy/Action";
import { poll } from "alchemy/Util/poll";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const main = pathe.resolve(import.meta.dirname, "fixtures/local-worker.ts");

interface Details {
  value: boolean;
  variant?: string;
  reason?: string;
  errorCode?: string;
}

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getDetails = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e) => e._tag === "WorkerNotReady",
        schedule: Schedule.max([
          Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return (yield* res.json) as unknown as Details;
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev` the App and Flag are emulated by the local providers
 * (`dev:` app id, no cloud API calls): the Flag's reconcile seeds its
 * definition into the local workerd Flagship simulator, and the worker's
 * `flagship` binding is lowered onto the local evaluator, so targeting
 * rules apply to the request's context. A flag update re-seeds the
 * definition and the running worker sees it on the next evaluation.
 */
test.provider(
  "flagship flags evaluate against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = "local-dark-mode";
      const deployAt = (enabled: boolean) =>
        Effect.gen(function* () {
          const app = yield* Cloudflare.Flagship.App("LocalFlags", {});
          const flag = yield* Cloudflare.Flagship.Flag("LocalDarkMode", {
            appId: app.appId,
            key,
            enabled,
            defaultVariation: "off",
            variations: { off: false, on: true },
            rules: [
              {
                priority: 1,
                conditions: [{ attribute: "country", operator: "equals", value: "US" }],
                serveVariation: "on",
              },
            ],
          });
          const worker = yield* Cloudflare.Worker("flagship-local-worker", {
            main,
            env: { FLAGS: app },
          });
          // Deploy-time reads go through the same local evaluator.
          const Read = Action(
            "ReadLocalFlag",
            Effect.gen(function* () {
              const flags = yield* Cloudflare.Flagship.ReadFlags(app);
              return Effect.fn(function* (input: { key: string }) {
                return {
                  us: yield* flags.getBooleanDetails(input.key, false, { country: "US" }),
                  ca: yield* flags.getBooleanValue(input.key, true, { country: "CA" }),
                };
              });
            }).pipe(Effect.provide(Cloudflare.Flagship.ReadFlagsLocal)),
          );
          // Taking the flag's key orders the read after the flag is written.
          const read = yield* Read({ key: flag.key });
          return { app, flag, worker, read };
        });

      const v1 = yield* stack.deploy(deployAt(true));

      // The local providers fabricate a `dev:` app id — proof no cloud call
      // ran — and the worker serves from the local dev proxy.
      expect(v1.app.appId).toMatch(/^dev:/);
      expect(v1.flag.appId).toBe(v1.app.appId);
      expect(v1.flag.type).toBe("boolean");
      expect(v1.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      expect(v1.read.us).toMatchObject({ value: true, variant: "on", reason: "TARGETING_MATCH" });
      expect(v1.read.ca).toBe(false);

      expect(yield* getDetails(`${v1.worker.url}/details?flag=${key}&country=US`)).toMatchObject({
        value: true,
        variant: "on",
        reason: "TARGETING_MATCH",
      });
      expect(yield* getDetails(`${v1.worker.url}/details?flag=${key}&country=CA`)).toMatchObject({
        value: false,
        reason: "DEFAULT",
      });
      expect(yield* getDetails(`${v1.worker.url}/details?flag=missing`)).toMatchObject({
        value: false,
        errorCode: "FLAG_NOT_FOUND",
      });

      // Disable the flag — same identity, re-seeded definition. The running
      // worker reads definitions per evaluation, so it sees the change
      // without a restart.
      const v2 = yield* stack.deploy(deployAt(false));
      expect(v2.app.appId).toBe(v1.app.appId);
      expect(yield* getDetails(`${v2.worker.url}/details?flag=${key}&country=US`)).toMatchObject({
        value: false,
        reason: "DISABLED",
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:flagship",
      "provider:cloudflare:worker",
      "local",
    ],
    timeout: 180_000,
  },
);

/**
 * `Alchemy.remote()` opts the App and Flag OUT of local emulation: even
 * under `alchemy dev` they are created on real Cloudflare (live providers)
 * and the worker's binding proxies to the live app remotely. Out-of-band
 * reads prove the flag landed in the real app, and destroy (driven by the
 * stamped `live` provider mode) removes both again.
 */
test.provider(
  "Alchemy.remote() flagship app runs live in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = "remote-dark-mode";
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Cloudflare.Flagship.App("RemoteFlags", {}).pipe(Alchemy.remote());
          const flag = yield* Cloudflare.Flagship.Flag("RemoteDarkMode", {
            appId: app.appId,
            key,
            defaultVariation: "on",
            variations: { off: false, on: true },
          }).pipe(Alchemy.remote());
          const worker = yield* Cloudflare.Worker("flagship-remote-worker", {
            main,
            env: { FLAGS: app },
          });
          return { app, flag, worker };
        }),
      );

      // Real (non-`dev:`) identity — the live providers ran.
      expect(deployed.app.appId).not.toMatch(/^dev:/);
      expect(deployed.flag.appId).toBe(deployed.app.appId);

      // The locally-served worker evaluates the live flag through the
      // remote-proxied binding; a fresh flag takes a moment to propagate.
      const details = yield* poll({
        description: "remote binding returns the live flag",
        effect: getDetails(`${deployed.worker.url}/details?flag=${key}`),
        predicate: (d) => d.value === true,
        schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(20)]),
      });
      expect(details.variant).toBe("on");

      // Out-of-band: the flag exists in the real app.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const live = yield* flagship.getAppFlag({
        accountId,
        appId: deployed.app.appId,
        flagKey: key,
      });
      expect(live.defaultVariation).toBe("on");

      yield* stack.destroy();

      const gone = yield* flagship.getApp({ accountId, appId: deployed.app.appId }).pipe(
        Effect.as(false),
        Effect.catchTag("FlagshipAppNotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:flagship",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 180_000,
  },
);
