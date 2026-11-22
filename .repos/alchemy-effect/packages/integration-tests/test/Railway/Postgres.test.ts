import * as Drizzle from "@alchemy.run/drizzle/Postgres";
import * as Railway from "@alchemy.run/railway";
import { RailwayAuth } from "@alchemy.run/railway/AuthProvider";
import { fromAuthProvider } from "@alchemy.run/railway/Credentials";
import { resolveConnectionOptions } from "@alchemy.run/sql/PostgresTls";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Query } from "@distilled.cloud/core/query";
import { GraphQLLive, Railway as RailwayApi } from "@distilled.cloud/railway";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { PostgresFn } from "./fixtures/async-postgres-fn.ts";
import PostgresApi, { Db, Site } from "./fixtures/postgres-api.ts";
import { suitePartition } from "./suiteProject.ts";
import { waitUntilVolumeGone } from "./waitUntilVolumeGone.ts";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const distilled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(Layer.merge(GraphQLLive, fromAuthProvider().pipe(Layer.provide(RailwayAuth)))),
  );

const firstOk = (rows: unknown): unknown => {
  if (!Array.isArray(rows) || rows[0] == null || typeof rows[0] !== "object") {
    return undefined;
  }
  return (rows[0] as { ok?: unknown }).ok;
};

const selectOne = Effect.fn(
  function* (_url: string) {
    const sql = yield* PgClient.PgClient;
    return yield* sql`select 1 as ok`;
  },
  (effect, url) =>
    effect.pipe(
      Effect.provide(
        PgClient.layer({
          ...resolveConnectionOptions(Redacted.make(url), { rejectUnauthorized: false }),
          // Bound each attempt so the retry schedule (not a hung socket) owns
          // the readiness budget.
          connectTimeout: "10 seconds",
        }),
      ),
      // Allow the new database and TCP proxy to become ready. Ten retries
      // bound backoff to 50 seconds; each connection attempt also has a timeout.
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 10 }),
    ),
);

const readVariables = Query.fn((projectId: string, environmentId: string, serviceId: string) =>
  RailwayApi.variables({ projectId, environmentId, serviceId, unrendered: true }),
);

const readServiceDeletedAt = Query.fn((id: string) => ({
  deletedAt: RailwayApi.service({ id }).deletedAt,
}));

const readService = Query.fn((id: string) => {
  const service = RailwayApi.service({ id });
  return {
    id: service.id,
    name: service.name,
    projectId: service.projectId,
    deletedAt: service.deletedAt,
  };
});

const readServiceInstance = Query.fn((environmentId: string, serviceId: string) => {
  const instance = RailwayApi.serviceInstance({ environmentId, serviceId });
  return { serviceId: instance.serviceId, image: instance.source.image };
});

const readVolumeInstance = Query.fn((id: string) => {
  const volume = RailwayApi.volumeInstance({ id });
  return {
    id: volume.id,
    volumeId: volume.volumeId,
    mountPath: volume.mountPath,
    serviceId: volume.serviceId,
  };
});

const readTcpProxies = Query.fn((environmentId: string, serviceId: string) =>
  RailwayApi.tcpProxies({ environmentId, serviceId }).pipe(
    Query.map((proxy) => ({
      id: proxy.id,
      domain: proxy.domain,
      proxyPort: proxy.proxyPort,
      applicationPort: proxy.applicationPort,
      deletedAt: proxy.deletedAt,
      syncStatus: proxy.syncStatus,
    })),
  ),
);

const asVariableMap = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
};

const readServiceVariables = (projectId: string, environmentId: string, serviceId: string) =>
  readVariables(projectId, environmentId, serviceId).pipe(
    Effect.map(asVariableMap),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed({} as Record<string, string>)),
  );

const waitUntilServiceGone = (serviceId: string) =>
  readServiceDeletedAt(serviceId).pipe(
    Effect.map((service) => (service.deletedAt != null ? ("gone" as const) : ("found" as const))),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body?: unknown }> {
  override get message() {
    return this.body === undefined
      ? `status ${this.status}`
      : `status ${this.status}: ${JSON.stringify(this.body)}`;
  }
}

// Deploy the database first, then extend the same stack with its clients.
// Each setup phase gets its own bounded budget; a remote image build no
// longer shares its deadline with database and volume provisioning.
const DatabaseFixtureStack = Alchemy.Stack(
  "RailwayPostgresFixture",
  { providers: Railway.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    return yield* Db;
  }),
);

const FixtureStack = Alchemy.Stack(
  "RailwayPostgresFixture",
  { providers: Railway.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const project = yield* Site;
    const db = yield* Db;
    const api = yield* PostgresApi;
    const fn = yield* PostgresFn;
    return {
      projectId: project.projectId,
      environmentId: db.environmentId,
      serviceId: api.serviceId,
      url: api.url,
      publicConnectionUri: db.publicConnectionUri,
      functionId: fn.serviceId,
      functionUrl: fn.url,
      mode: "effect" as const,
    };
  }),
);

