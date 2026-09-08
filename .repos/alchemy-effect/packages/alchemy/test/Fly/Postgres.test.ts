import * as machines from "@distilled.cloud/fly-io/machines";
import * as mpg from "@distilled.cloud/fly-io/mpg";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import PostgresApi, { Db, MpgIp, MpgSite } from "./fixtures/postgres-api.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilClusterGone = (clusterId: string) =>
  mpg.getClusterById({ id: clusterId }).pipe(
    Effect.map((res) =>
      res.data === undefined || res.data.status === "deleted"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilReady = (clusterId: string) =>
  mpg.getClusterById({ id: clusterId }).pipe(
    Effect.map((res) => res.data?.status),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "ready" || status === "error",
      times: 24,
    }),
  );

const waitUntilAppGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const secretNames = (appName: string) =>
  machines
    .listSecrets({
      app_name: appName,
      show_secrets: false,
    })
    .pipe(
      Effect.map((res) => (res.secrets ?? []).map((secret) => secret.name)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as Array<string | undefined>),
      ),
    );

test.provider(
  "createCluster with an invalid region is a typed BadRequest",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const orgSlug = yield* Fly.currentOrgSlug();
      const error = yield* mpg
        .createCluster({
          org_slug: orgSlug,
          name: "alchemy-mpg-invalid-region",
          region: "not-a-region",
          plan: "basic",
          storage_in_gb: 10,
        })
        .pipe(Effect.flip);

      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toEqual("region is invalid");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider(
  "create, attach, list, and destroy a managed postgres cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("MpgSite");
          const db = yield* Fly.Postgres("Db", {
            region: "iad",
            plan: "basic",
            volumeSizeGb: 10,
          });
          return { app, db };
        }),
      );

      expect(created.db.clusterId).toEqual(expect.any(String));
      expect(created.db.clusterId.length).toBeGreaterThan(0);
      expect(created.db.name).toEqual(expect.any(String));
      expect(created.db.region).toEqual("iad");
      expect(created.db.plan).toEqual("basic");

      const status = yield* waitUntilReady(created.db.clusterId);
      expect(status).toEqual("ready");

      const fetched = yield* mpg.getClusterById({
        id: created.db.clusterId,
      });
      expect(fetched.data?.id).toEqual(created.db.clusterId);
      expect(fetched.data?.name).toEqual(created.db.name);
      expect(fetched.data?.region).toEqual("iad");
      expect(fetched.data?.status).toEqual("ready");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("MpgSite");
          const db = yield* Fly.Postgres("Db", {
            region: "iad",
            plan: "basic",
            volumeSizeGb: 10,
          });
          return { app, db };
        }),
      );
      expect(updated.db.clusterId).toEqual(created.db.clusterId);
      expect(updated.db.name).toEqual(created.db.name);
      expect(created.db.pooledConnectionUri.length).toBeGreaterThan(0);

      const provider = yield* Provider.findProvider(Fly.Postgres);
      const all = yield* provider.list();
      const listed = all.find((row) => row.clusterId === created.db.clusterId);
      expect(listed).toBeDefined();
      expect(listed?.name).toEqual(created.db.name);
      expect(listed?.region).toEqual("iad");

      yield* stack.destroy();

      const clusterGone = yield* waitUntilClusterGone(created.db.clusterId);
      expect(clusterGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(created.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "a Service connects and SELECTs through ConnectPostgres",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* MpgSite;
          const db = yield* Db;
          const ip = yield* MpgIp;
          const api = yield* PostgresApi;
          return { app, db, ip, api };
        }),
      );

      expect(deployed.db.clusterId).toEqual(expect.any(String));
      expect(deployed.api.url).toEqual(
        `https://${deployed.app.appName}.fly.dev`,
      );

      const names = yield* secretNames(deployed.app.appName);
      expect(names).toContain("DATABASE_URL");

      yield* Effect.logInfo("ConnectPostgres deployed", {
        url: deployed.api.url,
        machineId: deployed.api.machineId,
        state: deployed.api.state,
      });

      class NotReady extends Data.TaggedError("NotReady")<{
        status: number;
        body?: unknown;
      }> {
        override get message() {
          return this.body === undefined
            ? `status ${this.status}`
            : `status ${this.status}: ${JSON.stringify(this.body)}`;
        }
      }

      const diagnose = Effect.gen(function* () {
        const appName = deployed.api.appName;
        const machineId = deployed.api.machineId;
        const machine = yield* machines.getMachine({
          app_name: appName,
          machine_id: machineId,
        });
        const events = yield* machines.listMachineEvents({
          app_name: appName,
          machine_id: machineId,
          limit: 20,
        });
        const listed = yield* machines.listMachineProcesses({
          app_name: appName,
          machine_id: machineId,
        });
        const processes = (Array.isArray(listed) ? listed : []).filter(
          (proc) => typeof proc.command === "string" && proc.command.length > 0,
        );
        const ips = yield* machines.listAppIPAssignments({
          app_name: appName,
        });
        const exec = yield* machines
          .execMachine({
            app_name: appName,
            machine_id: machineId,
            command: [
              "bun",
              "-e",
              "const r = await fetch('http://127.0.0.1:3000/ping'); console.log(r.status, await r.text())",
            ],
            timeout: 10,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({
                stdout: undefined,
                stderr: String(cause),
                exit_code: -1,
              }),
            ),
          );
        yield* Effect.logError("ConnectPostgres HTTP diagnose", {
          state: machine.state,
          checks: machine.checks,
          events,
          processes,
          ips,
          exec,
        });
      }).pipe(Effect.ignore);

      const getJson = (path: string) =>
        Effect.tryPromise({
          try: async () => {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 8_000);
            try {
              const res = await fetch(`${deployed.api.url}${path}`, {
                signal: ac.signal,
              });
              const body = (await res.json().catch(() => ({
                status: res.status,
              }))) as {
                ok?: boolean;
                error?: unknown;
                status?: number;
                rows?: unknown;
              };
              return { status: res.status, body };
            } finally {
              clearTimeout(timer);
            }
          },
          catch: () => new NotReady({ status: 0 }),
        }).pipe(
          Effect.flatMap((res) =>
            res.status === 200
              ? Effect.succeed(res.body)
              : Effect.fail(
                  new NotReady({ status: res.status, body: res.body }),
                ),
          ),
          Effect.retry({
            while: (e) =>
              e._tag === "NotReady" &&
              (e.status === 0 ||
                e.status === 404 ||
                e.status === 502 ||
                e.status === 503),
            schedule: Schedule.spaced("3 seconds"),
            times: 12,
          }),
          Effect.tapError(() => diagnose),
        );

      const ping = yield* getJson("/ping");
      expect(ping.ok).toEqual(true);

      const health = yield* getJson("/health");
      const executed = health.rows as unknown;
      const list = Array.isArray(executed)
        ? executed
        : executed !== null &&
            typeof executed === "object" &&
            Array.isArray((executed as { rows?: unknown }).rows)
          ? (executed as { rows: unknown[] }).rows
          : [];
      const first = list[0] as { ok?: unknown } | undefined;
      expect(Number(first?.ok)).toEqual(1);

      yield* stack.destroy();

      const clusterGone = yield* waitUntilClusterGone(deployed.db.clusterId);
      expect(clusterGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(deployed.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 300_000 },
);
