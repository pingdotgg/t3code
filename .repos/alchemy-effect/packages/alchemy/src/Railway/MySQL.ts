import {
  environmentServiceInstances,
  waitUntilDeleted,
  projectServices,
  environmentVolumes,
} from "./GraphQL.ts";
import { randomBytes } from "node:crypto";
import * as railway from "@distilled.cloud/railway";
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

type VolumeState = railway.Scalars["VolumeState"];

const serviceSelection = {
  id: true,
  name: true,
  deletedAt: true,
} as const satisfies railway.Selection<"Service">;
const attributeInstanceSelection = {
  source: { image: true },
  region: true,
  latestDeployment: { id: true, status: true },
} as const satisfies railway.Selection<"ServiceInstance">;
const instanceSelection = {
  ...attributeInstanceSelection,
  deletedAt: true,
  sleepApplication: true,
  startCommand: true,
} as const satisfies railway.Selection<"ServiceInstance">;
const volumeSelection = {
  id: true,
  volumeId: true,
  environmentId: true,
  serviceId: true,
  deletedAt: true,
  isPendingDeletion: true,
  state: true,
  mountPath: true,
  volume: { id: true, name: true },
} as const satisfies railway.Selection<"VolumeInstance">;
const proxySelection = {
  id: true,
  applicationPort: true,
  deletedAt: true,
  syncStatus: true,
  domain: true,
  proxyPort: true,
} as const satisfies railway.Selection<"TCPProxy">;
type ServiceResponse = railway.Result<"Service!", typeof serviceSelection>;
type CreateServiceResponse = railway.Result<
  "Service!",
  typeof serviceSelection
>;
type UpdateServiceResponse = railway.Result<
  "Service!",
  typeof serviceSelection
>;
type ProjectResponseServicesEdgesItemNode = railway.Result<
  "Service!",
  typeof serviceSelection
>;
type ServiceInstanceResponse = railway.Result<
  "ServiceInstance!",
  typeof instanceSelection
>;
type EnvironmentResponseVolumeInstancesEdgesItemNode = railway.Result<
  "VolumeInstance!",
  typeof volumeSelection
>;
type VolumeInstanceResponse = railway.Result<
  "VolumeInstance!",
  typeof volumeSelection
>;
type TcpProxiesResultItem = railway.Result<"TCPProxy!", typeof proxySelection>;
type CreateTcpProxyResponse = railway.Result<
  "TCPProxy!",
  typeof proxySelection
>;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export const DEFAULT_MYSQL_IMAGE = "mysql:9";
export const DEFAULT_MYSQL_USER = "root";
export const DEFAULT_MYSQL_DATABASE = "railway";
export const MYSQL_PORT = 3306;
export const MYSQL_MOUNT_PATH = "/var/lib/mysql";
export const MYSQL_URL_SECRET = "MYSQL_URL";
export const MYSQL_PUBLIC_URL_SECRET = "MYSQL_PUBLIC_URL";
/** Railway's official MySQL template start command (native AIO fails on volumes). */
export const DEFAULT_MYSQL_START_COMMAND =
  "docker-entrypoint.sh mysqld --innodb-use-native-aio=0 --disable-log-bin --performance_schema=0";