test.provider(
  "create, select 1, update, list, and delete postgres",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const db = yield* Railway.Postgres("Db", { project, environment });
          return { project, environment, db };
        }),
      );

      expect(created.db.serviceId).toEqual(expect.any(String));
      expect(created.db.serviceId.length).toBeGreaterThan(0);
      expect(created.db.projectId).toEqual(created.project.projectId);
      expect(created.db.environmentId).toEqual(created.environment.environmentId);
      expect(created.db.name).toEqual(expect.any(String));
      expect(created.db.name.length).toBeGreaterThan(0);
      expect(created.db.name.length).toBeLessThanOrEqual(32);
      expect(created.db.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.db.user).toEqual("postgres");
      expect(created.db.database).toEqual("railway");
      expect(created.db.volumeId.length).toBeGreaterThan(0);
      expect(created.db.volumeInstanceId.length).toBeGreaterThan(0);
      expect(created.db.tcpProxyId).toEqual(expect.any(String));
      expect(created.db.tcpProxyDomain).toEqual(expect.any(String));
      expect(created.db.tcpProxyDomain).toContain("proxy.rlwy.net");
      expect(created.db.tcpProxyPort).toEqual(expect.any(Number));
      expect(created.db.tcpProxyPort).toBeGreaterThan(0);
      expect(created.db.connectionUri.includes(`${created.db.name}.railway.internal`)).toEqual(
        true,
      );
      expect(created.db.publicConnectionUri.includes(created.db.tcpProxyDomain!)).toEqual(true);

      const fetched = yield* readService(created.db.serviceId);
      expect(fetched.id).toEqual(created.db.serviceId);
      expect(fetched.name).toEqual(created.db.name);
      expect(fetched.projectId).toEqual(created.db.projectId);
      expect(fetched.deletedAt).toBeNull();

      const instance = yield* readServiceInstance(created.db.environmentId, created.db.serviceId);
      expect(instance.serviceId).toEqual(created.db.serviceId);
      expect(instance.image).toEqual(expect.stringContaining("postgres-ssl"));

      const volume = yield* readVolumeInstance(created.db.volumeInstanceId);
      expect(volume.id).toEqual(created.db.volumeInstanceId);
      expect(volume.volumeId).toEqual(created.db.volumeId);
      expect(volume.mountPath).toEqual("/var/lib/postgresql/data");
      expect(volume.serviceId).toEqual(created.db.serviceId);

      const proxies = yield* readTcpProxies(created.db.environmentId, created.db.serviceId);
      const liveProxy = proxies.find(
        (proxy) => proxy.deletedAt == null && proxy.syncStatus !== "DELETED",
      );
      expect(liveProxy).toBeDefined();
      expect(liveProxy?.id).toEqual(created.db.tcpProxyId);
      expect(liveProxy?.applicationPort).toEqual(5432);

      const provider = yield* Provider.findProvider(Railway.Postgres);
      const listed = yield* provider.list();
      const found = listed.find((row) => row.serviceId === created.db.serviceId);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.db.name);
      expect(found?.projectId).toEqual(created.db.projectId);

      const rows = yield* selectOne(created.db.publicConnectionUri);
      expect(firstOk(rows)).toEqual(1);

      const nextName = created.db.name.slice(0, -1) + (created.db.name.endsWith("z") ? "y" : "z");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const db = yield* Railway.Postgres("Db", { project, environment, name: nextName });
          return { project, environment, db };
        }),
      );

      expect(updated.db.serviceId).toEqual(created.db.serviceId);
      expect(updated.db.name).toEqual(nextName);
      expect(updated.db.projectId).toEqual(created.db.projectId);
      expect(updated.db.volumeId).toEqual(created.db.volumeId);
      expect(updated.db.connectionUri.includes(`${nextName}.railway.internal`)).toEqual(true);

      const fetchedUpdate = yield* readService(updated.db.serviceId);
      expect(fetchedUpdate.id).toEqual(updated.db.serviceId);
      expect(fetchedUpdate.name).toEqual(nextName);

      yield* stack.destroy();

      const gone = yield* waitUntilServiceGone(created.db.serviceId);
      expect(gone).toEqual("gone");
      const volumeGone = yield* waitUntilVolumeGone(created.db.volumeInstanceId);
      expect(volumeGone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:railway",
      "provider:railway:postgres",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "provider:railway:service",
      "live",
    ],
    timeout: 120_000,
  },
);

