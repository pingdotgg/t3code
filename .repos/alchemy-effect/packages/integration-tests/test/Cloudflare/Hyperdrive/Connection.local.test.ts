import { CloudflareEnvironment } from "@alchemy.run/cloudflare";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { HyperdriveDevOriginUnsupported } from "@alchemy.run/cloudflare/Hyperdrive";
import * as Neon from "@alchemy.run/neon";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import HyperdriveLocalWorker, { LocalHyperdrive } from "./fixtures/local-worker.ts";
import { outOfBandConfig } from "./fixtures/lookup-config.ts";
import HyperdriveLookupLocalWorker, {
  LocalLookupHyperdrive,
} from "./fixtures/lookup-local-worker.ts";
import { lookupConfigName } from "./fixtures/lookup.ts";
import HyperdriveRemoteWorker, { RemoteHyperdrive } from "./fixtures/remote-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command. Neon has
// a single (mode-agnostic) provider, so the Postgres origin is always real.
const { test } = Test.make({
  providers: Layer.merge(Cloudflare.providers(), Neon.providers()),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {
  override get message() {
    return `worker answered ${this.status}: ${this.body.slice(0, 500)}`;
  }
}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new WorkerNotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        // Cap the backoff: an uncapped exponential over 10 recurs sums to
        // ~8.5 minutes and turns a persistent non-200 into an apparent hang.
        schedule: Schedule.max([
          Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

type QueryBody = {
  row: { sum: number; db: string };
  host: string;
};

/**
 * Under `alchemy dev` the Hyperdrive Connection is emulated by the local
 * provider: reconcile mints a `dev:` id with no cloud API call, and the
 * worker's `hyperdrive` binding is lowered onto the local runtime's origin
 * passthrough pointed at the `dev` origin (a real Neon Postgres). Running
 * SQL through the binding proves the whole local loop.
 */
test.provider(
  "Hyperdrive binding round-trips SQL through the local passthrough",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("HyperdriveLocalProject");
          const connection = yield* LocalHyperdrive;
          const worker = yield* HyperdriveLocalWorker;
          return { project, connection, worker };
        }),
      );

      // The local provider fabricates a `dev:` id — proof no cloud call
      // ran — and the worker serves from the local dev proxy.
      expect(deployed.connection.hyperdriveId).toMatch(/^dev:/);
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const body = (yield* getJsonReady(`${deployed.worker.url}/query`)) as QueryBody;
      expect(body.row.sum).toBe(2);
      // The query really ran against the dev origin's database.
      expect(body.row.db).toBe(deployed.project.databaseName);
      // The runtime binding passes through to the dev origin host.
      expect(body.host).toBe(deployed.project.origin.host);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
    timeout: 180_000,
  },
);

/**
 * `Alchemy.remote()` opts the Connection OUT of local emulation: even under
 * `alchemy dev` the live provider creates a real Hyperdrive config on
 * Cloudflare (a real UUID id), the locally-served worker still round-trips
 * SQL, and destroy deletes the real config (its state row is stamped live,
 * so the live provider handles the delete even in a dev run).
 */
test.provider(
  "Alchemy.remote() connection runs live in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Neon.Project("HyperdriveRemoteProject");
          const connection = yield* RemoteHyperdrive;
          const worker = yield* HyperdriveRemoteWorker;
          return { project, connection, worker };
        }),
      );

      // A real Cloudflare id — the live provider created it.
      expect(deployed.connection.hyperdriveId).not.toMatch(/^dev:/);

      // Out-of-band: the config exists on real Cloudflare and fronts the
      // Neon origin.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const config = yield* hyperdrive.getConfig({
        accountId,
        hyperdriveId: deployed.connection.hyperdriveId,
      });
      expect(config.id).toBe(deployed.connection.hyperdriveId);
      expect("host" in config.origin ? config.origin.host : undefined).toBe(
        deployed.project.origin.host,
      );

      // The locally-served worker's binding still round-trips SQL.
      const body = (yield* getJsonReady(`${deployed.worker.url}/query`)) as QueryBody;
      expect(body.row.sum).toBe(2);
      expect(body.row.db).toBe(deployed.project.databaseName);

      yield* stack.destroy();

      // Destroy deleted the real config (stamped live mode).
      const gone = yield* hyperdrive
        .getConfig({
          accountId,
          hyperdriveId: deployed.connection.hyperdriveId,
        })
        .pipe(
          Effect.as(false),
          Effect.catchTag("HyperdriveConfigNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
    timeout: 180_000,
  },
);

/**
 * `Hyperdrive.lookup` reads the real configuration from Cloudflare even in
 * dev (it is not a resource, so there is nothing to emulate), while the
 * locally-served Worker's binding passes through to the lookup's `dev`
 * origin. Destroy leaves the configuration in place.
 */
