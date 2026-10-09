import {
  environmentServiceInstances,
  waitUntilDeleted,
  projectServices,
  environmentVolumes,
} from "./GraphQL.ts";
import { randomBytes } from "node:crypto";
import { Query, type UnwrapPlan } from "@distilled.cloud/core/query";
import {
  Railway,
  type ServiceCreateInput,
  type ServiceInstance,
  type ServiceInstanceUpdateInput,
  type Service as RailwayService,
  type TCPProxy,
  type TCPProxyCreateInput,
  type VariableUpsertInput,
  type VolumeCreateInput,
  type VolumeInstance,
  type VolumeInstanceUpdateInput,
  type VolumeState,
} from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import { ownedProjects, type Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export const DEFAULT_POSTGRES_IMAGE =
  "ghcr.io/railwayapp-templates/postgres-ssl:16";
export const DEFAULT_POSTGRES_USER = "postgres";
export const DEFAULT_POSTGRES_DATABASE = "railway";
export const POSTGRES_PORT = 5432;
export const POSTGRES_MOUNT_PATH = "/var/lib/postgresql/data";
export const POSTGRES_PGDATA = "/var/lib/postgresql/data/pgdata";
import {
  DATABASE_PUBLIC_URL_SECRET,
  DATABASE_URL_SECRET,
} from "./ConnectPostgres.ts";

const serviceFields = <E>(service: Query<RailwayService, E>) => ({
  id: service.id,
  name: service.name,
  deletedAt: service.deletedAt,
});
const attributeInstanceFields = <E>(instance: Query<ServiceInstance, E>) => ({
  source: instance.source.pipe(
    Query.map((source) => ({ image: source.image })),
  ),
  region: instance.region,
  latestDeployment: instance.latestDeployment.pipe(
    Query.map((deployment) => ({
      id: deployment.id,
      status: deployment.status,
    })),
  ),
});
const instanceFields = <E>(instance: Query<ServiceInstance, E>) => ({
  ...attributeInstanceFields(instance),
  deletedAt: instance.deletedAt,
  sleepApplication: instance.sleepApplication,
});
const volumeFields = <E>(instance: Query<VolumeInstance, E>) => ({
  id: instance.id,
  volumeId: instance.volumeId,
  environmentId: instance.environmentId,
  serviceId: instance.serviceId,
  deletedAt: instance.deletedAt,
  isPendingDeletion: instance.isPendingDeletion,
  state: instance.state,
  mountPath: instance.mountPath,
  volume: { id: instance.volume.id, name: instance.volume.name },
});
const proxyFields = <E>(proxy: Query<TCPProxy, E>) => ({
  id: proxy.id,
  applicationPort: proxy.applicationPort,
  deletedAt: proxy.deletedAt,
  syncStatus: proxy.syncStatus,
  domain: proxy.domain,
  proxyPort: proxy.proxyPort,
});
type CloudService = UnwrapPlan<ReturnType<typeof serviceFields>>;
type AttributeInstance = UnwrapPlan<ReturnType<typeof attributeInstanceFields>>;
type ServiceInstanceResponse = UnwrapPlan<ReturnType<typeof instanceFields>>;
type CloudInstance = UnwrapPlan<ReturnType<typeof volumeFields>>;
type CloudProxy = UnwrapPlan<ReturnType<typeof proxyFields>>;

export { DATABASE_PUBLIC_URL_SECRET, DATABASE_URL_SECRET };

/**
 * Environment identity Postgres is deployed into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type PostgresEnvironment = {
  readonly environmentId: string;
};

export interface PostgresProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` or an Effect
   * that produces one. Changing the Project replaces Postgres.
   */
  project: Ref<Project>;
  /**
   * Environment to deploy into. Accepts a `Railway.Project` (primary
   * environment), a `Railway.Environment`, or `{ environmentId }`.
   * Defaults to the project's primary environment. Changing it replaces
   * Postgres.
   */
  environment?: Ref<PostgresEnvironment>;
  /**
   * Service name. Unique per Project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Used as the private
   * hostname `{name}.railway.internal`. Changing it updates in place.
   */
  name?: string;
  /**
   * Postgres image. Default is the official SSL image tag 16.
   *
   * @default "ghcr.io/railwayapp-templates/postgres-ssl:16"
   */
  image?: string;
  /**
   * Region for the service instance and volume (`us-west2`, `us-east4`,
   * …). If omitted, Railway picks the default. Changing it replaces
   * Postgres.
   */
  region?: string;
  /**
   * Superuser name. Create-only (used at `initdb`).
   *
   * @default "postgres"
   */
  user?: string;
  /**
   * Superuser password. Wrap with `Redacted.make(...)`. If omitted, a
   * password is generated on first create and stored as
   * `POSTGRES_PASSWORD`. Create-only.
   */
  password?: Redacted.Redacted<string> | string;
  /**
   * Initial database name. Create-only.
   *
   * @default "railway"
   */
  database?: string;
  /**
   * Expose Postgres on a public TCP proxy (`*.proxy.rlwy.net`) for
   * laptop access and deploy-time migrations. In-service connections
   * always use `{name}.railway.internal`.
   *
   * @default true
   */
  public?: boolean;
}

