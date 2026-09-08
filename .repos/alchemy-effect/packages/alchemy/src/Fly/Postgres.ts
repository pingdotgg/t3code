import type {
  ClusterCredentials,
  GetClusterResponse,
  ManagedCluster,
} from "@distilled.cloud/fly-io/mpg";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as mpg from "@distilled.cloud/fly-io/mpg";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  stampedOf,
  type MigrationsInput,
} from "../SQL/Migrations/index.ts";
import { hashImports } from "../SQL/SqlFile.ts";
import { recordsEqual } from "../Util/equal.ts";
import { resolveOrgSlug } from "./Environment.ts";
import {
  createFlyAppName,
  matchesAlchemyPhysicalName,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import { runImports, runPgMigrations } from "./PostgresMigrations.ts";
import type { Providers } from "./Providers.ts";

export { stripSslQueryParams } from "./PostgresMigrations.ts";

export const DEFAULT_POSTGRES_PLAN = "basic";
export const DEFAULT_VOLUME_GB = 10;
export const DATABASE_URL_SECRET = "DATABASE_URL";
export const DIRECT_DATABASE_URL_SECRET = "DIRECT_DATABASE_URL";

export type PostgresPlan =
  | "basic"
  | "starter"
  | "launch"
  | "scale"
  | "performance"
  | (string & {});

export interface PostgresProps {
  /**
   * Region the cluster lives in (`iad`, `ord`, `sjc`, …). Required.
   * The cluster is regional; a {@link App} is global. Changing it
   * replaces the cluster.
   */
  region: string;
  /**
   * Hardware plan. `basic` is 2 shared vCPUs / 1 GB RAM.
   *
   * @default "basic"
   */
  plan?: PostgresPlan;
  /**
   * Cluster name. Unique in the organization. If omitted, a unique
   * name is generated from the stack, stage and logical ID. Changing
   * it replaces the cluster.
   */
  name?: string;
  /**
   * Organization slug. Defaults to the current token's org. Changing
   * it replaces the cluster.
   */
  orgSlug?: string;
  /**
   * Initial volume size in GB. Fly defaults to 10. Create-only.
   *
   * @default 10
   */
  volumeSizeGb?: number;
  /**
   * Enable PostGIS. Create-only.
   *
   * @default false
   */
  postgis?: boolean;
  /**
   * Postgres major version (`16` or `17`). Create-only.
   *
   * @default 16
   */
  pgMajorVersion?: number | string;
  /**
   * SQL migrations to apply against the cluster. Accepts a directory
   * path, a `Drizzle.Schema` resource, or `{ dir, table? }`.
   *
   * Bookkeeping always lives in Alchemy's `__alchemy_migrations` table. A
   * database previously migrated by drizzle-kit or Prisma is adopted by a
   * one-way conversion on first deploy: the old tool's applied history is
   * copied into Alchemy's table and the old table is left frozen. No
   * baselining required.
   *
   * Applied over the **direct** (non-PgBouncer) URI. Fly Managed Postgres
   * is reachable on the org private network; deploy-time apply needs a
   * route to that network (a WireGuard peer, `fly mpg proxy`, or a
   * machine already on 6PN).
   */
  migrations?: MigrationsInput;
  /**
   * Paths to additional `.sql` files to apply after migrations. Each file
   * is hashed; only files whose contents change are re-applied on
   * subsequent deploys.
   */
  importFiles?: string[];
}

export type Postgres = Resource<
  "Fly.Postgres",
  PostgresProps,
  {
    /** Fly Managed Postgres cluster id. */
    clusterId: string;
    /** Cluster name (unique in the org). */
    name: string;
    /** Observed status (`creating`, `ready`, `error`, `deleted`, …). */
    status: string | undefined;
    /** Region the cluster lives in. */
    region: string;
    /** Observed hardware plan. */
    plan: string | undefined;
    /** Organization slug. */
    orgSlug: string | undefined;
    /** Observed disk size in GB. */
    disk: number | undefined;
    /** Whether PostGIS is enabled. */
    postgisEnabled: boolean | undefined;
    /** Observed engine string, if the API returned one. */
    engine: string | undefined;
    /** Observed replica count. */
    replicas: number | undefined;
    /** Internal MPG cluster hash id, if the API returned one. */
    mpgdClusterId: string | undefined;
    /**
     * Direct (non-PgBouncer) Postgres URI. Use this for migrations and
     * session-scoped features. Pass to `Drizzle.Postgres` from a laptop
     * Action; from a {@link Service} prefer {@link ConnectPostgres}.
     */
    connectionUri: string;
    /** Pooled PgBouncer URI. Prefer {@link ConnectPostgres} from a Service. */
    pooledConnectionUri: string;
    migrationsDir: string | undefined;
    migrationsTable: string | undefined;
    migrationsHashes: Record<string, string>;
    importHashes: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Fly.Postgres is a Managed Postgres (MPG) cluster. It is billed.
 * Do not wrap unmanaged `fly postgres`.
 *
 * @see https://fly.io/docs/mpg/create-and-connect/
 *
 * ### Create a cluster
 * `region` is required. Alchemy generates a unique name unless you
 * pass one. Omit `name` in tests and CI.
 *
 * **Example:** Generated name
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 * });
 * ```
 *
 * :::caution[Billed]
 * Managed Postgres is billed. Basic is about $38 per month.
 * :::
 *
 * ### Plan
 * `plan` is the hardware size: `basic`, `starter`, `launch`,
 * `scale`, `performance`. Default is `basic`.
 *
 * **Example:** Starter
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 *   plan: "starter",
 * });
 * ```
 *
 * :::note[Create-only]
 * Changing `plan` later is ignored. Fly has no cluster update API.
 * :::
 *
 * ### Region
 * The cluster is regional. An {@link App} is global. Pass `region`
 * on the cluster, not on the App.
 *
 * **Example:** Pin a region
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "lhr",
 * });
 * ```
 *
 * :::caution[Changing `region` replaces the cluster]
 * A new cluster is created in the new region. The old cluster is
 * deleted. Data is not copied.
 * :::
 *
 * ### Volume size
 * `volumeSizeGb` is the initial disk. Fly defaults to 10 GB.
 *
 * **Example:** 20 GB
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 *   volumeSizeGb: 20,
 * });
 * ```
 *
 * :::note[Create-only]
 * Changing `volumeSizeGb` later is ignored.
 * :::
 *
 * ### PostGIS
 * `postgis: true` enables PostGIS at create.
 *
 * **Example:** Enable PostGIS
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 *   postgis: true,
 * });
 * ```
 *
 * :::note[Create-only]
 * Flipping `postgis` later is ignored.
 * :::
 *
 * ### Connect from a Service
 * Yield `ConnectPostgres` inside init. Provide
 * {@link ConnectPostgresHttp}. Pass `conn.connectionString` to
 * `Drizzle.Postgres` or `SQL.Postgres`.
 *
 * **Example:** Bind and query
 * ```typescript
 * import * as Drizzle from "alchemy/Drizzle/Postgres";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const conn = yield* Fly.ConnectPostgres(Db);
 *     const db = yield* Drizzle.Postgres(conn.connectionString);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rows = yield* db.execute("select 1 as ok");
 *         return HttpServerResponse.json({ rows });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.ConnectPostgresHttp)),
 * ) {}
 * ```
 *
 * ### Migrations
 * Pass a directory, `{ dir, table? }`, or a `Drizzle.Schema` resource.
 * Alchemy applies pending files on deploy over the direct URI.
 *
 * **Example:** Directory
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 *   migrations: "./migrations",
 * });
 * ```
 *
 * **Example:** Drizzle.Schema
 * ```typescript
 * const schema = yield* Drizzle.Schema("app-schema", {
 *   schema: "./src/schema.ts",
 *   out: "./migrations",
 * });
 *
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 *   migrations: schema,
 * });
 * ```
 *
 * @resource
 */
