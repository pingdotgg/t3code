import { CredentialsFromEnv } from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Alchemy from "@/index.ts";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { RailwayRetryPolicy } from "@/Railway/RetryPolicy.ts";
import { suitePartition } from "./suiteProject.ts";
import { waitUntilVolumeGone } from "./waitUntilVolumeGone.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import MongoApi, { Db, Site } from "./fixtures/mongo-api.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Railway.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const distilled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        RailwayRetryPolicy,
        CredentialsFromEnv,
        FetchHttpClient.layer,
      ),
    ),
  );

const ping = (url: string) =>
  Railway.pingMongo(url).pipe(
    // A fresh Mongo behind a freshly created TCP proxy can take minutes to
    // accept connections under full-suite load (cold volume init + proxy
    // port propagation). Keep retrying, bounded to ~4 minutes.
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
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

const readServiceVariables = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway
    .variables({
      projectId,
      environmentId,
      serviceId,
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const waitUntilServiceGone = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) =>
      service.deletedAt != null ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

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

const FixtureStack = Alchemy.Stack(
  "RailwayMongoFixture",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Site;
    const db = yield* Db;
    const api = yield* MongoApi;
    return {
      projectId: project.projectId,
      environmentId: db.environmentId,
      serviceId: api.serviceId,
      url: api.url,
      publicConnectionUri: db.publicConnectionUri,
      mode: "effect" as const,
    };
  }),
);

const fixture = beforeAll(deploy(FixtureStack), {
  timeout: 3_600_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(FixtureStack), {
  timeout: 3_600_000,
});

test.provider(
  "create, ping, update, list, and delete mongo",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const db = yield* Railway.mongo("Db", { project, environment });
          return { project, environment, db };
        }),
      );

      expect(created.db.serviceId).toEqual(expect.any(String));
      expect(created.db.serviceId.length).toBeGreaterThan(0);
      expect(created.db.projectId).toEqual(created.project.projectId);
      expect(created.db.environmentId).toEqual(
        created.environment.environmentId,
      );
      expect(created.db.name).toEqual(expect.any(String));
      expect(created.db.name.length).toBeGreaterThan(0);
      expect(created.db.name.length).toBeLessThanOrEqual(32);
      expect(created.db.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.db.user).toEqual("mongo");
      expect(created.db.database).toEqual("railway");
      expect(created.db.volumeId.length).toBeGreaterThan(0);
      expect(created.db.volumeInstanceId.length).toBeGreaterThan(0);
      expect(created.db.tcpProxyId).toEqual(expect.any(String));
      expect(created.db.tcpProxyDomain).toEqual(expect.any(String));
      expect(created.db.tcpProxyDomain).toContain("proxy.rlwy.net");
      expect(created.db.tcpProxyPort).toEqual(expect.any(Number));
      expect(created.db.tcpProxyPort).toBeGreaterThan(0);
      expect(
        created.db.connectionUri.includes(
          `${created.db.name}.railway.internal`,
        ),
      ).toEqual(true);
      expect(
        created.db.publicConnectionUri.includes(created.db.tcpProxyDomain!),
      ).toEqual(true);

      const fetched = yield* railway.service({ id: created.db.serviceId });
      expect(fetched.id).toEqual(created.db.serviceId);
      expect(fetched.name).toEqual(created.db.name);
      expect(fetched.projectId).toEqual(created.db.projectId);
      expect(fetched.deletedAt).toBeNull();

      const instance = yield* railway.serviceInstance({
        environmentId: created.db.environmentId,
        serviceId: created.db.serviceId,
      });
      expect(instance.serviceId).toEqual(created.db.serviceId);
      expect(instance.source?.image).toEqual(expect.stringContaining("mongo"));
      expect(instance.startCommand ?? "").toContain("--ipv6");
      expect(instance.startCommand ?? "").toContain("bind_ip");

      const volume = yield* railway.volumeInstance({
        id: created.db.volumeInstanceId,
      });
      expect(volume.id).toEqual(created.db.volumeInstanceId);
      expect(volume.volumeId).toEqual(created.db.volumeId);
      expect(volume.mountPath).toEqual("/data/db");
      expect(volume.serviceId).toEqual(created.db.serviceId);

      const proxies = yield* railway.tcpProxies({
        environmentId: created.db.environmentId,
        serviceId: created.db.serviceId,
      });
      const liveProxy = proxies.find(
        (proxy) => proxy.deletedAt == null && proxy.syncStatus !== "DELETED",
      );
      expect(liveProxy).toBeDefined();
      expect(liveProxy?.id).toEqual(created.db.tcpProxyId);
      expect(liveProxy?.applicationPort).toEqual(27017);

      const vars = yield* readServiceVariables(
        created.db.projectId,
        created.db.environmentId,
        created.db.serviceId,
      );
      expect(vars.MONGO_INITDB_ROOT_USERNAME).toEqual("mongo");
      expect((vars.MONGO_INITDB_ROOT_PASSWORD ?? "").length).toBeGreaterThan(0);
      expect(vars[Railway.MONGO_URL_SECRET] ?? "").toContain(
        "mongodb://${{MONGO_INITDB_ROOT_USERNAME}}",
      );
      expect(vars.MONGOHOST).toEqual("${{RAILWAY_PRIVATE_DOMAIN}}");
      expect(vars.MONGOPORT).toEqual("27017");

      const provider = yield* Provider.findProvider(Railway.Mongo);
      const listed = yield* provider.list();
      const found = listed.find(
        (row) => row.serviceId === created.db.serviceId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.db.name);
      expect(found?.projectId).toEqual(created.db.projectId);

      const pong = yield* ping(created.db.publicConnectionUri);
      expect(pong.ok).toEqual(1);

      const nextName =
        created.db.name.slice(0, -1) +
        (created.db.name.endsWith("z") ? "y" : "z");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { project, environment } = yield* suitePartition;
          const db = yield* Railway.mongo("Db", {
            project,
            environment,
            name: nextName,
          });
          return { project, environment, db };
        }),
      );

      expect(updated.db.serviceId).toEqual(created.db.serviceId);
      expect(updated.db.name).toEqual(nextName);
      expect(updated.db.projectId).toEqual(created.db.projectId);
      expect(updated.db.volumeId).toEqual(created.db.volumeId);
      expect(
        updated.db.connectionUri.includes(`${nextName}.railway.internal`),
      ).toEqual(true);

      const fetchedUpdate = yield* railway.service({
        id: updated.db.serviceId,
      });
      expect(fetchedUpdate.id).toEqual(updated.db.serviceId);
      expect(fetchedUpdate.name).toEqual(nextName);

      const pongUpdate = yield* ping(updated.db.publicConnectionUri);
      expect(pongUpdate.ok).toEqual(1);

      yield* stack.destroy();

      const gone = yield* waitUntilServiceGone(created.db.serviceId);
      expect(gone).toEqual("gone");
      const volumeGone = yield* waitUntilVolumeGone(
        created.db.volumeInstanceId,
      );
      expect(volumeGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 3_600_000 },
);