// Runtime fixture failures must not prevent the independent resource lifecycle test.
describe(
  "ConnectPostgres runtime integrations",
  {
    tags: [
      "provider:railway",
      "provider:railway:function",
      "provider:railway:postgres",
      "provider:railway:project",
      "provider:railway:projectenvironment",
      "provider:railway:service",
      "provider:railway:variable",
      "live",
    ],
  },
  () => {
    const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
      providers: Railway.providers(),
    });

    beforeAll(deploy(DatabaseFixtureStack), { timeout: 120_000 });
    const fixture = beforeAll(deploy(FixtureStack), { timeout: 120_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(FixtureStack), { timeout: 120_000 });

    test(
      "a Service connects and SELECTs through ConnectPostgres",
      Effect.gen(function* () {
        const out = yield* fixture;
        expect(out.serviceId).toEqual(expect.any(String));
        expect(out.serviceId.length).toBeGreaterThan(0);
        expect(out.url).toEqual(expect.any(String));
        expect(out.url).toContain("up.railway.app");

        const fetched = yield* distilled(readService(out.serviceId));
        expect(fetched.id).toEqual(out.serviceId);
        expect(fetched.deletedAt).toBeNull();

        const vars = yield* distilled(
          readServiceVariables(out.projectId, out.environmentId, out.serviceId),
        );
        expect((vars[Railway.DATABASE_URL_SECRET] ?? "").length).toBeGreaterThan(0);

        const client = yield* HttpClient.HttpClient;
        const get = (path: string) =>
          client.get(`${out.url}${path}`).pipe(
            Effect.timeoutOrElse({
              duration: "8 seconds",
              orElse: () => Effect.fail(new NotReady({ status: 0 })),
            }),
            Effect.flatMap((res) =>
              res.status === 200
                ? res.json.pipe(Effect.mapError(() => new NotReady({ status: res.status })))
                : Effect.fail(new NotReady({ status: res.status })),
            ),
            Effect.retry({
              while: (e) =>
                e._tag === "NotReady" &&
                (e.status === 0 || e.status === 404 || e.status === 502 || e.status === 503),
              schedule: Schedule.exponential("500 millis").pipe(
                Schedule.upTo({ duration: "45 seconds" }),
              ),
              times: 10,
            }),
          );

        const getText = client.get(out.url!).pipe(
          Effect.timeoutOrElse({
            duration: "8 seconds",
            orElse: () => Effect.fail(new NotReady({ status: 0 })),
          }),
          Effect.flatMap((res) =>
            res.status === 200
              ? res.text.pipe(Effect.mapError(() => new NotReady({ status: res.status })))
              : Effect.fail(new NotReady({ status: res.status })),
          ),
          Effect.retry({
            while: (e) =>
              e._tag === "NotReady" &&
              (e.status === 0 || e.status === 404 || e.status === 502 || e.status === 503),
            schedule: Schedule.exponential("500 millis").pipe(
              Schedule.upTo({ duration: "45 seconds" }),
            ),
            times: 10,
          }),
        );

        if (out.mode === "effect") {
          const ping = (yield* get("/ping")) as { ok?: boolean };
          expect(ping.ok).toEqual(true);

          const health = (yield* get("/health")) as { rows?: unknown };
          expect(firstOk(health.rows)).toEqual(1);
        } else {
          // Public image fallback: docker push is impossible without a
          // registry. HTTP health is hashicorp/http-echo; SELECT 1 runs
          // over the public TCP proxy. ConnectPostgres still packed
          // DATABASE_URL onto the Service.
          const body = yield* getText;
          expect(typeof body).toEqual("string");
          expect(body.length).toBeGreaterThan(0);
        }

        const rows = yield* selectOne(out.publicConnectionUri);
        expect(firstOk(rows)).toEqual(1);
      }).pipe(logLevel),
      { timeout: 120_000 },
    );

    test(
      "an async Function SELECTs through env.DATABASE_URL",
      Effect.gen(function* () {
        const out = yield* fixture;
        expect(out.functionId).toEqual(expect.any(String));
        expect(out.functionUrl).toEqual(expect.any(String));
        expect(out.functionUrl).toContain("up.railway.app");

        const vars = yield* distilled(
          readServiceVariables(out.projectId, out.environmentId, out.functionId),
        );
        expect((vars[Railway.DATABASE_URL_SECRET] ?? "").length).toBeGreaterThan(0);

        const client = yield* HttpClient.HttpClient;
        const get = (path: string) =>
          client.get(`${out.functionUrl}${path}`).pipe(
            Effect.timeoutOrElse({
              duration: "8 seconds",
              orElse: () => Effect.fail(new NotReady({ status: 0 })),
            }),
            Effect.flatMap((res) =>
              res.status === 200
                ? res.json.pipe(Effect.mapError(() => new NotReady({ status: res.status })))
                : res.text.pipe(
                    Effect.catch(() => Effect.succeed("")),
                    Effect.flatMap((body) =>
                      Effect.fail(new NotReady({ status: res.status, body })),
                    ),
                  ),
            ),
            Effect.retry({
              while: (e) =>
                e._tag === "NotReady" &&
                (e.status === 0 || e.status === 404 || e.status === 502 || e.status === 503),
              schedule: Schedule.exponential("500 millis").pipe(
                Schedule.upTo({ duration: "45 seconds" }),
              ),
              times: 10,
            }),
          );

        const health = (yield* get("/")) as { rows?: unknown };
        expect(firstOk(health.rows)).toEqual(1);
      }).pipe(logLevel),
      { timeout: 120_000 },
    );
  },
);