/**
 * Environment identity MySQL is deployed into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type MySQLEnvironment = {
  readonly environmentId: string;
};

export interface MySQLProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` or an Effect
   * that produces one. Changing the Project replaces MySQL.
   */
  project: Ref<Project>;
  /**
   * Environment to deploy into. Accepts a `Railway.Project` (primary
   * environment), a `Railway.Environment`, or `{ environmentId }`.
   * Defaults to the project's primary environment. Changing it replaces
   * MySQL.
   */
  environment?: Ref<MySQLEnvironment>;
  /**
   * Service name. Unique per Project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Used as the private
   * hostname `{name}.railway.internal`. Changing it updates in place.
   */
  name?: string;
  /**
   * MySQL image. Default is the official Docker Hub `mysql:9` tag.
   *
   * @default "mysql:9"
   */
  image?: string;
  /**
   * Region for the service instance and volume (`us-west2`, `us-east4`,
   * …). If omitted, Railway picks the default. Changing it replaces
   * MySQL.
   */
  region?: string;
  /**
   * Superuser name. Create-only (used at first `mysqld` init). Default
   * `root` matches Railway's `mysql()` helper.
   *
   * @default "root"
   */
  user?: string;
  /**
   * Superuser password. Wrap with `Redacted.make(...)`. If omitted, a
   * password is generated on first create and stored as
   * `MYSQL_ROOT_PASSWORD`. Create-only.
   */
  password?: Redacted.Redacted<string> | string;
  /**
   * Initial database name. Create-only.
   *
   * @default "railway"
   */
  database?: string;
  /**
   * Expose MySQL on a public TCP proxy (`*.proxy.rlwy.net`) for
   * laptop access and deploy-time migrations. In-service connections
   * always use `{name}.railway.internal`.
   *
   * @default true
   */
  public?: boolean;
}

export type MySQL = Resource<
  "Railway.MySQL",
  MySQLProps,
  {
    /** Railway service id for the MySQL container. */
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
    /** Volume id holding `/var/lib/mysql`. */
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
     * Private MySQL URI (`{name}.railway.internal:3306`). Prefer
     * {@link ConnectMySQL} from a {@link Service}.
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

const resolveMySQLProps = (
  props: MySQLProps | Effect.Effect<MySQLProps, never, Providers>,
): Effect.Effect<MySQLProps, never, Providers> =>
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
              MySQLEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    return { ...resolved, project, environment };
  });

const MySQLResource = Resource<MySQL>("Railway.MySQL");

/**
 * A Railway.MySQL is a MySQL-as-a-Service: the official `mysql` image,
 * a Volume at `/var/lib/mysql`, `MYSQL_*` / `MYSQL_URL` variables, and
 * an optional TCP proxy for the public URL. This is Alchemy's
 * `mysql()` helper (Railway IaC: `mysql("mysql")`).
 *
 * Private hostname is `{name}.railway.internal`. From a
 * {@link Service}, yield {@link ConnectMySQL}. From a laptop, use
 * `publicConnectionUri`.
 *
 * @see https://docs.railway.com/databases/mysql
 *
 * ### Create MySQL
 * Pass a Project. Alchemy generates a unique name, password, volume,
 * and a public TCP proxy.
 *
 * **Example:** Generated name
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const db = yield* Railway.MySQL("Db", { project: site });
 * ```
 *
 * :::caution[Changing `project` replaces MySQL]
 * A new service + volume are created in the new Project. The old
 * service and volume are deleted. Data is not copied.
 * :::
 *
 * ### Connect from a Service
 * Yield `ConnectMySQL` inside init. Provide
 * {@link ConnectMySQLHttp}. Pass `conn.connectionString` to
 * `Drizzle.MySQL` or `SQL.MySQL`. The binding packs the private
 * URI (`{name}.railway.internal`).
 *
 * **Example:** Bind and query
 * ```typescript
 * import * as Drizzle from "alchemy/Drizzle/MySQL";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   { project: Site, main: import.meta.url, build: { install: ["mysql2"] } },
 *   Effect.gen(function* () {
 *     const conn = yield* Railway.ConnectMySQL(Db);
 *     const db = yield* Drizzle.MySQL(conn.connectionString);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const rows = yield* db.execute("select 1 as ok", "objects");
 *         return HttpServerResponse.json({ rows });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Railway.ConnectMySQLHttp)),
 * ) {}
 * ```
 *
 * ### Public TCP
 * `public` (default `true`) creates a TCP proxy on 3306.
 * `publicConnectionUri` is `{domain}:{proxyPort}` for laptop access
 * and deploy-time migrations.
 *
 * **Example:** Private only
 * ```typescript
 * const db = yield* Railway.MySQL("Db", {
 *   project: site,
 *   public: false,
 * });
 * ```
 *
 * ### Image
 * Default is official MySQL 9. Pass `image` to pin another tag.
 *
 * **Example:** MySQL 8
 * ```typescript
 * const db = yield* Railway.MySQL("Db", {
 *   project: site,
 *   image: "mysql:8",
 * });
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope MySQL
 * ```typescript
 * // src/db.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Db = Railway.MySQL("Db", { project: Site });
 * ```
 *
 * @resource
 */
