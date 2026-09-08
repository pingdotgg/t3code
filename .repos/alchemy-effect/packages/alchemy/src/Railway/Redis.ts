import { randomBytes } from "node:crypto";
import type {
  ProjectResponseServicesEdgesItemNode,
  ServiceCreateResponse,
  ServiceInstanceResponse,
  ServiceResponse,
  ServiceUpdateResponse,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import {
  ownedProjects,
  projectEnvironmentIds,
  type Project,
} from "./Project.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Environment identity a Redis service is deployed into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type RedisEnvironment = {
  readonly environmentId: string;
};

export const DEFAULT_REDIS_IMAGE = "redis:7";
export const REDIS_PORT = 6379;
import { REDIS_URL_ENV } from "./RedisBinding.ts";

export { REDIS_URL_ENV };
export const REDIS_PASSWORD_ENV = "REDISPASSWORD";

export interface RedisProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` or an Effect
   * that produces one. Changing the Project replaces Redis.
   */
  project: Ref<Project>;
  /**
   * Environment to deploy into. Accepts a `Railway.Project` (primary
   * environment), a `Railway.Environment`, or `{ environmentId }`.
   * Defaults to the project's primary environment. Changing it replaces
   * Redis.
   */
  environment?: Ref<RedisEnvironment>;
  /**
   * Service name. Unique per Project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it updates
   * in place via `serviceUpdate`.
   */
  name?: string;
  /**
   * Docker image. Official Redis (`redis:7`) gets `--requirepass`.
   * Bitnami (`bitnami/redis`) reads `REDIS_PASSWORD`.
   *
   * @default "redis:7"
   */
  image?: string;
  /**
   * Region for the service instance (`us-west2`, `us-east4`, …). If
   * omitted, Railway picks the default. Updates in place.
   */
  region?: string;
  /**
   * Redis password. Wrap with `Redacted.make(...)`. If omitted, a
   * password is generated on first create and kept. Never persisted in
   * attributes.
   */
  password?: Redacted.Redacted<string> | string;
}

export type Redis = Resource<
  "Railway.Redis",
  RedisProps,
  {
    /** Railway service id. */
    serviceId: string;
    /** Physical service name (unique per project). */
    name: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Environment the instance is deployed in. */
    environmentId: string;
    /** Observed `source.image`. */
    image: string;
    /** Observed region, if Railway reported one. */
    region: string | undefined;
    /** Redis listen port (`6379`). */
    port: number;
    /** Private hostname (`{name}.railway.internal`). */
    privateHost: string;
    /** Latest deployment id, if one exists. */
    deploymentId: string | undefined;
    /** Latest deployment status (`SUCCESS`, `DEPLOYING`, …). */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
>;

const resolveRedisProps = (
  props: RedisProps | Effect.Effect<RedisProps, never, Providers>,
): Effect.Effect<RedisProps, never, Providers> =>
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
              RedisEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    return { ...resolved, project, environment };
  });

const RedisResource = Resource<Redis>("Railway.Redis");

/**
 * A Railway.Redis is a Redis container in a Project (`redis:7` or
 * `bitnami/redis`). Alchemy writes `REDIS_URL` / `REDISPASSWORD` on the
 * service. Bind {@link ReadRedis}, {@link WriteRedis}, or
 * {@link ReadWriteRedis} on a {@link Service}. Reach it from a laptop
 * through {@link TcpProxy} on port `6379`.
 *
 * @see https://docs.railway.com/guides/redis
 *
 * ### Create Redis
 * Pass a Project. Alchemy generates a unique name and password unless
 * you pass them. Default image is `redis:7`.
 *
 * **Example:** Generated name
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const cache = yield* Railway.Redis("Cache", { project: site });
 * ```
 *
 * :::note
 * Prefer omitting `name` in tests and CI so names stay unique and
 * reclaimable.
 * :::
 *
 * ### A stable name
 * Pass `name` when you want a stable service name. Changing it later
 * updates the service in place.
 *
 * **Example:** Explicit name
 * ```typescript
 * const cache = yield* Railway.Redis("Cache", {
 *   project: site,
 *   name: "cache",
 * });
 * ```
 *
 * ### Image
 * Official Redis (`redis:7`) is started with `--requirepass`. Bitnami
 * reads `REDIS_PASSWORD`. Updating the image is in place.
 *
 * **Example:** Bitnami
 * ```typescript
 * const cache = yield* Railway.Redis("Cache", {
 *   project: site,
 *   image: "bitnami/redis",
 * });
 * ```
 *
 * ### Public TCP
 * Attach a {@link TcpProxy} on `6379` to reach Redis from outside the
 * private network.
 *
 * **Example:** Laptop access
 * ```typescript
 * const cache = yield* Railway.Redis("Cache", { project: site });
 * const proxy = yield* Railway.TcpProxy("CacheProxy", {
 *   redis: cache,
 *   environment: site,
 *   applicationPort: 6379,
 * });
 * ```
 *
 * ### Bind from a Service
 * Yield {@link ReadWriteRedis} (or {@link ReadRedis} / {@link WriteRedis})
 * in Service init. Provide the matching `*Http` layer. Runtime commands
 * use `REDIS_URL` (`{name}.railway.internal`).
 *
 * **Example:** Read and write
 * ```typescript
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Site = Railway.Project("Site");
 * export const Cache = Railway.Redis("Cache", { project: Site });
 *
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   { project: Site, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const cache = yield* Railway.ReadWriteRedis(Cache);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* cache.set("marker", "hello");
 *         const value = yield* cache.get("marker");
 *         return HttpServerResponse.json({ value });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Railway.ReadWriteRedisHttp)),
 * ) {}
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Redis
 * ```typescript
 * // src/cache.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Cache = Railway.Redis("Cache", { project: Site });
 * ```
 *
 * @resource
 */
export const Redis: typeof RedisResource = Object.assign(
  (
    id: string,
    props: RedisProps | Effect.Effect<RedisProps, never, Providers>,
  ) => RedisResource(id, resolveRedisProps(props)),
  RedisResource,
);

export {
  CommandError as RedisCommandError,
  UrlMissing as RedisUrlMissing,
} from "../Redis/index.ts";

export class RedisNotCreated extends Data.TaggedError(
  "Railway.RedisNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class RedisProjectRequired extends Data.TaggedError(
  "Railway.RedisProjectRequired",
)<{
  message: string;
}> {}

export class RedisDeployFailed extends Data.TaggedError(
  "Railway.RedisDeployFailed",
)<{
  serviceId: string;
  status: string;
  deploymentId: string | undefined;
}> {}

class RedisPending extends Data.TaggedError("Railway.RedisPending")<{
  serviceId: string;
  status: string;
}> {}

class RedisDeployPending extends Data.TaggedError(
  "Railway.RedisDeployPending",
)<{
  serviceId: string;
  status: string;
}> {}

type CloudService =
  | ServiceResponse
  | ServiceCreateResponse
  | ServiceUpdateResponse
  | ProjectResponseServicesEdgesItemNode;

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

const isGoneService = (service: CloudService | undefined) =>
  service === undefined || service.deletedAt != null;

const isGoneInstance = (instance: ServiceInstanceResponse | undefined) =>
  instance === undefined || instance.deletedAt != null;

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const unwrapSecret = (value: Redacted.Redacted<string> | string): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const generatePassword = Effect.sync(() => {
  const bytes = randomBytes(24);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
});

const isBitnamiImage = (image: string) => /bitnami/i.test(image);

export const isRedisImage = (image: string | null | undefined): boolean =>
  image != null && /redis/i.test(image);

const startCommandFor = (
  image: string,
  password: string,
): string | undefined =>
  isBitnamiImage(image) ? undefined : `redis-server --requirepass ${password}`;

const privateHostOf = (name: string) => `${name}.railway.internal`;

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

const deployReady = (status: string | undefined) =>
  status === "SUCCESS" || status === "SLEEPING";

const deployFailed = (status: string | undefined) =>
  status === "FAILED" || status === "CRASHED" || status === "REMOVED";

const alreadyExists = (message: string) =>
  /already exists|already in use|duplicate/i.test(message);

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

const waitForInstance = (environmentId: string, serviceId: string) =>
  getInstance(environmentId, serviceId).pipe(
    Effect.flatMap((instance) => {
      if (instance === undefined) {
        return Effect.fail(new RedisPending({ serviceId, status: "creating" }));
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.RedisPending",
      // serviceCreate fans the instance out to each environment
      // asynchronously; under full-suite load the fan-out can take minutes.
      times: 60,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.RedisPending", () =>
      getInstance(environmentId, serviceId),
    ),
  );

const waitForDeployment = (environmentId: string, serviceId: string) =>
  Effect.gen(function* () {
    const instance = yield* getInstance(environmentId, serviceId);
    const latest = instance?.latestDeployment;
    const status = latest?.status;
    if (status !== undefined && deployFailed(status)) {
      return yield* new RedisDeployFailed({
        serviceId,
        status,
        deploymentId: latest?.id,
      });
    }
    if (instance !== undefined && deployReady(status)) {
      return instance;
    }
    return yield* new RedisDeployPending({
      serviceId,
      status: status ?? "pending",
    });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Railway.RedisDeployPending",
      // Queued builds under full-suite load can exceed 3 minutes — allow ~8.
      times: 96,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.catchTag("Railway.RedisDeployPending", () =>
      getInstance(environmentId, serviceId),
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

const redisUrlTemplate = `redis://default:\${{${REDIS_PASSWORD_ENV}}}@\${{RAILWAY_PRIVATE_DOMAIN}}:${REDIS_PORT}`;

