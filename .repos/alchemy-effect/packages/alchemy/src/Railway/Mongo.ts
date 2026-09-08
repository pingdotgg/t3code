import { randomBytes } from "node:crypto";
import type {
  EnvironmentResponseVolumeInstancesEdgesItemNode,
  ProjectResponseServicesEdgesItemNode,
  ServiceCreateResponse,
  ServiceInstanceResponse,
  ServiceResponse,
  ServiceUpdateResponse,
  TcpProxiesResultItem,
  TcpProxyCreateResponse,
  VolumeInstanceResponse,
  VolumeState,
} from "@distilled.cloud/railway";
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

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export const DEFAULT_MONGO_IMAGE = "mongo:8";
export const DEFAULT_MONGO_USER = "mongo";
export const DEFAULT_MONGO_DATABASE = "railway";
export const MONGO_PORT = 27017;
export const MONGO_MOUNT_PATH = "/data/db";
export const MONGO_URL_SECRET = "MONGO_URL";
export const MONGO_PUBLIC_URL_SECRET = "MONGO_PUBLIC_URL";
/**
 * Official Mongo image must bind IPv6 so `{name}.railway.internal` works.
 * `docker-entrypoint.sh` is required so `MONGO_INITDB_ROOT_*` still runs.
 */
export const MONGO_START_COMMAND =
  "docker-entrypoint.sh mongod --ipv6 --bind_ip ::,0.0.0.0 --setParameter diagnosticDataCollectionEnabled=false";

/**
 * Environment identity Mongo is deployed into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type MongoEnvironment = {
  readonly environmentId: string;
};

export interface MongoProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` or an Effect
   * that produces one. Changing the Project replaces Mongo.
   */
  project: Ref<Project>;
  /**
   * Environment to deploy into. Accepts a `Railway.Project` (primary
   * environment), a `Railway.Environment`, or `{ environmentId }`.
   * Defaults to the project's primary environment. Changing it replaces
   * Mongo.
   */
  environment?: Ref<MongoEnvironment>;
  /**
   * Service name. Unique per Project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Used as the private
   * hostname `{name}.railway.internal`. Changing it updates in place.
   */
  name?: string;
  /**
   * MongoDB image. Default is the official `mongo:8` tag.
   *
   * @default "mongo:8"
   */
  image?: string;
  /**
   * Region for the service instance and volume (`us-west2`, `us-east4`,
   * …). If omitted, Railway picks the default. Changing it replaces
   * Mongo.
   */
  region?: string;
  /**
   * Root username. Create-only (used at `MONGO_INITDB_ROOT_USERNAME`).
   *
   * @default "mongo"
   */
  user?: string;
  /**
   * Root password. Wrap with `Redacted.make(...)`. If omitted, a
   * password is generated on first create and stored as
   * `MONGO_INITDB_ROOT_PASSWORD`. Create-only.
   */
  password?: Redacted.Redacted<string> | string;
  /**
   * Initial database name (`MONGO_INITDB_DATABASE`). Create-only.
   *
   * @default "railway"
   */
  database?: string;
  /**
   * Expose Mongo on a public TCP proxy (`*.proxy.rlwy.net`) for
   * laptop access. In-service connections always use
   * `{name}.railway.internal`.
   *
   * @default true
   */
  public?: boolean;
}