export type Postgres = Resource<
  "Railway.Postgres",
  PostgresProps,
  {
    /** Railway service id for the Postgres container. */
    serviceId: string;
    /** Physical service name. Private hostname is `{name}.railway.internal`. */
    name: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Environment the instance is deployed in. */
    environmentId: string;
    /** Observed `source.image`. */
    image: string | undefined;
    /** Observed region, if Railway reported one. */
    region: string | undefined;
    /** Volume id holding PGDATA. */
    volumeId: string;
    /** Volume instance id in the target environment. */
    volumeInstanceId: string;
    /** TCP proxy id, when `public` is enabled. */
    tcpProxyId: string | undefined;
    /** Public proxy hostname (`*.proxy.rlwy.net`). */
    tcpProxyDomain: string | undefined;
    /** Public proxy port. Pair with `tcpProxyDomain`. */
    tcpProxyPort: number | undefined;
    /** Superuser name. */
    user: string;
    /** Database name. */
    database: string;
    /**
     * Private Postgres URI (`{name}.railway.internal:5432`). Prefer
     * {@link ConnectPostgres} from a {@link Service}.
     */
    connectionUri: string;
    /**
     * Public TCP-proxy URI. Empty when `public` is false. Use this from
     * the laptop / deploy-time migrations.
     */
    publicConnectionUri: string;
    /** Latest deployment id, if one exists. */
    deploymentId: string | undefined;
    /** Latest deployment status (`SUCCESS`, `DEPLOYING`, …). */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
>;

const resolvePostgresProps = (
  props: PostgresProps | Effect.Effect<PostgresProps, never, Providers>,
): Effect.Effect<PostgresProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const project = Effect.isEffect(resolved.project)
      ? yield* resolved.project as Effect.Effect<Project, never, Providers>
      : resolved.project;
    const environment =
      resolved.environment === undefined
        ? undefined
        : Effect.isEffect(resolved.environment)
          ? yield* resolved.environment as Effect.Effect<
              PostgresEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    return { ...resolved, project, environment };
  });

const PostgresResource = Resource<Postgres>("Railway.Postgres");

/**
 * A Railway.Postgres is a Postgres-as-a-Service: the official
 * `ghcr.io/railwayapp-templates/postgres-ssl:16` image, a Volume at
 * `/var/lib/postgresql/data`, `POSTGRES_*` / `DATABASE_URL` variables,
 * and an optional TCP proxy for the public URL.
 *
 * Private hostname is `{name}.railway.internal`. From a
 * {@link Service}, yield {@link ConnectPostgres}. From a laptop, use
 * `publicConnectionUri`.
 *
 * @see https://docs.railway.com/databases/build-a-database-service
 *
 * ### Create Postgres
 * Pass a Project. Alchemy generates a unique name, password, volume,
 * and a public TCP proxy.
 *
 * **Example:** Generated name
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const db = yield* Railway.Postgres("Db", { project: site });
 * ```
 *
 * :::caution[Changing `project` replaces Postgres]
 * A new service + volume are created in the new Project. The old
 * service and volume are deleted. Data is not copied.
 * :::
 *
 * ### Connect from a Service
 * Yield `ConnectPostgres` inside init. Provide
 * {@link ConnectPostgresHttp}. Pass `conn.connectionString` to
 * `Drizzle.Postgres` or `SQL.Postgres`. The binding packs the private
 * URI (`{name}.railway.internal`).
 *
 * **Example:** Bind and query
 * ```typescript
 * import * as Drizzle from "alchemy/Drizzle/Postgres";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   { project: Site, main: import.meta.url, build: { install: ["pg"] } },
 *   Effect.gen(function* () {
 *     const conn = yield* Railway.ConnectPostgres(Db);
 *     const db = yield* Drizzle.Postgres(conn.connectionString);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rows = yield* db.execute("select 1 as ok");
 *         return HttpServerResponse.json({ rows });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Railway.ConnectPostgresHttp)),
 * ) {}
 * ```
 *
 * ### Public TCP
 * `public` (default `true`) creates a TCP proxy on 5432.
 * `publicConnectionUri` is `{domain}:{proxyPort}` for laptop access
 * and deploy-time migrations.
 *
 * **Example:** Private only
 * ```typescript
 * const db = yield* Railway.Postgres("Db", {
 *   project: site,
 *   public: false,
 * });
 * ```
 *
 * ### Image
 * Default is Postgres 16 with SSL. Pass `image` to pin another tag.
 *
 * **Example:** Postgres 17
 * ```typescript
 * const db = yield* Railway.Postgres("Db", {
 *   project: site,
 *   image: "ghcr.io/railwayapp-templates/postgres-ssl:17",
 * });
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Postgres
 * ```typescript
 * // src/db.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Db = Railway.Postgres("Db", { project: Site });
 * ```
 *
 * @resource
 * @product Postgres
 */