export const Postgres = Resource<Postgres>("Fly.Postgres");

export class PostgresNotCreated extends Data.TaggedError(
  "Fly.PostgresNotCreated",
)<{
  name: string;
  orgSlug: string;
}> {}

export class PostgresCreateFailed extends Data.TaggedError(
  "Fly.PostgresCreateFailed",
)<{
  clusterId: string;
  status: string;
}> {}

export class PostgresCredentialsMissing extends Data.TaggedError(
  "Fly.PostgresCredentialsMissing",
)<{
  clusterId: string;
}> {}

export class PostgresAttachmentFailed extends Data.TaggedError(
  "Fly.PostgresAttachmentFailed",
)<{
  clusterId: string;
  appName: string;
}> {}

class PostgresPending extends Data.TaggedError("Fly.PostgresPending")<{
  clusterId: string;
  status: string;
}> {}

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

export const isLiveCluster = (
  cluster: ManagedCluster | undefined,
): cluster is ManagedCluster =>
  cluster !== undefined &&
  (cluster.id ?? "").length > 0 &&
  cluster.status !== "deleted";

export const unwrapSensitive = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
};

type AttrFallback = {
  name?: string;
  orgSlug?: string;
  connectionUri?: string;
  pooledConnectionUri?: string;
  migrationsDir?: string | undefined;
  migrationsTable?: string | undefined;
  migrationsHashes?: Record<string, string>;
  importHashes?: Record<string, string>;
};