export type Mongo = Resource<
  "Railway.Mongo",
  MongoProps,
  {
    /** Railway service id for the Mongo container. */
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
    /** Volume id holding `/data/db`. */
    volumeId: string;
    /** Volume instance id in the target environment. */
    volumeInstanceId: string;
    /** TCP proxy id, when `public` is enabled. */
    tcpProxyId: string | undefined;
    /** Public proxy hostname (`*.proxy.rlwy.net`). */
    tcpProxyDomain: string | undefined;
    /** Public proxy port. Pair with `tcpProxyDomain`. */
    tcpProxyPort: number | undefined;
    /** Root username. */
    user: string;
    /** Database name. */
    database: string;
    /**
     * Private Mongo URI (`{name}.railway.internal:27017`). Prefer
     * {@link ConnectMongo} from a {@link Service}.
     */
    connectionUri: string;
    /**
     * Public TCP-proxy URI. Empty when `public` is false. Use this from
     * the laptop.
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

const resolveMongoProps = (
  props: MongoProps | Effect.Effect<MongoProps, never, Providers>,
): Effect.Effect<MongoProps, never, Providers> =>
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
              MongoEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    return { ...resolved, project, environment };
  });

const MongoResource = Resource<Mongo>("Railway.Mongo");

/**
 * A Railway.Mongo is MongoDB-as-a-Service: the official `mongo` image, a
 * Volume at `/data/db`, `MONGO_*` / `MONGO_URL` variables, IPv6 bind for
 * the private network, and an optional TCP proxy for the public URL.
 *
 * Private hostname is `{name}.railway.internal`. From a
 * {@link Service}, yield {@link ConnectMongo}. From a laptop, use
 * `publicConnectionUri`. The IaC helper is {@link mongo}.
 *
 * @see https://docs.railway.com/databases/mongodb
 *
 * ### Create Mongo
 * Pass a Project. Alchemy generates a unique name, password, volume,
 * and a public TCP proxy.
 *
 * **Example:** Generated name
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const db = yield* Railway.mongo("Db", { project: site });
 * ```
 *
 * :::caution[Changing `project` replaces Mongo]
 * A new service + volume are created in the new Project. The old
 * service and volume are deleted. Data is not copied.
 * :::
 *
 * ### Connect from a Service
 * Yield `ConnectMongo` inside init. Provide
 * {@link ConnectMongoHttp}. Pass `conn.connectionString` to the
 * MongoDB driver (or {@link pingMongo}). The binding packs the private
 * URI (`{name}.railway.internal`).
 *
 * **Example:** Bind and ping
 * ```typescript
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   { project: Site, main: import.meta.url, build: { install: ["mongodb"] } },
 *   Effect.gen(function* () {
 *     const conn = yield* Railway.ConnectMongo(Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const url = yield* conn.connectionString;
 *         const ping = yield* Railway.pingMongo(Redacted.value(url));
 *         return HttpServerResponse.json(ping);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Railway.ConnectMongoHttp)),
 * ) {}
 * ```
 *
 * ### Public TCP
 * `public` (default `true`) creates a TCP proxy on 27017.
 * `publicConnectionUri` is `{domain}:{proxyPort}` for laptop access.
 *
 * **Example:** Private only
 * ```typescript
 * const db = yield* Railway.mongo("Db", {
 *   project: site,
 *   public: false,
 * });
 * ```
 *
 * ### Image
 * Default is official Mongo 8. Pass `image` to pin another tag.
 *
 * **Example:** Mongo 7
 * ```typescript
 * const db = yield* Railway.mongo("Db", {
 *   project: site,
 *   image: "mongo:7",
 * });
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Mongo
 * ```typescript
 * // src/db.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Db = Railway.mongo("Db", { project: Site });
 * ```
 *
 * @resource
 */
export const Mongo: typeof MongoResource = Object.assign(
  (
    id: string,
    props: MongoProps | Effect.Effect<MongoProps, never, Providers>,
  ) => MongoResource(id, resolveMongoProps(props)),
  MongoResource,
);

/**
 * IaC helper matching Railway's `mongo()`. Same resource as {@link Mongo}.
 */
export const mongo = Mongo;

export class MongoNotCreated extends Data.TaggedError(
  "Railway.MongoNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class MongoProjectRequired extends Data.TaggedError(
  "Railway.MongoProjectRequired",
)<{
  message: string;
}> {}

export class MongoDeployFailed extends Data.TaggedError(
  "Railway.MongoDeployFailed",
)<{
  serviceId: string;
  status: string;
  deploymentId: string | undefined;
}> {}

export class MongoVolumeNotCreated extends Data.TaggedError(
  "Railway.MongoVolumeNotCreated",
)<{
  name: string;
  serviceId: string;
}> {}

export class MongoCommandError extends Data.TaggedError(
  "Railway.MongoCommandError",
)<{
  cause: unknown;
}> {
  override get message() {
    return String(this.cause);
  }
}

class MongoPending extends Data.TaggedError("Railway.MongoPending")<{
  serviceId: string;
  status: string;
}> {}

class MongoDeployPending extends Data.TaggedError(
  "Railway.MongoDeployPending",
)<{
  serviceId: string;
  status: string;
}> {}

class VolumePending extends Data.TaggedError("Railway.MongoVolumePending")<{
  volumeId: string;
  state: string;
}> {}

type CloudService =
  | ServiceResponse
  | ServiceCreateResponse
  | ServiceUpdateResponse
  | ProjectResponseServicesEdgesItemNode;

type CloudInstance =
  | EnvironmentResponseVolumeInstancesEdgesItemNode
  | VolumeInstanceResponse;

type CloudProxy = TcpProxiesResultItem | TcpProxyCreateResponse;

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
  const bytes = randomBytes(24);
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

const alreadyExists = (message: string) =>
  /already exists|already in use|duplicate/i.test(message);

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

const normalizeStart = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim();

const isMongoImage = (image: string | null | undefined) =>
  image != null && /(^|\/)mongo(:|$)/i.test(image);

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

const privateConnectionUri = (input: {
  user: string;
  password: string;
  name: string;
  database: string;
}): string =>
  `mongodb://${encodePart(input.user)}:${encodePart(input.password)}@${input.name}.railway.internal:${MONGO_PORT}/${encodePart(input.database)}?authSource=admin&directConnection=true`;

const publicConnectionUri = (input: {
  user: string;
  password: string;
  domain: string;
  port: number;
  database: string;
}): string =>
  `mongodb://${encodePart(input.user)}:${encodePart(input.password)}@${input.domain}:${input.port}/${encodePart(input.database)}?authSource=admin&directConnection=true`;

const desiredVariables = (input: {
  user: string;
  password: string;
  database: string;
}): Record<string, string> => ({
  MONGO_INITDB_ROOT_USERNAME: input.user,
  MONGO_INITDB_ROOT_PASSWORD: input.password,
  MONGO_INITDB_DATABASE: input.database,
  MONGOUSER: "${{MONGO_INITDB_ROOT_USERNAME}}",
  MONGOPASSWORD: "${{MONGO_INITDB_ROOT_PASSWORD}}",
  MONGOHOST: "${{RAILWAY_PRIVATE_DOMAIN}}",
  MONGOPORT: String(MONGO_PORT),
  [MONGO_URL_SECRET]:
    "mongodb://${{MONGO_INITDB_ROOT_USERNAME}}:${{MONGO_INITDB_ROOT_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:27017",
  [MONGO_PUBLIC_URL_SECRET]:
    "mongodb://${{MONGO_INITDB_ROOT_USERNAME}}:${{MONGO_INITDB_ROOT_PASSWORD}}@${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}",
});

const toAttrs = (input: {
  service: CloudService;
  instance: ServiceInstanceResponse | undefined;
  volume: CloudInstance | undefined;
  proxy: CloudProxy | undefined;
  projectId: string;
  environmentId: string;
  user: string;
  password: string;
  database: string;
}): Mongo["Attributes"] => {
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
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) => (isGoneService(service) ? undefined : service)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const getInstance = (environmentId: string, serviceId: string) =>
  railway.serviceInstance({ environmentId, serviceId }).pipe(
    Effect.map((instance) => (isGoneInstance(instance) ? undefined : instance)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listProjectServices = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) =>
      project.services.edges
        .map((edge) => edge.node)
        .filter((node) => !isGoneService(node)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as ProjectResponseServicesEdgesItemNode[]),
    ),
  );