export const Postgres: typeof PostgresResource = Object.assign(
  (
    id: string,
    props: PostgresProps | Effect.Effect<PostgresProps, never, Providers>,
  ) => PostgresResource(id, resolvePostgresProps(props)),
  PostgresResource,
);

export class PostgresNotCreated extends Data.TaggedError(
  "Railway.PostgresNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class PostgresProjectRequired extends Data.TaggedError(
  "Railway.PostgresProjectRequired",
)<{
  message: string;
}> {}

export class PostgresDeployFailed extends Data.TaggedError(
  "Railway.PostgresDeployFailed",
)<{
  serviceId: string;
  status: string;
  deploymentId: string | undefined;
}> {}

export class PostgresVolumeNotCreated extends Data.TaggedError(
  "Railway.PostgresVolumeNotCreated",
)<{
  name: string;
  serviceId: string;
}> {}

class PostgresPending extends Data.TaggedError("Railway.PostgresPending")<{
  serviceId: string;
  status: string;
}> {}

class PostgresDeployPending extends Data.TaggedError(
  "Railway.PostgresDeployPending",
)<{
  serviceId: string;
  status: string;
}> {}

class VolumePending extends Data.TaggedError("Railway.PostgresVolumePending")<{
  volumeId: string;
  state: string;
}> {
  override get message() {
    return `Postgres volume ${this.volumeId} is still ${this.state}`;
  }
}

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const unwrapSecret = (value: Redacted.Redacted<string> | string): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const generatePassword = Effect.sync(() => {
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
});

const isGoneService = (service: CloudService | undefined) =>
  service === undefined || service.deletedAt != null;

const isGoneInstance = (instance: ServiceInstanceResponse | undefined) =>
  instance === undefined || instance.deletedAt != null;

const goneVolumeState = (state: VolumeState | null | undefined) =>
  state === "DELETED" || state === "DELETING";

const transientVolumeState = (state: VolumeState | null | undefined) =>
  state === "UPDATING" ||
  state === "MIGRATING" ||
  state === "MIGRATION_PENDING" ||
  state === "RESTORING";

const isGoneVolume = (instance: CloudInstance | undefined) =>
  instance === undefined ||
  instance.deletedAt != null ||
  instance.isPendingDeletion ||
  goneVolumeState(instance.state);

const isGoneProxy = (proxy: CloudProxy | undefined) =>
  proxy === undefined ||
  proxy.deletedAt != null ||
  proxy.syncStatus === "DELETED";

const normalizeDomain = (domain: string) => domain.replace(/\.+$/, "");

const sameImage = (observed: string | null | undefined, desired: string) => {
  if (observed == null || observed.length === 0) return false;
  if (observed === desired) return true;
  if (observed === `${desired}:latest` || desired === `${observed}:latest`) {
    return true;
  }
  return (
    observed.endsWith(`/${desired}`) || observed.endsWith(`/${desired}:latest`)
  );
};

const isPostgresImage = (image: string | null | undefined) =>
  image != null && /postgres/i.test(image);

const deployReady = (status: string | undefined) => status === "SUCCESS";

const deployFailed = (status: string | undefined) =>
  status === "FAILED" || status === "CRASHED" || status === "REMOVED";

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const encodePart = (value: string) => encodeURIComponent(value);

export const privateConnectionUri = (input: {
  user: string;
  password: string;
  name: string;
  database: string;
}): string =>
  `postgresql://${encodePart(input.user)}:${encodePart(input.password)}@${input.name}.railway.internal:${POSTGRES_PORT}/${encodePart(input.database)}?sslmode=no-verify`;

export const publicConnectionUri = (input: {
  user: string;
  password: string;
  domain: string;
  port: number;
  database: string;
}): string =>
  `postgresql://${encodePart(input.user)}:${encodePart(input.password)}@${input.domain}:${input.port}/${encodePart(input.database)}?sslmode=no-verify`;

const desiredVariables = (input: {
  user: string;
  password: string;
  database: string;
}): Record<string, string> => ({
  POSTGRES_USER: input.user,
  POSTGRES_PASSWORD: input.password,
  POSTGRES_DB: input.database,
  PGDATA: POSTGRES_PGDATA,
  PGUSER: "${{POSTGRES_USER}}",
  PGPASSWORD: "${{POSTGRES_PASSWORD}}",
  PGDATABASE: "${{POSTGRES_DB}}",
  PGHOST: "${{RAILWAY_PRIVATE_DOMAIN}}",
  PGPORT: String(POSTGRES_PORT),
  [DATABASE_URL_SECRET]:
    "postgresql://${{POSTGRES_USER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{POSTGRES_DB}}",
  [DATABASE_PUBLIC_URL_SECRET]:
    "postgresql://${{POSTGRES_USER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}/${{POSTGRES_DB}}",
});