export const MySQL: typeof MySQLResource = Object.assign(
  (
    id: string,
    props: MySQLProps | Effect.Effect<MySQLProps, never, Providers>,
  ) => MySQLResource(id, resolveMySQLProps(props)),
  MySQLResource,
);

/**
 * IaC helper matching Railway's `mysql()`. Same resource as {@link MySQL}.
 */
export const mysql = MySQL;

export class MySQLNotCreated extends Data.TaggedError(
  "Railway.MySQLNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class MySQLProjectRequired extends Data.TaggedError(
  "Railway.MySQLProjectRequired",
)<{
  message: string;
}> {}

export class MySQLDeployFailed extends Data.TaggedError(
  "Railway.MySQLDeployFailed",
)<{
  serviceId: string;
  status: string;
  deploymentId: string | undefined;
}> {}

export class MySQLVolumeNotCreated extends Data.TaggedError(
  "Railway.MySQLVolumeNotCreated",
)<{
  name: string;
  serviceId: string;
}> {}

class MySQLPending extends Data.TaggedError("Railway.MySQLPending")<{
  serviceId: string;
  status: string;
}> {}

class MySQLDeployPending extends Data.TaggedError(
  "Railway.MySQLDeployPending",
)<{
  serviceId: string;
  status: string;
}> {}

class VolumePending extends Data.TaggedError("Railway.MySQLVolumePending")<{
  volumeId: string;
  state: string;
}> {}

type CloudService =
  | ServiceResponse
  | CreateServiceResponse
  | UpdateServiceResponse
  | ProjectResponseServicesEdgesItemNode;

type CloudInstance =
  | EnvironmentResponseVolumeInstancesEdgesItemNode
  | VolumeInstanceResponse;

type CloudProxy = TcpProxiesResultItem | CreateTcpProxyResponse;

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

const isMysqlImage = (image: string | null | undefined) =>
  image != null && /(^|\/)mysql([:-]|$)/i.test(image);

const mysqlStartCommand = (image: string) =>
  isMysqlImage(image) ? DEFAULT_MYSQL_START_COMMAND : undefined;

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

const isTemplateValue = (value: string | undefined) =>
  value !== undefined && value.includes("${{");

const privateConnectionUri = (input: {
  user: string;
  password: string;
  name: string;
  database: string;
}): string =>
  `mysql://${encodePart(input.user)}:${encodePart(input.password)}@${input.name}.railway.internal:${MYSQL_PORT}/${encodePart(input.database)}`;

const publicConnectionUri = (input: {
  user: string;
  password: string;
  domain: string;
  port: number;
  database: string;
}): string =>
  `mysql://${encodePart(input.user)}:${encodePart(input.password)}@${input.domain}:${input.port}/${encodePart(input.database)}`;

const desiredVariables = (input: {
  user: string;
  password: string;
  database: string;
}): Record<string, string> => {
  const vars: Record<string, string> = {
    MYSQL_ROOT_PASSWORD: input.password,
    MYSQL_DATABASE: input.database,
    MYSQLHOST: "${{RAILWAY_PRIVATE_DOMAIN}}",
    MYSQLPORT: String(MYSQL_PORT),
    MYSQLUSER: input.user,
    MYSQLPASSWORD: input.password,
    MYSQLDATABASE: input.database,
    [MYSQL_URL_SECRET]:
      "mysql://${{MYSQLUSER}}:${{MYSQLPASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:3306/${{MYSQLDATABASE}}",
    [MYSQL_PUBLIC_URL_SECRET]:
      "mysql://${{MYSQLUSER}}:${{MYSQLPASSWORD}}@${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}/${{MYSQLDATABASE}}",
  };
  if (input.user !== "root") {
    vars.MYSQL_USER = input.user;
    vars.MYSQL_PASSWORD = input.password;
  }
  return vars;
};