const findByName = (projectId: string, name: string) =>
  listProjectServices(projectId).pipe(
    Effect.map((services) => services.find((service) => service.name === name)),
  );

const getVolumeByInstanceId = (volumeInstanceId: string) =>
  railway.volumeInstance({ id: volumeInstanceId }).pipe(
    Effect.map((instance) => (isGoneVolume(instance) ? undefined : instance)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listVolumeInstances = (environmentId: string, projectId: string) =>
  railway.environment({ id: environmentId, projectId }).pipe(
    Effect.map((env) =>
      env.deletedAt != null
        ? []
        : env.volumeInstances.edges
            .map((edge) => edge.node)
            .filter((node) => !isGoneVolume(node)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
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
  railway.tcpProxies({ environmentId, serviceId }).pipe(
    Effect.map((items) => items.filter((proxy) => !isGoneProxy(proxy))),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
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
  railway.tcpProxyDelete({ id }).pipe(
    Effect.retry({
      while: (e) =>
        e._tag === "RailwayInternalError" &&
        e.message.includes("operation is already in progress"),
      schedule: Schedule.spaced("3 seconds"),
      times: 20,
    }),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
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
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
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
  railway.variableUpsert({
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
        return Effect.fail(new MongoPending({ serviceId, status: "creating" }));
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.MongoPending",
      // serviceCreate fans the instance out to each environment
      // asynchronously; under full-suite load the fan-out can take minutes.
      times: 60,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.MongoPending", () =>
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
        new MongoDeployPending({
          serviceId,
          status: status ?? "pending",
        }),
      );
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.MongoDeployPending",
      // Queued builds under full-suite load can exceed 3 minutes — allow ~8.
      times: 96,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.catchTag("Railway.MongoDeployPending", () =>
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
      while: (e) => e._tag === "Railway.MongoVolumePending",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.catchTag("Railway.MongoVolumePending", () => observe),
  );
};

const stampVolumeName = (volumeId: string, name: string) =>
  railway.volumeUpdate({
    volumeId,
    input: { name },
  });

/**
 * Ping a MongoDB deployment. Used from tests over the public TCP proxy
 * and from a {@link Service} with {@link ConnectMongo}.
 */
export const pingMongo = (
  url: string,
): Effect.Effect<{ ok: number }, MongoCommandError> =>
  Effect.tryPromise({
    try: async () => {
      const { MongoClient } = await import("mongodb");
      const client = new MongoClient(url, {
        directConnection: true,
        serverSelectionTimeoutMS: 8000,
      });
      try {
        await client.connect();
        const result = await client.db("admin").command({ ping: 1 });
        return { ok: Number(result.ok) };
      } finally {
        await client.close().catch(() => {});
      }
    },
    catch: (cause) => new MongoCommandError({ cause }),
  });

export const MongoProvider = () =>
  Provider.succeed(Mongo, {
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
          ? yield* findProxy(resolvedEnvId, found.id, MONGO_PORT)
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
          vars.MONGO_INITDB_ROOT_USERNAME ?? output?.user ?? DEFAULT_MONGO_USER,
        password: vars.MONGO_INITDB_ROOT_PASSWORD ?? "",
        database:
          vars.MONGO_INITDB_DATABASE ??
          output?.database ??
          DEFAULT_MONGO_DATABASE,
      });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const services = yield* listProjectServices(project.projectId);
          const envRows = yield* railway.environments
            .items({ projectId: project.projectId, first: 50 })
            .pipe(
              Stream.filter((env) => env.deletedAt == null),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
                Effect.succeed([]),
              ),
            );
          const volumes = envRows.flatMap((env) =>
            env.volumeInstances.edges.map((edge) => edge.node),
          );
          const items = yield* Effect.forEach(
            services.filter((service) =>
              matchesAlchemyPhysicalName(service.name),
            ),
            (service) =>
              Effect.gen(function* () {
                const volume = volumes.find(
                  (row) => (row.serviceId ?? undefined) === service.id,
                );
                const envIds =
                  volume !== undefined
                    ? [volume.environmentId]
                    : envRows.map((env) => env.id);
                let instance: ServiceInstanceResponse | undefined;
                let environmentId = project.environmentId;
                for (const id of envIds) {
                  const candidate = yield* getInstance(id, service.id);
                  if (isMongoImage(candidate?.source?.image)) {
                    instance = candidate;
                    environmentId = id;
                    break;
                  }
                }
                if (!isMongoImage(instance?.source?.image)) {
                  return undefined;
                }
                return toAttrs({
                  service,
                  instance,
                  volume,
                  proxy: undefined,
                  projectId: project.projectId,
                  environmentId,
                  user: DEFAULT_MONGO_USER,
                  password: "",
                  database: DEFAULT_MONGO_DATABASE,
                });
              }),
          );
          return items.filter((item) => item !== undefined);
        }),
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as MongoProps);
      const projectId = projectIdOf(props.project) ?? output?.projectId;
      if (projectId === undefined) {
        return yield* new MongoProjectRequired({
          message: "Mongo requires a resolved Railway.Project",
        });
      }
      const environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.project) ??
        output?.environmentId;
      if (environmentId === undefined) {
        return yield* new MongoProjectRequired({
          message:
            "Mongo requires a Railway environment (pass environment or a Project with environmentId)",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);
      const sourceImage = props.image ?? DEFAULT_MONGO_IMAGE;
      const wantPublic = props.public !== false;
      const volumeName = yield* createRailwayName(`${id}-data`);

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
        existingVars.MONGO_INITDB_ROOT_USERNAME ??
        props.user ??
        DEFAULT_MONGO_USER;
      const database =
        existingVars.MONGO_INITDB_DATABASE ??
        props.database ??
        DEFAULT_MONGO_DATABASE;
      const password =
        existingVars.MONGO_INITDB_ROOT_PASSWORD ??
        (props.password !== undefined
          ? unwrapSecret(props.password)
          : undefined) ??
        (yield* generatePassword);
      const variables = desiredVariables({ user, password, database });

      if (current === undefined) {
        const created = yield* railway
          .serviceCreate({
            input: {
              projectId,
              environmentId,
              name,
              source: { image: sourceImage },
              variables,
            },
          })
          .pipe(
            Effect.catchTag("RailwayValidationError", (e) =>
              alreadyExists(e.message)
                ? Effect.succeed(undefined)
                : Effect.fail(e),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = created ?? (yield* findByName(projectId, name));
      }

      if (current === undefined || isGoneService(current)) {
        return yield* new MongoNotCreated({ name, projectId });
      }

      if (current.name !== name) {
        current = yield* railway.serviceUpdate({
          id: current.id,
          input: { name },
        });
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
      const startChanged =
        normalizeStart(instance?.startCommand) !==
        normalizeStart(MONGO_START_COMMAND);
      if (imageChanged || regionChanged || sleepOn || startChanged) {
        yield* railway.serviceInstanceUpdate({
          environmentId,
          serviceId: current.id,
          input: {
            ...(imageChanged ? { source: { image: sourceImage } } : {}),
            ...(regionChanged ? { region: props.region } : {}),
            ...(sleepOn ? { sleepApplication: false } : {}),
            ...(startChanged ? { startCommand: MONGO_START_COMMAND } : {}),
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
        const created = yield* railway.volumeCreate({
          input: {
            projectId,
            environmentId,
            mountPath: MONGO_MOUNT_PATH,
            serviceId: current.id,
            ...(props.region !== undefined ? { region: props.region } : {}),
          },
        });
        if (created.name !== volumeName) {
          yield* stampVolumeName(created.id, volumeName);
        }
        const createdNode = created.volumeInstances.edges
          .map((edge) => edge.node)
          .find(
            (node) =>
              (node.volumeId === created.id || node.volume.id === created.id) &&
              (node.deletedAt == null || node.deletedAt.length === 0) &&
              !goneVolumeState(node.state),
          );
        volume = yield* waitForVolume(
          environmentId,
          projectId,
          created.id,
          createdNode?.id,
        );
        needsDeploy = true;
      }
      if (volume === undefined || isGoneVolume(volume)) {
        return yield* new MongoVolumeNotCreated({
          name: volumeName,
          serviceId: current.id,
        });
      }
      if (volume.volume.name !== volumeName) {
        yield* stampVolumeName(volume.volumeId, volumeName);
      }
      const observedMount = volume.mountPath;
      const observedServiceId = volume.serviceId ?? undefined;
      const mountChanged = observedMount !== MONGO_MOUNT_PATH;
      const attached = observedServiceId === current.id;
      if (mountChanged || !attached) {
        yield* railway.volumeInstanceUpdate({
          volumeId: volume.volumeId,
          environmentId,
          input: {
            ...(mountChanged ? { mountPath: MONGO_MOUNT_PATH } : {}),
            ...(!attached ? { serviceId: current.id } : {}),
          },
        });
        volume =
          (yield* waitForVolume(environmentId, projectId, volume.volumeId)) ??
          volume;
        needsDeploy = true;
      }

      let proxy = yield* findProxy(environmentId, current.id, MONGO_PORT);
      if (wantPublic && proxy === undefined) {
        const created = yield* railway
          .tcpProxyCreate({
            input: {
              applicationPort: MONGO_PORT,
              environmentId,
              serviceId: current.id,
            },
          })
          .pipe(
            Effect.catchTag("RailwayValidationError", () =>
              Effect.succeed(undefined),
            ),
          );
        proxy =
          created !== undefined && !isGoneProxy(created)
            ? created
            : yield* findProxy(environmentId, current.id, MONGO_PORT);
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
          .pipe(Effect.catchTag("RailwayValidationError", () => Effect.void));
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
          yield* railway.deploymentCancel({ id: wedged }).pipe(Effect.ignore);
        }
        yield* railway
          .serviceInstanceDeployV2({ environmentId, serviceId: current.id })
          .pipe(Effect.catchTag("RailwayValidationError", () => Effect.void));
        instance =
          (yield* waitForDeployment(environmentId, current.id)) ?? instance;
        finalStatus = instance?.latestDeployment?.status;
      }
      if (deployFailed(finalStatus) || !deployReady(finalStatus)) {
        return yield* new MongoDeployFailed({
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
            .deploymentCancel({ id: latest.id })
            .pipe(Effect.ignore);
        }
      }
      // Delete the SERVICE next — its teardown cascades onto the proxies.
      if (serviceId.length > 0) {
        yield* railway
          .serviceDelete({
            id: serviceId,
            ...(environmentId.length > 0 ? { environmentId } : {}),
          })
          .pipe(
            Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
          );
        yield* getById(serviceId).pipe(
          Effect.map((service) => service === undefined),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (gone) => gone,
            times: 8,
          }),
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
            times: 20,
          }),
        );
        yield* Effect.forEach(leftover, (proxy) => deleteProxy(proxy.id), {
          concurrency: 4,
        });
      } else if (
        output.tcpProxyId !== undefined &&
        output.tcpProxyId.length > 0
      ) {
        yield* deleteProxy(output.tcpProxyId);
      }
      if (output.volumeId.length > 0) {
        yield* railway
          .volumeDelete({ volumeId: output.volumeId })
          .pipe(
            Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
          );
        const check =
          output.volumeInstanceId.length > 0
            ? getVolumeByInstanceId(output.volumeInstanceId).pipe(
                Effect.map((instance) => instance === undefined),
              )
            : Effect.succeed(true);
        yield* check.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (gone) => gone,
            times: 8,
          }),
        );
      }
    }),
  });