const toAttrs = (input: {
  service: CloudService;
  instance: AttributeInstance | undefined;
  volume: CloudInstance | undefined;
  proxy: CloudProxy | undefined;
  projectId: string;
  environmentId: string;
  user: string;
  password: string;
  database: string;
}): Postgres["Attributes"] => {
  const name = input.service.name;
  const domain =
    input.proxy !== undefined ? normalizeDomain(input.proxy.domain) : undefined;
  const proxyPort = input.proxy?.proxyPort;
  return {
    serviceId: input.service.id,
    name,
    projectId: input.projectId,
    environmentId: input.environmentId,
    image: input.instance?.source?.image ?? undefined,
    region: input.instance?.region ?? undefined,
    volumeId: input.volume?.volumeId || input.volume?.volume.id || "",
    volumeInstanceId: input.volume?.id ?? "",
    tcpProxyId: input.proxy?.id,
    tcpProxyDomain: domain,
    tcpProxyPort: proxyPort,
    user: input.user,
    database: input.database,
    connectionUri:
      input.password.length > 0
        ? privateConnectionUri({
            user: input.user,
            password: input.password,
            name,
            database: input.database,
          })
        : "",
    publicConnectionUri:
      input.password.length > 0 &&
      domain !== undefined &&
      domain.length > 0 &&
      proxyPort !== undefined
        ? publicConnectionUri({
            user: input.user,
            password: input.password,
            domain,
            port: proxyPort,
            database: input.database,
          })
        : "",
    deploymentId: input.instance?.latestDeployment?.id,
    deploymentStatus: input.instance?.latestDeployment?.status,
  };
};

const readService = Query.fn((id: string) =>
  serviceFields(Railway.service({ id })),
);

const readInstance = Query.fn((environmentId: string, serviceId: string) =>
  instanceFields(Railway.serviceInstance({ environmentId, serviceId })),
);

const readVolumeInstance = Query.fn((id: string) =>
  volumeFields(Railway.volumeInstance({ id })),
);

const readProxies = Query.fn((environmentId: string, serviceId: string) =>
  Railway.tcpProxies({ environmentId, serviceId }).pipe(Query.map(proxyFields)),
);

const tcpProxyDelete = Query.fn((id: string) => Railway.tcpProxyDelete({ id }));

const readVariables = Query.fn(
  (projectId: string, environmentId: string, serviceId: string) =>
    Railway.variables({
      projectId,
      environmentId,
      serviceId,
      unrendered: true,
    }),
);

const variableUpsert = Query.fn((input: VariableUpsertInput) =>
  Railway.variableUpsert({ input }),
);

const volumeUpdateName = Query.fn((volumeId: string, name: string) => ({
  id: Railway.volumeUpdate({ volumeId, input: { name } }).id,
}));

const serviceCreate = Query.fn((input: ServiceCreateInput) =>
  serviceFields(Railway.serviceCreate({ input })),
);

const serviceUpdateName = Query.fn((id: string, name: string) =>
  serviceFields(Railway.serviceUpdate({ id, input: { name } })),
);

const serviceInstanceUpdate = Query.fn(
  (
    environmentId: string,
    serviceId: string,
    input: ServiceInstanceUpdateInput,
  ) => Railway.serviceInstanceUpdate({ environmentId, serviceId, input }),
);

const volumeCreate = Query.fn((input: VolumeCreateInput) => {
  const volume = Railway.volumeCreate({ input });
  return { id: volume.id, name: volume.name };
});

const volumeInstanceUpdate = Query.fn(
  (volumeId: string, environmentId: string, input: VolumeInstanceUpdateInput) =>
    Railway.volumeInstanceUpdate({ volumeId, environmentId, input }),
);

const tcpProxyCreate = Query.fn((input: TCPProxyCreateInput) =>
  proxyFields(Railway.tcpProxyCreate({ input })),
);

const serviceInstanceDeploy = Query.fn(
  (environmentId: string, serviceId: string) =>
    Railway.serviceInstanceDeployV2({ environmentId, serviceId }),
);

const deploymentCancel = Query.fn((id: string) =>
  Railway.deploymentCancel({ id }),
);

const serviceDelete = Query.fn((id: string) => Railway.serviceDelete({ id }));

const volumeDelete = Query.fn((volumeId: string) =>
  Railway.volumeDelete({ volumeId }),
);

const liveEnvironmentIds = (projectId: string) =>
  Query.items(
    Railway.environments({ projectId, first: 50 }).pipe(
      Query.map((env) => ({ id: env.id, deletedAt: env.deletedAt })),
    ),
  );

const getById = (serviceId: string) =>
  readService(serviceId).pipe(
    Effect.map((service) => (isGoneService(service) ? undefined : service)),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed(undefined)),
  );

const getInstance = (environmentId: string, serviceId: string) =>
  readInstance(environmentId, serviceId).pipe(
    Effect.map((instance) => (isGoneInstance(instance) ? undefined : instance)),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed(undefined)),
  );

const listProjectServices = (projectId: string) =>
  projectServices(projectId, serviceFields).pipe(
    Effect.map((services) => services.filter((node) => !isGoneService(node))),
    Effect.catchTag("RailwayNotFound", () =>
      Effect.succeed([] as CloudService[]),
    ),
  );