const desiredVariables = (password: string): Record<string, string> => ({
  [REDIS_PASSWORD_ENV]: password,
  REDIS_PASSWORD: password,
  REDISUSER: "default",
  REDISPORT: String(REDIS_PORT),
  REDISHOST: "${{RAILWAY_PRIVATE_DOMAIN}}",
  [REDIS_URL_ENV]: redisUrlTemplate,
});

const syncVariables = Effect.fn(function* (input: {
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

const toAttrs = (input: {
  service: CloudService;
  instance: ServiceInstanceResponse | undefined;
  projectId: string;
  environmentId: string;
  image: string;
}): Redis["Attributes"] => ({
  serviceId: input.service.id,
  name: input.service.name,
  projectId: input.projectId,
  environmentId: input.environmentId,
  image: input.instance?.source?.image ?? input.image,
  region: input.instance?.region ?? undefined,
  port: REDIS_PORT,
  privateHost: privateHostOf(input.service.name),
  deploymentId: input.instance?.latestDeployment?.id,
  deploymentStatus: input.instance?.latestDeployment?.status,
});

export {
  command as redisCommand,
  connectionUrl as redisConnectionUrl,
  run as runRedisCommand,
} from "../Redis/index.ts";

export const RedisProvider = () =>
  Provider.succeed(Redis, {
    stables: ["serviceId", "projectId", "environmentId"],
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
      if (projectChanged || environmentChanged) {
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
      const attrs = toAttrs({
        service: found,
        instance,
        projectId: resolvedProjectId,
        environmentId: resolvedEnvId,
        image: instance?.source?.image ?? olds?.image ?? DEFAULT_REDIS_IMAGE,
      });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const services = yield* listProjectServices(project.projectId);
          const envIds = yield* projectEnvironmentIds(project);
          const items = yield* Effect.forEach(
            services.filter((service) =>
              matchesAlchemyPhysicalName(service.name),
            ),
            (service) =>
              Effect.gen(function* () {
                for (const environmentId of envIds) {
                  const instance = yield* getInstance(
                    environmentId,
                    service.id,
                  );
                  const image = instance?.source?.image ?? undefined;
                  if (!isRedisImage(image)) continue;
                  return toAttrs({
                    service,
                    instance,
                    projectId: project.projectId,
                    environmentId,
                    image: image ?? DEFAULT_REDIS_IMAGE,
                  });
                }
                return undefined;
              }),
          );
          return items.filter((item) => item !== undefined);
        }),
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as RedisProps);
      const projectId = projectIdOf(props.project) ?? output?.projectId;
      if (projectId === undefined) {
        return yield* new RedisProjectRequired({
          message: "Redis requires a resolved Railway.Project",
        });
      }
      const environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.project) ??
        output?.environmentId;
      if (environmentId === undefined) {
        return yield* new RedisProjectRequired({
          message:
            "Redis requires a Railway environment (pass environment or a Project with environmentId)",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);
      const image = props.image ?? output?.image ?? DEFAULT_REDIS_IMAGE;

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
      const password =
        props.password !== undefined
          ? unwrapSecret(props.password)
          : existingVars[REDIS_PASSWORD_ENV] !== undefined &&
              existingVars[REDIS_PASSWORD_ENV].length > 0 &&
              !existingVars[REDIS_PASSWORD_ENV].includes("${{")
            ? existingVars[REDIS_PASSWORD_ENV]
            : yield* generatePassword;
      const env = desiredVariables(password);
      const startCommand = startCommandFor(image, password);

      if (current === undefined) {
        const created = yield* railway
          .serviceCreate({
            input: {
              projectId,
              environmentId,
              name,
              source: { image },
              variables: env,
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
        return yield* new RedisNotCreated({ name, projectId });
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
      const imageChanged = !sameImage(observedImage, image);
      const observedRegion = instance?.region ?? undefined;
      const regionChanged =
        props.region !== undefined && props.region !== observedRegion;
      const observedStart = instance?.startCommand ?? undefined;
      const startChanged = (observedStart ?? undefined) !== startCommand;
      if (imageChanged || regionChanged || startChanged) {
        yield* railway.serviceInstanceUpdate({
          environmentId,
          serviceId: current.id,
          input: {
            ...(imageChanged ? { source: { image } } : {}),
            ...(regionChanged ? { region: props.region } : {}),
            ...(startChanged ? { startCommand: startCommand ?? null } : {}),
          },
        });
        needsDeploy = true;
        instance = (yield* getInstance(environmentId, current.id)) ?? instance;
      }

      const envChanged = yield* syncVariables({
        projectId,
        environmentId,
        serviceId: current.id,
        desired: env,
      });
      if (envChanged) needsDeploy = true;

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

      return toAttrs({
        service: current,
        instance,
        projectId,
        environmentId,
        image,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const serviceId = output.serviceId;
      if (serviceId.length === 0) return;
      yield* railway
        .serviceDelete({
          id: serviceId,
          ...(output.environmentId.length > 0
            ? { environmentId: output.environmentId }
            : {}),
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
    }),
  });