const toAttrs = (input: {
  service: CloudService;
  instance:
    | railway.Result<"ServiceInstance!", typeof attributeInstanceSelection>
    | undefined;
  volume: CloudInstance | undefined;
  proxy: CloudProxy | undefined;
  projectId: string;
  environmentId: string;
  user: string;
  password: string;
  database: string;
}): MySQL["Attributes"] => {
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

const getById = (serviceId: string) =>
  railway.service({ id: serviceId }, serviceSelection).pipe(
    Effect.map((service) => (isGoneService(service) ? undefined : service)),
    railway.catchTags(["RailwayNotFound"], () => Effect.succeed(undefined)),
  );

const getInstance = (environmentId: string, serviceId: string) =>
  railway.serviceInstance({ environmentId, serviceId }, instanceSelection).pipe(
    Effect.map((instance) => (isGoneInstance(instance) ? undefined : instance)),
    railway.catchTags(["RailwayNotFound"], () => Effect.succeed(undefined)),
  );

const listProjectServices = (projectId: string) =>
  projectServices(projectId, serviceSelection).pipe(
    Effect.map((services) => services.filter((node) => !isGoneService(node))),
    railway.catchTags(["RailwayNotFound"], () =>
      Effect.succeed([] as ProjectResponseServicesEdgesItemNode[]),
    ),
  );

const findByName = (projectId: string, name: string) =>
  listProjectServices(projectId).pipe(
    Effect.map((services) => services.find((service) => service.name === name)),
  );

const getVolumeByInstanceId = (volumeInstanceId: string) =>
  railway.volumeInstance({ id: volumeInstanceId }, volumeSelection).pipe(
    Effect.map((instance) => (isGoneVolume(instance) ? undefined : instance)),
    railway.catchTags(["RailwayNotFound"], () => Effect.succeed(undefined)),
  );

const listVolumeInstances = (environmentId: string, projectId: string) =>
  environmentVolumes(environmentId, projectId, volumeSelection).pipe(
    Effect.map((instances) => instances.filter((node) => !isGoneVolume(node))),
    railway.catchTags(["RailwayNotFound"], () =>
      Effect.succeed([] as EnvironmentResponseVolumeInstancesEdgesItemNode[]),
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
  railway.tcpProxies({ environmentId, serviceId }, proxySelection).pipe(
    Effect.map((items) => items.filter((proxy) => !isGoneProxy(proxy))),
    railway.catchTags(["RailwayNotFound"], () =>
      Effect.succeed([] as TcpProxiesResultItem[]),
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
  railway.deleteTcpProxy({ id }).pipe(
    Effect.retry({
      while: (e) => railway.isErrorTag(e, "RailwayOperationInProgress"),
      schedule: Schedule.spaced("3 seconds"),
      times: 10,
    }),
    railway.catchTags(["RailwayNotFound"], () => Effect.void),
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
  railway
    .variables({
      projectId,
      environmentId,
      serviceId,
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      railway.catchTags(["RailwayNotFound"], () =>
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
  railway.upsertVariable({
    input: {
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      name: input.name,
      value: input.value,
      skipDeploys: true,
    },
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
        return Effect.fail(new MySQLPending({ serviceId, status: "creating" }));
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.MySQLPending",
      // serviceCreate fans the instance out to each environment
      // asynchronously; wait a bounded interval for it to appear.
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.MySQLPending", () =>
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
        new MySQLDeployPending({
          serviceId,
          status: status ?? "pending",
        }),
      );
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.MySQLDeployPending",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.catchTag("Railway.MySQLDeployPending", () =>
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
      while: (e) => e._tag === "Railway.MySQLVolumePending",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.catchTag("Railway.MySQLVolumePending", () => observe),
  );
};

const stampVolumeName = (volumeId: string, name: string) =>
  railway.updateVolume(
    {
      volumeId,
      input: { name },
    },
    { id: true },
  );

const passwordFromVars = (
  vars: Record<string, string>,
  fallback?: string,
): string | undefined => {
  const root = vars.MYSQL_ROOT_PASSWORD;
  if (root !== undefined && root.length > 0 && !isTemplateValue(root)) {
    return root;
  }
  const userPass = vars.MYSQLPASSWORD;
  if (
    userPass !== undefined &&
    userPass.length > 0 &&
    !isTemplateValue(userPass)
  ) {
    return userPass;
  }
  return fallback !== undefined && fallback.length > 0 ? fallback : undefined;
};

export const MySQLProvider = () =>
  Provider.succeed(MySQL, {
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
          ? yield* findProxy(resolvedEnvId, found.id, MYSQL_PORT)
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
        user:
          vars.MYSQLUSER ??
          vars.MYSQL_USER ??
          output?.user ??
          DEFAULT_MYSQL_USER,
        password: passwordFromVars(vars) ?? "",
        database:
          vars.MYSQLDATABASE ??
          vars.MYSQL_DATABASE ??
          output?.database ??
          DEFAULT_MYSQL_DATABASE,
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
          const envIds = yield* railway.environments
            .items(
              { projectId: project.projectId, first: 50 },
              { id: true, deletedAt: true },
            )
            .pipe(
              Stream.filter((env) => env.deletedAt == null),
              Stream.map((env) => env.id),
              Stream.runCollect,
              railway.catchTags("RailwayNotFound", () => Effect.succeed([])),
            );
          const items = yield* Effect.forEach(envIds, (environmentId) =>
            Effect.gen(function* () {
              const instances = (yield* environmentServiceInstances(
                environmentId,
                project.projectId,
                {
                  ...attributeInstanceSelection,
                  serviceId: true,
                  deletedAt: true,
                },
              )).filter(
                (instance) =>
                  instance.deletedAt == null &&
                  services.has(instance.serviceId) &&
                  isMysqlImage(instance.source?.image),
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
                        user: DEFAULT_MYSQL_USER,
                        password: "",
                        database: DEFAULT_MYSQL_DATABASE,
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
      const props = news ?? ({} as MySQLProps);
      const projectId = projectIdOf(props.project) ?? output?.projectId;
      if (projectId === undefined) {
        return yield* new MySQLProjectRequired({
          message: "MySQL requires a resolved Railway.Project",
        });
      }
      const environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.project) ??
        output?.environmentId;
      if (environmentId === undefined) {
        return yield* new MySQLProjectRequired({
          message:
            "MySQL requires a Railway environment (pass environment or a Project with environmentId)",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);
      const sourceImage = props.image ?? DEFAULT_MYSQL_IMAGE;
      const wantPublic = props.public !== false;
      const volumeName = yield* createRailwayName(`${id}-mysqldata`);
      const startCommand = mysqlStartCommand(sourceImage);

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
        existingVars.MYSQLUSER ??
        existingVars.MYSQL_USER ??
        props.user ??
        DEFAULT_MYSQL_USER;
      const database =
        existingVars.MYSQLDATABASE ??
        existingVars.MYSQL_DATABASE ??
        props.database ??
        DEFAULT_MYSQL_DATABASE;
      const password =
        passwordFromVars(existingVars) ??
        (props.password !== undefined
          ? unwrapSecret(props.password)
          : undefined) ??
        (yield* generatePassword);
      const variables = desiredVariables({ user, password, database });

      if (current === undefined) {
        const created = yield* railway
          .createService(
            {
              input: {
                projectId,
                environmentId,
                name,
                source: { image: sourceImage },
                variables,
              },
            },
            serviceSelection,
          )
          .pipe(
            railway.catchTags("RailwayValidationError", () =>
              Effect.succeed(undefined),
            ),
          );
        current = created ?? (yield* findByName(projectId, name));
      }

      if (current === undefined || isGoneService(current)) {
        return yield* new MySQLNotCreated({ name, projectId });
      }

      if (current.name !== name) {
        current = yield* railway.updateService(
          {
            id: current.id,
            input: { name },
          },
          serviceSelection,
        );
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
      const observedStart = instance?.startCommand ?? undefined;
      const startChanged =
        startCommand !== undefined && observedStart !== startCommand;
      if (imageChanged || regionChanged || sleepOn || startChanged) {
        yield* railway.updateServiceInstance({
          environmentId,
          serviceId: current.id,
          input: {
            ...(imageChanged ? { source: { image: sourceImage } } : {}),
            ...(regionChanged ? { region: props.region } : {}),
            ...(sleepOn ? { sleepApplication: false } : {}),
            ...(startChanged ? { startCommand } : {}),
          },
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
        const created = yield* railway.createVolume(
          {
            input: {
              projectId,
              environmentId,
              mountPath: MYSQL_MOUNT_PATH,
              serviceId: current.id,
              ...(props.region !== undefined ? { region: props.region } : {}),
            },
          },
          { id: true, name: true },
        );
        if (created.name !== volumeName) {
          yield* stampVolumeName(created.id, volumeName);
        }
        volume = yield* waitForVolume(environmentId, projectId, created.id);
      }
      if (volume === undefined || isGoneVolume(volume)) {
        return yield* new MySQLVolumeNotCreated({
          name: volumeName,
          serviceId: current.id,
        });
      }
      if (volume.volume.name !== volumeName) {
        yield* stampVolumeName(volume.volumeId, volumeName);
      }
      const observedMount = volume.mountPath;
      const observedServiceId = volume.serviceId ?? undefined;
      const mountChanged = observedMount !== MYSQL_MOUNT_PATH;
      const attached = observedServiceId === current.id;
      if (mountChanged || !attached) {
        yield* railway.updateVolumeInstance({
          volumeId: volume.volumeId,
          environmentId,
          input: {
            ...(mountChanged ? { mountPath: MYSQL_MOUNT_PATH } : {}),
            ...(!attached ? { serviceId: current.id } : {}),
          },
        });
        volume =
          (yield* waitForVolume(environmentId, projectId, volume.volumeId)) ??
          volume;
        needsDeploy = true;
      }

      let proxy = yield* findProxy(environmentId, current.id, MYSQL_PORT);
      if (wantPublic && proxy === undefined) {
        const created = yield* railway
          .createTcpProxy(
            {
              input: {
                applicationPort: MYSQL_PORT,
                environmentId,
                serviceId: current.id,
              },
            },
            proxySelection,
          )
          .pipe(
            railway.catchTags("RailwayValidationError", () =>
              Effect.succeed(undefined),
            ),
          );
        proxy =
          created !== undefined && !isGoneProxy(created)
            ? created
            : yield* findProxy(environmentId, current.id, MYSQL_PORT);
      }
      if (!wantPublic && proxy !== undefined) {
        yield* deleteProxy(proxy.id);
        proxy = undefined;
      }

      if (needsDeploy || instance?.latestDeployment == null) {
        yield* railway
          .serviceInstanceDeployV2({
            environmentId,
            serviceId: current.id,
          })
          .pipe(railway.catchTags("RailwayValidationError", () => Effect.void));
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
          yield* railway
            .cancelDeployment({ id: wedged })
            .pipe(railway.catchTags("RailwayNotFound", () => Effect.void));
        }
        yield* railway
          .serviceInstanceDeployV2({ environmentId, serviceId: current.id })
          .pipe(railway.catchTags("RailwayValidationError", () => Effect.void));
        instance =
          (yield* waitForDeployment(environmentId, current.id)) ?? instance;
        finalStatus = instance?.latestDeployment?.status;
      }
      if (deployFailed(finalStatus) || !deployReady(finalStatus)) {
        return yield* new MySQLDeployFailed({
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
          yield* railway
            .cancelDeployment({ id: latest.id })
            .pipe(railway.catchTags("RailwayNotFound", () => Effect.void));
        }
      }
      // Delete the SERVICE next — its teardown cascades onto the proxies.
      if (serviceId.length > 0) {
        yield* railway
          .deleteService({ id: serviceId })
          .pipe(railway.catchTags(["RailwayNotFound"], () => Effect.void));
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
        yield* railway
          .deleteVolume({ volumeId: output.volumeId })
          .pipe(railway.catchTags(["RailwayNotFound"], () => Effect.void));
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