const findByName = (projectId: string, name: string) =>
  listProjectServices(projectId).pipe(
    Effect.map((services) => services.find((service) => service.name === name)),
  );

const getVolumeByInstanceId = (volumeInstanceId: string) =>
  readVolumeInstance(volumeInstanceId).pipe(
    Effect.map((instance) => (isGoneVolume(instance) ? undefined : instance)),
    Effect.catchTag("RailwayNotFound", () => Effect.succeed(undefined)),
  );

const listVolumeInstances = (environmentId: string, projectId: string) =>
  environmentVolumes(environmentId, projectId, volumeFields).pipe(
    Effect.map((instances) => instances.filter((node) => !isGoneVolume(node))),
    Effect.catchTag("RailwayNotFound", () =>
      Effect.succeed([] as CloudInstance[]),
    ),
  );

const findVolume = (
  environmentId: string,
  projectId: string,
  match: (instance: CloudInstance) => boolean,
) =>
  listVolumeInstances(environmentId, projectId).pipe(
    Effect.map((instances) => instances.find(match)),
  );

const listProxies = (environmentId: string, serviceId: string) =>
  readProxies(environmentId, serviceId).pipe(
    Effect.map((items) => items.filter((proxy) => !isGoneProxy(proxy))),
    Effect.catchTag("RailwayNotFound", () =>
      Effect.succeed([] as CloudProxy[]),
    ),
  );

const findProxy = (
  environmentId: string,
  serviceId: string,
  applicationPort: number,
) =>
  listProxies(environmentId, serviceId).pipe(
    Effect.map((items) =>
      items.find((proxy) => proxy.applicationPort === applicationPort),
    ),
  );

/**
 * Delete a TCP proxy, riding out Railway's per-environment mutation lock: a
 * delete racing an in-flight deploy fails with "Cannot delete TCP proxy: an
 * operation is already in progress". Already-gone proxies are a no-op.
 */
const deleteProxy = (id: string) =>
  tcpProxyDelete(id).pipe(
    Effect.retry({
      while: (e) => e._tag === "RailwayOperationInProgress",
      schedule: Schedule.spaced("3 seconds"),
      times: 10,
    }),
    Effect.catchTag("RailwayNotFound", () => Effect.void),
    Effect.asVoid,
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

const listVariableMap = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  readVariables(projectId, environmentId, serviceId).pipe(
    Effect.map(asVariableMap),
    Effect.catchTag("RailwayNotFound", () =>
      Effect.succeed({} as Record<string, string>),
    ),
  );

const upsertVariable = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  name: string;
  value: string;
}) =>
  variableUpsert({
    projectId: input.projectId,
    environmentId: input.environmentId,
    serviceId: input.serviceId,
    name: input.name,
    value: input.value,
    skipDeploys: true,
  });

const syncEnv = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  desired: Record<string, string>;
}) {
  const observed = yield* listVariableMap(
    input.projectId,
    input.environmentId,
    input.serviceId,
  );
  let changed = false;
  for (const [name, value] of Object.entries(input.desired)) {
    if (observed[name] !== value) {
      yield* upsertVariable({
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        name,
        value,
      });
      changed = true;
    }
  }
  return changed;
});