test.provider(
  "lookup with a dev origin round-trips SQL through the local passthrough",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const project = yield* stack.deploy(Neon.Project("HyperdriveLookupLocalProject"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const created = yield* outOfBandConfig(
            accountId,
            lookupConfigName("local"),
            project.origin,
          );

          const { effectWorker, asyncWorker } = yield* stack.deploy(
            Effect.gen(function* () {
              yield* Neon.Project("HyperdriveLookupLocalProject");
              // Through `Cloudflare.Hyperdrive.Connect`.
              const effectWorker = yield* HyperdriveLookupLocalWorker;
              // Through `env`.
              const asyncWorker = yield* Cloudflare.Worker("HyperdriveLookupLocalAsyncWorker", {
                main: pathe.resolve(import.meta.dirname, "fixtures/lookup-async-worker.ts"),
                env: { HD: LocalLookupHyperdrive },
              });
              return { effectWorker, asyncWorker };
            }),
          );

          for (const url of [`${effectWorker.url}/query`, asyncWorker.url!]) {
            expect(url).toMatch(/^http:\/\/localhost:\d+/);
            const body = (yield* getJsonReady(url)) as QueryBody;
            expect(body.row.sum).toBe(2);
            expect(body.row.db).toBe(project.databaseName);
            expect(body.host).toBe(project.origin.host);
          }

          yield* stack.destroy();

          const survived = yield* hyperdrive.getConfig({ accountId, hyperdriveId: created.id });
          expect(survived.id).toBe(created.id);
        }),
      );
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
    timeout: 180_000,
  },
);

/**
 * A looked-up configuration's origin password is never returned by the API,
 * so a dev run binding a lookup without a `dev` origin must die with the
 * typed `HyperdriveDevOriginUnsupported` defect. The lookup itself must
 * resolve first, so it targets a real out-of-band configuration.
 */
test.provider(
  "lookup without a dev origin dies with HyperdriveDevOriginUnsupported",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const project = yield* stack.deploy(Neon.Project("HyperdriveLookupLocalProject"));

      const defect = yield* Effect.scoped(
        Effect.gen(function* () {
          const created = yield* outOfBandConfig(
            accountId,
            `${lookupConfigName("local")}-nodev`,
            project.origin,
          );
          return yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* Neon.Project("HyperdriveLookupLocalProject");
                return yield* Cloudflare.Worker("HyperdriveLookupNoDevWorker", {
                  main: pathe.resolve(import.meta.dirname, "fixtures/vpc-async-worker.ts"),
                  env: {
                    HD: Cloudflare.Hyperdrive.lookup("HyperdriveLookupNoDev", {
                      hyperdriveId: created.id,
                    }),
                  },
                });
              }),
            )
            .pipe(
              Effect.flatMap(() => Effect.die(new Error("expected the dev deploy to die"))),
              Effect.catchDefect((defect) => Effect.succeed(defect)),
            );
        }),
      );

      expect(defect).toBeInstanceOf(HyperdriveDevOriginUnsupported);
      expect(defect).toMatchObject({
        _tag: "HyperdriveDevOriginUnsupported",
        logicalId: "HyperdriveLookupNoDev",
        origin: "lookup",
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
    timeout: 180_000,
  },
);

/**
 * A Workers VPC origin is only reachable from Cloudflare's network, so a dev
 * run binding it without a `dev` override must die with the typed
 * `HyperdriveDevOriginUnsupported` defect instead of starting a Worker that
 * can never connect.
 */
test.provider(
  "VPC Service origin without a dev override dies with HyperdriveDevOriginUnsupported",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const defect = yield* stack
        .deploy(
          Effect.gen(function* () {
            const connection = yield* Cloudflare.Hyperdrive.Connection(
              "HyperdriveVpcDevConnection",
              {
                origin: {
                  scheme: "postgres",
                  serviceId: "00000000-0000-4000-8000-000000000000",
                  database: "postgres",
                  user: "postgres",
                  password: Redacted.make("unused"),
                },
              },
            );
            return yield* Cloudflare.Worker("HyperdriveVpcDevWorker", {
              main: pathe.resolve(import.meta.dirname, "fixtures/vpc-async-worker.ts"),
              env: { HD: connection },
            });
          }),
        )
        .pipe(
          Effect.flatMap(() => Effect.die(new Error("expected the dev deploy to die"))),
          Effect.catchDefect((defect) => Effect.succeed(defect)),
        );

      expect(defect).toBeInstanceOf(HyperdriveDevOriginUnsupported);
      expect(defect).toMatchObject({
        _tag: "HyperdriveDevOriginUnsupported",
        logicalId: "HyperdriveVpcDevConnection",
        origin: "vpc",
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:hyperdrive",
      "provider:cloudflare:worker",
      "local",
    ],
    timeout: 120_000,
  },
);
