/**
 * A Railway project that exercises every resource and binding:
 *
 * - `Site` — parent Project (`src/shared.ts`)
 * - `Staging` — extra Environment (production is on the Project)
 * - `Marker` — shared Variable the Api reads via `Config.string`
 * - `Disk` — Volume the Worker mounts with `MountVolume`
 * - `Db` — Postgres + `ConnectPostgres` / Drizzle
 * - `Mysql` — MySQL (same shape as Postgres)
 * - `DatabaseUrl` — `Railway.ref(Db, "DATABASE_URL")` template
 * - `Cache` — Redis + `ReadWriteRedis`
 * - `CacheProxy` — TcpProxy so Redis is reachable from a laptop
 * - `Data` — Bucket + Put/Get/Head/List/Delete
 * - `Echo` — image Service (`hashicorp/http-echo`, healthcheck)
 * - `Ping` — Effect HTTP Service (`src/ping.ts`) that
 *   `ConnectPostgres`s the same Db (Docker, not a canvas Function)
 * - `Cleanup` — canvas cron Function (`console.log("tick")`)
 * - `Api` — Effect HTTP Service (`src/api.ts`, healthcheck)
 * - `Worker` — Effect background Service that writes the volume
 *   (`src/worker.ts`)
 * - `Backend` — canvas Group around the data plane
 *
 * `VolumeBackup` is Pro-plan gated (`RailwayForbidden` on Hobby) and
 * omitted here; see `Railway.VolumeBackup` and the volumes hub page.
 *
 * Effect-native Services upload a generated Dockerfile; Railway
 * builds the image. No GHCR.
 *
 * CustomDomain needs a hostname you control. Pass
 * `RAILWAY_TEST_DOMAIN` to attach one to Api.
 */
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Echo } from "./src/echo.ts";
import Ping from "./src/ping.ts";
import {
  Cache,
  Cleanup,
  Data,
  DatabaseUrl,
  Db,
  Disk,
  Marker,
  Mysql,
  Site,
  Staging,
} from "./src/shared.ts";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "RailwayService",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const staging = yield* Staging;
    const marker = yield* Marker;
    const disk = yield* Disk;
    const db = yield* Db;
    const mysql = yield* Mysql;
    const databaseUrl = yield* DatabaseUrl;
    const cache = yield* Cache;
    const cacheProxy = yield* Railway.TcpProxy("CacheProxy", {
      redis: cache,
      environment: site,
      applicationPort: 6379,
    });
    const data = yield* Data;
    const echo = yield* Echo;
    const ping = yield* Ping;
    const cleanup = yield* Cleanup;
    const worker = yield* Worker;
    const api = yield* Api;
    const backend = yield* Railway.Group("Backend", {
      project: site,
      resources: [db, mysql, cache, echo, api, worker],
    });

    const domain = process.env.RAILWAY_TEST_DOMAIN;
    const www =
      domain === undefined || domain.length === 0
        ? undefined
        : yield* Railway.CustomDomain("Www", {
            service: api,
            environment: site,
            domain,
            targetPort: 3000,
          });

    return {
      projectId: site.projectId,
      projectName: site.name,
      projectUrl: site.url,
      environmentId: site.environmentId,
      stagingId: staging.environmentId,
      stagingName: staging.name,
      secretName: marker.name,
      volumeId: disk.volumeId,
      postgresServiceId: db.serviceId,
      postgresName: db.name,
      postgresPublic: db.publicConnectionUri,
      mysqlServiceId: mysql.serviceId,
      mysqlName: mysql.name,
      databaseUrlName: databaseUrl.name,
      pingUrl: ping.url,
      cleanupId: cleanup.serviceId,
      groupId: backend.groupId,
      redisServiceId: cache.serviceId,
      redisProxy: Output.interpolate`${cacheProxy.domain}:${cacheProxy.proxyPort}`,
      bucketId: data.bucketId,
      echoUrl: echo.url,
      apiServiceId: api.serviceId,
      apiName: api.name,
      apiUrl: api.url,
      workerServiceId: worker.serviceId,
      customDomain: www?.domain,
      workspaceId: site.workspaceId,
    };
  }),
);