const waitForInstance = (environmentId: string, serviceId: string) =>
  getInstance(environmentId, serviceId).pipe(
    Effect.flatMap((instance) => {
      if (instance === undefined) {
        return Effect.fail(
          new PostgresPending({ serviceId, status: "creating" }),
        );
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.PostgresPending",
      // serviceCreate fans the instance out to each environment
      // asynchronously; wait a bounded interval for it to appear.
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.PostgresPending", () =>
      getInstance(environmentId, serviceId),
    ),
  );

const waitForDeployment = (environmentId: string, serviceId: string) =>
  getInstance(environmentId, serviceId).pipe(
    Effect.flatMap((instance) => {
      const latest = instance?.latestDeployment;
      const status = latest?.status;
      if (instance !== undefined && deployReady(status)) {
        return Effect.succeed(instance);
      }
      return Effect.fail(
        new PostgresDeployPending({
          serviceId,
          status: status ?? "pending",
        }),
      );
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.PostgresDeployPending",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.catchTag("Railway.PostgresDeployPending", () =>
      getInstance(environmentId, serviceId),
    ),
  );

const waitForVolume = (
  environmentId: string,
  projectId: string,
  volumeId: string,
  volumeInstanceId?: string,
) => {
  const observe =
    volumeInstanceId !== undefined && volumeInstanceId.length > 0
      ? getVolumeByInstanceId(volumeInstanceId)
      : findVolume(
          environmentId,
          projectId,
          (instance) => instance.volumeId === volumeId,
        );
  return observe.pipe(
    Effect.flatMap((instance) => {
      if (instance === undefined || transientVolumeState(instance.state)) {
        return Effect.fail(
          new VolumePending({
            volumeId,
            state: instance?.state ?? "creating",
          }),
        );
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.PostgresVolumePending",
      times: 10,
      // Volume attachment can lag creation beyond 30 seconds.
      // Keep the wait bounded and retain the volume ID/state on exhaustion.
      schedule: Schedule.spaced("5 seconds"),
    }),
  );
};

const stampVolumeName = (volumeId: string, name: string) =>
  volumeUpdateName(volumeId, name);

export const PostgresProvider = () =>
  Provider.succeed(Postgres, {
    stables: ["serviceId", "projectId", "environmentId", "volumeId"],
    nuke: { dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const nextProject = projectIdOf(news.project);
      const projectChanged =
        nextProject !== undefined && nextProject !== output.projectId;
      const nextEnv = environmentIdOf(news.environment);
      const environmentChanged =
        nextEnv !== undefined && nextEnv !== output.environmentId;
      const regionChanged =
        news.region !== undefined && news.region !== output.region;
      if (projectChanged || environmentChanged || regionChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const projectId =
        output?.projectId ??
        (olds !== undefined ? projectIdOf(olds.project) : undefined);
      const environmentId =
        output?.environmentId ??
        (olds !== undefined
          ? (environmentIdOf(olds.environment) ?? environmentIdOf(olds.project))
          : undefined);
      const name = yield* resolveName(id, olds?.name, output?.name);
      const byId =
        output?.serviceId !== undefined && output.serviceId.length > 0
          ? yield* getById(output.serviceId)
          : undefined;
      const found =
        byId ??
        (projectId !== undefined
          ? yield* findByName(projectId, name)
          : undefined);
      if (found === undefined) return undefined;
      const resolvedProjectId = projectIdOf(found) ?? projectId ?? "";
      const resolvedEnvId =
        environmentId ??
        environmentIdOf(olds?.project) ??
        output?.environmentId ??
        "";
      const instance =
        resolvedEnvId.length > 0
          ? yield* getInstance(resolvedEnvId, found.id)
          : undefined;
      const volume =
        output?.volumeInstanceId !== undefined &&
        output.volumeInstanceId.length > 0
          ? yield* getVolumeByInstanceId(output.volumeInstanceId)
          : resolvedEnvId.length > 0 && resolvedProjectId.length > 0
            ? yield* findVolume(
                resolvedEnvId,
                resolvedProjectId,
                (row) =>
                  (row.serviceId ?? undefined) === found.id ||
                  (output?.volumeId !== undefined &&
                    row.volumeId === output.volumeId),
              )
            : undefined;
      const proxy =
        resolvedEnvId.length > 0
          ? yield* findProxy(resolvedEnvId, found.id, POSTGRES_PORT)
          : undefined;
      const vars =
        resolvedProjectId.length > 0 && resolvedEnvId.length > 0
          ? yield* listVariableMap(resolvedProjectId, resolvedEnvId, found.id)
          : {};
      const attrs = toAttrs({
        service: found,
        instance,
        volume,
        proxy,
        projectId: resolvedProjectId,
        environmentId: resolvedEnvId,
        user: vars.POSTGRES_USER ?? output?.user ?? DEFAULT_POSTGRES_USER,
        password: vars.POSTGRES_PASSWORD ?? "",
        database:
          vars.POSTGRES_DB ?? output?.database ?? DEFAULT_POSTGRES_DATABASE,
      });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const services = new Map(
            (yield* listProjectServices(project.projectId))
              .filter((service) => matchesAlchemyPhysicalName(service.name))
              .map((service) => [service.id, service]),
          );
          if (services.size === 0) return [];
          const envIds = yield* liveEnvironmentIds(project.projectId).pipe(
            Stream.filter((env) => env.deletedAt == null),
            Stream.map((env) => env.id),
            Stream.runCollect,
            Effect.catchTag("RailwayNotFound", () => Effect.succeed([])),
          );
          const items = yield* Effect.forEach(envIds, (environmentId) =>
            Effect.gen(function* () {
              const instances = (yield* environmentServiceInstances(
                environmentId,
                project.projectId,
                (instance) => ({
                  ...attributeInstanceFields(instance),
                  serviceId: instance.serviceId,
                  deletedAt: instance.deletedAt,
                }),
              )).filter(
                (instance) =>
                  instance.deletedAt == null &&
                  services.has(instance.serviceId) &&
                  isPostgresImage(instance.source?.image),
              );
              if (instances.length === 0) return [];
              const volumes = yield* listVolumeInstances(
                environmentId,
                project.projectId,
              );
              return instances.flatMap((instance) => {
                const service = services.get(instance.serviceId);
                return service === undefined
                  ? []
                  : [
                      toAttrs({
                        service,
                        instance,
                        projectId: project.projectId,
                        environmentId,
                        volume: volumes.find(
                          (row) => row.serviceId === service.id,
                        ),
                        proxy: undefined,
                        user: DEFAULT_POSTGRES_USER,
                        password: "",
                        database: DEFAULT_POSTGRES_DATABASE,
                      }),
                    ];
              });
            }),
          );
          return items.flat();
        }),
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as PostgresProps);
      const projectId = projectIdOf(props.project) ?? output?.projectId;
      if (projectId === undefined) {
        return yield* new PostgresProjectRequired({
          message: "Postgres requires a resolved Railway.Project",
        });
      }
      const environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.project) ??
        output?.environmentId;
      if (environmentId === undefined) {
        return yield* new PostgresProjectRequired({
          message:
            "Postgres requires a Railway environment (pass environment or a Project with environmentId)",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);
      const sourceImage = props.image ?? DEFAULT_POSTGRES_IMAGE;
      const wantPublic = props.public !== false;
      const volumeName = yield* createRailwayName(`${id}-pgdata`);

      let current: CloudService | undefined =
        output?.serviceId !== undefined && output.serviceId.length > 0
          ? yield* getById(output.serviceId)
          : undefined;
      if (current === undefined) {
        current = yield* findByName(projectId, name);
      }

      const existingVars =
        current !== undefined
          ? yield* listVariableMap(projectId, environmentId, current.id)
          : {};
      const user =
        existingVars.POSTGRES_USER ?? props.user ?? DEFAULT_POSTGRES_USER;
      const database =
        existingVars.POSTGRES_DB ?? props.database ?? DEFAULT_POSTGRES_DATABASE;
      const password =
        existingVars.POSTGRES_PASSWORD ??
        (props.password !== undefined
          ? unwrapSecret(props.password)
          : undefined) ??
        (yield* generatePassword);
      const variables = desiredVariables({ user, password, database });

      if (current === undefined) {
        const created = yield* serviceCreate({
          projectId,
          environmentId,
          name,
          source: { image: sourceImage },
          variables,
        }).pipe(
          Effect.catchTag("RailwayValidationError", () =>
            Effect.succeed(undefined),
          ),
        );
        current = created ?? (yield* findByName(projectId, name));
      }

      if (current === undefined || isGoneService(current)) {
        return yield* new PostgresNotCreated({ name, projectId });
      }

      if (current.name !== name) {
        current = yield* serviceUpdateName(current.id, name);
      }

      let instance = yield* waitForInstance(environmentId, current.id);
      let needsDeploy = false;

      const observedImage = instance?.source?.image ?? undefined;
      const imageChanged =
        sourceImage !== undefined && !sameImage(observedImage, sourceImage);
      const observedRegion = instance?.region ?? undefined;
      const regionChanged =
        props.region !== undefined && props.region !== observedRegion;
      const sleepOn = instance?.sleepApplication !== false;
      if (imageChanged || regionChanged || sleepOn) {
        yield* serviceInstanceUpdate(environmentId, current.id, {
          ...(imageChanged ? { source: { image: sourceImage } } : {}),
          ...(regionChanged ? { region: props.region } : {}),
          ...(sleepOn ? { sleepApplication: false } : {}),
        });
        needsDeploy = true;
        instance = (yield* getInstance(environmentId, current.id)) ?? instance;
      }

      const envChanged = yield* syncEnv({
        projectId,
        environmentId,
        serviceId: current.id,
        desired: variables,
      });
      if (envChanged) needsDeploy = true;

      let volume: CloudInstance | undefined =
        output?.volumeInstanceId !== undefined &&
        output.volumeInstanceId.length > 0
          ? yield* getVolumeByInstanceId(output.volumeInstanceId)
          : undefined;
      if (volume === undefined && output?.volumeId !== undefined) {
        volume = yield* findVolume(
          environmentId,
          projectId,
          (row) => row.volumeId === output.volumeId,
        );
      }
      if (volume === undefined) {
        volume = yield* findVolume(
          environmentId,
          projectId,
          (row) =>
            (row.serviceId ?? undefined) === current!.id ||
            row.volume.name === volumeName,
        );
      }
      if (volume === undefined) {
        const created = yield* volumeCreate({
          projectId,
          environmentId,
          mountPath: POSTGRES_MOUNT_PATH,
          serviceId: current.id,
          ...(props.region !== undefined ? { region: props.region } : {}),
        });
        if (created.name !== volumeName) {
          yield* stampVolumeName(created.id, volumeName);
        }
        volume = yield* waitForVolume(environmentId, projectId, created.id);
      }
      if (volume === undefined || isGoneVolume(volume)) {
        return yield* new PostgresVolumeNotCreated({
          name: volumeName,
          serviceId: current.id,
        });
      }
      if (volume.volume.name !== volumeName) {
        yield* stampVolumeName(volume.volumeId, volumeName);
      }
      const observedMount = volume.mountPath;
      const observedServiceId = volume.serviceId ?? undefined;
      const mountChanged = observedMount !== POSTGRES_MOUNT_PATH;
      const attached = observedServiceId === current.id;
      if (mountChanged || !attached) {
        yield* volumeInstanceUpdate(volume.volumeId, environmentId, {
          ...(mountChanged ? { mountPath: POSTGRES_MOUNT_PATH } : {}),
          ...(!attached ? { serviceId: current.id } : {}),
        });
        volume =
          (yield* waitForVolume(environmentId, projectId, volume.volumeId)) ??
          volume;
        needsDeploy = true;
      }

      let proxy = yield* findProxy(environmentId, current.id, POSTGRES_PORT);
      if (wantPublic && proxy === undefined) {
        const created = yield* tcpProxyCreate({
          applicationPort: POSTGRES_PORT,
          environmentId,
          serviceId: current.id,
        }).pipe(
          Effect.catchTag("RailwayValidationError", () =>
            Effect.succeed(undefined),
          ),
        );
        proxy =
          created !== undefined && !isGoneProxy(created)
            ? created
            : yield* findProxy(environmentId, current.id, POSTGRES_PORT);
      }
      if (!wantPublic && proxy !== undefined) {
        yield* deleteProxy(proxy.id);
        proxy = undefined;
      }

      if (needsDeploy || instance?.latestDeployment == null) {
        yield* serviceInstanceDeploy(environmentId, current.id).pipe(
          Effect.catchTag("RailwayValidationError", () => Effect.void),
        );
      }

      instance =
        (yield* waitForDeployment(environmentId, current.id)) ?? instance;
      let finalStatus = instance?.latestDeployment?.status;
      // A deployment can wedge in DEPLOYING and never reach SUCCESS — the
      // container may serve, but Railway keeps its per-environment operation
      // lock and the TCP proxy's routing is not committed. Converge: cancel
      // the wedged deployment, redeploy once, and insist on SUCCESS.
      if (!deployFailed(finalStatus) && !deployReady(finalStatus)) {
        const wedged = instance?.latestDeployment?.id;
        if (wedged != null && wedged.length > 0) {
          yield* deploymentCancel(wedged).pipe(
            Effect.catchTag("RailwayNotFound", () => Effect.void),
          );
        }
        yield* serviceInstanceDeploy(environmentId, current.id).pipe(
          Effect.catchTag("RailwayValidationError", () => Effect.void),
        );
        instance =
          (yield* waitForDeployment(environmentId, current.id)) ?? instance;
        finalStatus = instance?.latestDeployment?.status;
      }
      if (deployFailed(finalStatus) || !deployReady(finalStatus)) {
        return yield* new PostgresDeployFailed({
          serviceId: current.id,
          status: finalStatus ?? "failed",
          deploymentId: instance?.latestDeployment?.id,
        });
      }

      return toAttrs({
        service: current,
        instance,
        volume,
        proxy,
        projectId,
        environmentId,
        user,
        password,
        database,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const serviceId = output.serviceId;
      const environmentId = output.environmentId;
      // Cancel a still-running deployment first: it holds Railway's
      // per-environment operation lock ("Cannot delete TCP proxy: an
      // operation is already in progress") and can stall the service
      // teardown indefinitely. A finished deployment makes this a no-op.
      if (environmentId.length > 0 && serviceId.length > 0) {
        const instance = yield* getInstance(environmentId, serviceId);
        const latest = instance?.latestDeployment;
        if (
          latest?.id != null &&
          latest.id.length > 0 &&
          !deployReady(latest.status) &&
          !deployFailed(latest.status)
        ) {
          yield* deploymentCancel(latest.id).pipe(
            Effect.catchTag("RailwayNotFound", () => Effect.void),
          );
        }
      }
      // Delete the SERVICE next — its teardown cascades onto the proxies.
      if (serviceId.length > 0) {
        yield* serviceDelete(serviceId).pipe(
          Effect.catchTag("RailwayNotFound", () => Effect.void),
        );
        yield* waitUntilDeleted(
          "Service",
          serviceId,
          getById(serviceId).pipe(
            Effect.map((service) => service === undefined),
          ),
        );
      }
      // Proxies usually disappear with the service; wait for the cascade
      // instead of fighting the teardown's lock, then force-delete any
      // survivor (which no-ops on NotFound).
      if (environmentId.length > 0 && serviceId.length > 0) {
        const leftover = yield* listProxies(environmentId, serviceId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (rows) => rows.length === 0,
            times: 10,
          }),
        );
        yield* Effect.forEach(leftover, (proxy) => deleteProxy(proxy.id), {
          concurrency: 4,
        });
        yield* waitUntilDeleted(
          "TcpProxy",
          serviceId,
          listProxies(environmentId, serviceId).pipe(
            Effect.map((proxies) => proxies.length === 0),
          ),
        );
      } else if (
        output.tcpProxyId !== undefined &&
        output.tcpProxyId.length > 0
      ) {
        yield* deleteProxy(output.tcpProxyId);
      }
      if (output.volumeId.length > 0) {
        yield* volumeDelete(output.volumeId).pipe(
          Effect.catchTag("RailwayNotFound", () => Effect.void),
        );
        const check =
          output.volumeInstanceId.length > 0
            ? getVolumeByInstanceId(output.volumeInstanceId).pipe(
                Effect.map((instance) => instance === undefined),
              )
            : Effect.succeed(true);
        yield* waitUntilDeleted("Volume", output.volumeId, check);
      }
    }),
  });