test(
  "a Service connects and pings through ConnectMongo",
  Effect.gen(function* () {
    const out = yield* fixture;
    expect(out.serviceId).toEqual(expect.any(String));
    expect(out.serviceId.length).toBeGreaterThan(0);
    expect(out.url).toEqual(expect.any(String));
    expect(out.url).toContain("up.railway.app");

    const fetched = yield* distilled(railway.service({ id: out.serviceId }));
    expect(fetched.id).toEqual(out.serviceId);
    expect(fetched.deletedAt).toBeNull();

    const vars = yield* distilled(
      readServiceVariables(out.projectId, out.environmentId, out.serviceId),
    );
    expect((vars[Railway.MONGO_URL_SECRET] ?? "").length).toBeGreaterThan(0);

    const client = yield* HttpClient.HttpClient;
    const get = (path: string) =>
      client.get(`${out.url}${path}`).pipe(
        Effect.timeoutOrElse({
          duration: "8 seconds",
          orElse: () => Effect.fail(new NotReady({ status: 0 })),
        }),
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json.pipe(
                Effect.mapError(() => new NotReady({ status: res.status })),
              )
            : Effect.fail(new NotReady({ status: res.status })),
        ),
        Effect.retry({
          while: (e) =>
            e._tag === "NotReady" &&
            (e.status === 0 ||
              e.status === 404 ||
              e.status === 502 ||
              e.status === 503),
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
          ? res.text.pipe(
              Effect.mapError(() => new NotReady({ status: res.status })),
            )
          : Effect.fail(new NotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e) =>
          e._tag === "NotReady" &&
          (e.status === 0 ||
            e.status === 404 ||
            e.status === 502 ||
            e.status === 503),
        schedule: Schedule.exponential("500 millis").pipe(
          Schedule.upTo({ duration: "45 seconds" }),
        ),
        times: 10,
      }),
    );

    if (out.mode === "effect") {
      const pingBody = (yield* get("/ping")) as { ok?: boolean };
      expect(pingBody.ok).toEqual(true);

      const health = (yield* get("/health")) as { ok?: number };
      expect(health.ok).toEqual(1);
    } else {
      const body = yield* getText;
      expect(typeof body).toEqual("string");
      expect(body.length).toBeGreaterThan(0);
    }

    const pong = yield* ping(out.publicConnectionUri);
    expect(pong.ok).toEqual(1);
  }).pipe(logLevel),
  { timeout: 3_600_000 },
);