const toAttrs = (
  cluster: ManagedCluster,
  fallback?: AttrFallback,
  credentials?: ClusterCredentials,
): Postgres["Attributes"] => ({
  clusterId: cluster.id ?? "",
  name: cluster.name ?? fallback?.name ?? "",
  status: cluster.status,
  region: cluster.region ?? "",
  plan: cluster.plan,
  orgSlug: cluster.organization?.slug ?? fallback?.orgSlug,
  disk: cluster.disk,
  postgisEnabled: cluster.postgis_enabled,
  engine: cluster.engine,
  replicas: cluster.replicas,
  mpgdClusterId: cluster.mpgd_cluster_id,
  connectionUri:
    directUri(cluster, credentials) ?? fallback?.connectionUri ?? "",
  pooledConnectionUri:
    credentialsUri(credentials) ?? fallback?.pooledConnectionUri ?? "",
  migrationsDir: fallback?.migrationsDir,
  migrationsTable: fallback?.migrationsTable,
  migrationsHashes: fallback?.migrationsHashes ?? {},
  importHashes: fallback?.importHashes ?? {},
});

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeFlyAppName(name);
    if (existing !== undefined) return existing;
    return yield* createFlyAppName(id);
  });

export const getLiveCluster = (clusterId: string) =>
  mpg.getClusterById({ id: clusterId }).pipe(
    Effect.map((res) => (isLiveCluster(res.data) ? res.data : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const getClusterResponse = (clusterId: string) =>
  mpg.getClusterById({ id: clusterId }).pipe(
    Effect.map((res): GetClusterResponse | undefined =>
      isLiveCluster(res.data) ? res : undefined,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listOrgClusters = (orgSlug: string) =>
  mpg.listClusters({ org_slug: orgSlug }).pipe(
    Effect.map((res) => (res.data ?? []).filter((row) => isLiveCluster(row))),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as ManagedCluster[]),
    ),
  );

const findByName = (orgSlug: string, name: string) =>
  listOrgClusters(orgSlug).pipe(
    Effect.map((rows) => rows.find((row) => row.name === name)),
  );

const waitUntilReady = (clusterId: string) =>
  getLiveCluster(clusterId).pipe(
    Effect.flatMap(
      (
        cluster,
      ): Effect.Effect<
        ManagedCluster,
        PostgresPending | PostgresCreateFailed
      > => {
        if (cluster === undefined) {
          return Effect.fail(
            new PostgresPending({ clusterId, status: "missing" }),
          );
        }
        if (cluster.status === "ready") return Effect.succeed(cluster);
        if (cluster.status === "error") {
          return Effect.fail(
            new PostgresCreateFailed({
              clusterId,
              status: cluster.status,
            }),
          );
        }
        return Effect.fail(
          new PostgresPending({
            clusterId,
            status: cluster.status ?? "creating",
          }),
        );
      },
    ),
    Effect.retry({
      while: (e) => e._tag === "Fly.PostgresPending",
      times: 10,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.PostgresPending", () => getLiveCluster(clusterId)),
  );

const waitForCredentials = (clusterId: string) =>
  getClusterResponse(clusterId).pipe(
    Effect.flatMap((res) => {
      const uri = credentialsUri(res?.credentials);
      if (uri !== undefined && uri.length > 0) {
        return Effect.succeed(res);
      }
      return Effect.fail(new PostgresCredentialsPending({ clusterId }));
    }),
    Effect.retry({
      while: (e) => e._tag === "Fly.PostgresCredentialsPending",
      times: 16,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.PostgresCredentialsPending", () =>
      getClusterResponse(clusterId),
    ),
  );

const waitUntilGone = (clusterId: string) =>
  mpg.getClusterById({ id: clusterId }).pipe(
    Effect.map(
      (res) => res.data === undefined || res.data.status === "deleted",
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (gone) => gone,
      times: 10,
    }),
  );

const desiredPlan = (plan: PostgresPlan | undefined) =>
  plan ?? DEFAULT_POSTGRES_PLAN;

const desiredDisk = (size: number | undefined) =>
  size === undefined ? DEFAULT_VOLUME_GB : Math.max(1, size);

const pgMajor = (value: number | string | undefined) =>
  value === undefined ? undefined : String(value);

export const credentialsUri = (
  credentials: ClusterCredentials | undefined,
): string | undefined => unwrapSensitive(credentials?.pgbouncer_uri);

export const directUri = (
  _cluster: ManagedCluster | undefined,
  credentials: ClusterCredentials | undefined,
): string | undefined => {
  // Derive the direct host from the server-provided PgBouncer URI:
  // `pgbouncer.<hash>.flympg.net` → `direct.<hash>.flympg.net`. The `<hash>`
  // is the cluster's DNS hash, which is NOT any id the cluster API returns —
  // `mpgd_cluster_id` is the `fly-mpg-…` cluster id, and a host synthesized
  // from it does not resolve. Rewriting the observed pooled host is the only
  // reliable derivation.
  const pooled = unwrapSensitive(credentials?.pgbouncer_uri);
  if (pooled === undefined || pooled.length === 0) return undefined;
  try {
    const url = new URL(pooled);
    if (!url.hostname.startsWith("pgbouncer.")) return undefined;
    url.hostname = url.hostname.replace(/^pgbouncer\./, "direct.");
    return url.toString();
  } catch {
    return undefined;
  }
};

const secretVersion = (
  res: { version?: number; Version?: number } | undefined,
) => res?.version ?? res?.Version;

const putSecret = (appName: string, name: string, value: string) =>
  machines
    .createSecret({
      app_name: appName,
      secret_name: name,
      value,
    })
    .pipe(
      Effect.map(secretVersion),
      Effect.catchTag("Conflict", () =>
        machines
          .updateSecrets({
            app_name: appName,
            values: { [name]: value },
          })
          .pipe(Effect.map(secretVersion)),
      ),
    );

class PostgresCredentialsPending extends Data.TaggedError(
  "Fly.PostgresCredentialsPending",
)<{
  clusterId: string;
}> {}

/**
 * Write `DATABASE_URL` (and `DIRECT_DATABASE_URL` if present) onto an
 * App and record the MPG attachment. Called from {@link Service}
 * reconcile when {@link ConnectPostgres} binds a cluster.
 */
export const attachPostgresSecrets = Effect.fn(function* (
  appName: string,
  clusterId: string,
  variableName: string = DATABASE_URL_SECRET,
) {
  if (appName.length === 0 || clusterId.length === 0) return undefined;
  const creds = yield* getClusterResponse(clusterId).pipe(
    Effect.flatMap((res) => {
      const uri = credentialsUri(res?.credentials);
      if (uri !== undefined && uri.length > 0) {
        return Effect.succeed({
          uri,
          direct: directUri(res?.data, res?.credentials),
        });
      }
      return Effect.fail(new PostgresCredentialsPending({ clusterId }));
    }),
    Effect.retry({
      while: (e) => e._tag === "Fly.PostgresCredentialsPending",
      times: 10,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.PostgresCredentialsPending", () =>
      Effect.succeed(undefined),
    ),
  );
  if (creds === undefined) {
    return yield* new PostgresCredentialsMissing({ clusterId });
  }
  const versions: number[] = [];
  const pooledVersion = yield* putSecret(appName, variableName, creds.uri);
  if (pooledVersion !== undefined) versions.push(pooledVersion);
  if (creds.direct !== undefined) {
    const directVersion = yield* putSecret(
      appName,
      DIRECT_DATABASE_URL_SECRET,
      creds.direct,
    );
    if (directVersion !== undefined) versions.push(directVersion);
  }
  yield* mpg
    .createAttachment({
      id: clusterId,
      app_name: appName,
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("Conflict", () => Effect.void),
      Effect.retry({
        while: (e) => e._tag === "NotFound",
        times: 8,
        schedule: backoff,
      }),
      Effect.timeout("40 seconds"),
      Effect.catchTag(
        "NotFound",
        () =>
          new PostgresAttachmentFailed({
            clusterId,
            appName,
          }),
      ),
    );
  return versions.length > 0 ? Math.max(...versions) : undefined;
});

const rootDir = Effect.sync(() => process.cwd());

export const PostgresProvider = () =>
  Provider.succeed(Postgres, {
    stables: ["clusterId", "name", "region", "orgSlug"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredName =
        news.name !== undefined ? sanitizeFlyAppName(news.name) : output.name;
      const nameChanged = desiredName !== output.name;
      const regionChanged = news.region !== output.region;
      const orgChanged =
        news.orgSlug !== undefined && news.orgSlug !== output.orgSlug;
      if (nameChanged || regionChanged || orgChanged) {
        return { action: "replace" as const };
      }
      if (yield* diffMigrations({ news, output })) {
        return { action: "update" as const };
      }
      if (news.importFiles?.length) {
        const newHashes = yield* hashImports(news.importFiles, yield* rootDir);
        if (!recordsEqual(newHashes, output.importHashes ?? {})) {
          return { action: "update" as const };
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const found =
        output?.clusterId !== undefined && output.clusterId.length > 0
          ? yield* getClusterResponse(output.clusterId)
          : undefined;
      if (found?.data !== undefined) {
        return toAttrs(found.data, output, found.credentials);
      }
      const name = yield* resolveName(id, olds?.name, output?.name);
      const orgSlug =
        olds?.orgSlug ?? output?.orgSlug ?? (yield* resolveOrgSlug());
      const byName = yield* findByName(orgSlug, name);
      if (byName === undefined) return undefined;
      const hydrated =
        byName.id !== undefined
          ? yield* getClusterResponse(byName.id)
          : undefined;
      const attrs = toAttrs(
        hydrated?.data ?? byName,
        { ...output, name, orgSlug },
        hydrated?.credentials,
      );
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const orgSlug = yield* resolveOrgSlug();
      const rows = yield* listOrgClusters(orgSlug);
      return rows.flatMap((cluster) => {
        if (!matchesAlchemyPhysicalName(cluster.name)) return [];
        return [
          toAttrs(cluster, {
            orgSlug,
            migrationsDir: undefined,
            migrationsTable: undefined,
            migrationsHashes: {},
            importHashes: {},
          }),
        ];
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as PostgresProps);
      const name = yield* resolveName(id, props.name, output?.name);
      const orgSlug = props.orgSlug ?? (yield* resolveOrgSlug());
      const region = props.region ?? output?.region;

      let current =
        output?.clusterId !== undefined && output.clusterId.length > 0
          ? yield* getLiveCluster(output.clusterId)
          : undefined;
      if (
        current === undefined &&
        (output === undefined ||
          output.name !== name ||
          output.orgSlug !== orgSlug)
      ) {
        current = yield* findByName(orgSlug, name);
      }

      if (current === undefined) {
        if (region === undefined || region.length === 0) {
          return yield* new PostgresNotCreated({ name, orgSlug });
        }
        const created = yield* mpg
          .createCluster({
            org_slug: orgSlug,
            name,
            region,
            plan: desiredPlan(props.plan),
            storage_in_gb: desiredDisk(props.volumeSizeGb),
            postgis_enabled: props.postgis,
            pg_major_version: pgMajor(props.pgMajorVersion),
          })
          .pipe(
            Effect.map((res) => res.data),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = isLiveCluster(created)
          ? created
          : yield* findByName(orgSlug, name);
      }

      if (current === undefined || current.id === undefined) {
        return yield* new PostgresNotCreated({ name, orgSlug });
      }
      // `current` is reassigned below; the id is stable across the waits.
      const clusterId = current.id;

      if (current.status !== "ready") {
        current =
          (yield* waitUntilReady(clusterId)) ??
          (yield* getLiveCluster(clusterId)) ??
          current;
      }

      if (current.status === "error") {
        return yield* new PostgresCreateFailed({
          clusterId,
          status: current.status,
        });
      }

      const observed = yield* waitForCredentials(clusterId);
      const cluster = observed?.data ?? current;
      const credentials = observed?.credentials;
      const migrationUri =
        directUri(cluster, credentials) ?? credentialsUri(credentials);

      const migrationsInput = migrationsInputOf(props);
      if (
        migrationsInput &&
        (migrationUri === undefined || migrationUri.length === 0)
      ) {
        return yield* new PostgresCredentialsMissing({ clusterId });
      }
      const connectionUri =
        migrationUri !== undefined ? Redacted.make(migrationUri) : undefined;
      const migrations =
        migrationsInput && connectionUri !== undefined
          ? yield* runPgMigrations({
              connectionUri,
              input: migrationsInput,
              stamped: stampedOf(output),
            })
          : undefined;
      const importHashes =
        props.importFiles?.length && connectionUri !== undefined
          ? yield* runImports(
              connectionUri,
              props.importFiles,
              yield* rootDir,
              output?.importHashes ?? {},
            )
          : (output?.importHashes ?? {});

      return {
        ...toAttrs(cluster, { name, orgSlug, ...output }, credentials),
        ...migrationsAttrs({
          input: migrationsInput,
          run: migrations,
          output,
        }),
        importHashes,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const clusterId = output.clusterId;
      if (clusterId.length === 0) return;
      const orgSlug = output.orgSlug ?? (yield* resolveOrgSlug());
      const observed = yield* getClusterResponse(clusterId);
      const apps = observed?.data?.attached_apps ?? [];
      yield* Effect.forEach(
        apps,
        (app) => {
          const appName = app.name;
          if (appName === undefined || appName.length === 0) {
            return Effect.void;
          }
          return Effect.gen(function* () {
            yield* mpg
              .deleteAttachment({ id: clusterId, app_name: appName })
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
            yield* machines
              .deleteSecret({
                app_name: appName,
                secret_name: DATABASE_URL_SECRET,
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
            yield* machines
              .deleteSecret({
                app_name: appName,
                secret_name: DIRECT_DATABASE_URL_SECRET,
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
          });
        },
        { concurrency: 4 },
      );
      yield* mpg
        .destroyCluster({ org_slug: orgSlug, id: clusterId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(clusterId);
    }),
  });
