import type {
  TcpProxiesResultItem,
  TcpProxyCreateResponse,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { matchesAlchemyPhysicalName } from "./Metadata.ts";
import { ownedProjects, projectEnvironmentIds } from "./Project.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Service(...)` and `Service(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Service identity a TCP proxy attaches to. Accepts a `Railway.Service`,
 * `Railway.Postgres`, `Railway.Redis`, or a `{ serviceId }` stub.
 */
export type TcpProxyService = {
  readonly serviceId: string;
};

/**
 * Environment identity a TCP proxy is created in. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`, or
 * an `{ environmentId }` stub.
 */
export type TcpProxyEnvironment = {
  readonly environmentId: string;
};

export interface TcpProxyProps {
  /**
   * Service to expose. Accepts a `Railway.Service` or `{ serviceId }`.
   * Mutually exclusive with `postgres` / `redis`. Changing it replaces
   * the proxy.
   */
  service?: Ref<TcpProxyService>;
  /**
   * Postgres service to expose. Same identity as `service`. Changing it
   * replaces the proxy.
   */
  postgres?: Ref<TcpProxyService>;
  /**
   * Redis service to expose. Same identity as `service`. Changing it
   * replaces the proxy.
   */
  redis?: Ref<TcpProxyService>;
  /**
   * Environment the proxy is created in. Accepts a `Railway.Project`
   * (primary environment), a `Railway.Environment`, or `{ environmentId }`.
   * Changing it replaces the proxy.
   */
  environment: Ref<TcpProxyEnvironment>;
  /**
   * Internal application port to proxy to (for example `5432` for
   * Postgres, `6379` for Redis). Changing it replaces the proxy.
   */
  applicationPort: number;
}

export type TcpProxy = Resource<
  "Railway.TcpProxy",
  TcpProxyProps,
  {
    /** Railway TCP proxy id. */
    id: string;
    /** Public proxy hostname (`*.proxy.rlwy.net`). */
    domain: string;
    /** Public proxy port. Pair with `domain` to reach the service. */
    proxyPort: number;
    /** Internal application port being proxied. */
    applicationPort: number;
    /** Service the proxy is attached to. */
    serviceId: string;
    /** Environment the proxy lives in. */
    environmentId: string;
    /** Observed Railway sync status (`ACTIVE`, `CREATING`, …). */
    syncStatus: string;
  },
  never,
  Providers
>;

/**
 * A Railway.TcpProxy exposes a service over public TCP. Identity is the
 * Railway proxy id. There is no in-place update — changing `service`,
 * `postgres`, `redis`, `environment`, or `applicationPort` replaces the
 * proxy.
 *
 * Needed so laptop tests and `ConnectPostgres` from outside the private
 * network can reach Postgres/Redis.
 *
 * @see https://docs.railway.com/networking/tcp-proxy
 *
 * ### Postgres
 * Attach a proxy to a Postgres service on `5432`. `domain` and
 * `proxyPort` are the public endpoint (`{domain}:{proxyPort}`).
 *
 * **Example:** Public TCP for Postgres
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const db = yield* Railway.Postgres("Db", { project: site });
 * const proxy = yield* Railway.TcpProxy("DbProxy", {
 *   postgres: db,
 *   environment: site,
 *   applicationPort: 5432,
 * });
 * ```
 *
 * :::caution[Changing `applicationPort` replaces the proxy]
 * Railway has no TCP-proxy update API. A new proxy is created, then the
 * old one is deleted.
 * :::
 *
 * ### Redis
 * Same shape on `6379`.
 *
 * **Example:** Public TCP for Redis
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const cache = yield* Railway.Redis("Cache", { project: site });
 * const proxy = yield* Railway.TcpProxy("CacheProxy", {
 *   redis: cache,
 *   environment: site,
 *   applicationPort: 6379,
 * });
 * ```
 *
 * ### Any service
 * Pass a `Railway.Service` or a `{ serviceId }` stub.
 *
 * **Example:** Stub service id
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const proxy = yield* Railway.TcpProxy("ApiProxy", {
 *   service: { serviceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
 *   environment: site,
 *   applicationPort: 8080,
 * });
 * ```
 *
 * :::caution[Changing `service` or `environment` replaces the proxy]
 * The proxy is created on the new service/environment. The old proxy is
 * deleted.
 * :::
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Project and proxy
 * ```typescript
 * // src/db.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Db = Railway.Postgres("Db", { project: Site });
 * export const DbProxy = Railway.TcpProxy("DbProxy", {
 *   postgres: Db,
 *   environment: Site,
 *   applicationPort: 5432,
 * });
 * ```
 *
 * @resource
 */
export const TcpProxy = Resource<TcpProxy>("Railway.TcpProxy");

export class TcpProxyNotCreated extends Data.TaggedError(
  "Railway.TcpProxyNotCreated",
)<{
  serviceId: string;
  environmentId: string;
  applicationPort: number;
}> {}

export class TcpProxyTargetMissing extends Data.TaggedError(
  "Railway.TcpProxyTargetMissing",
)<{
  message: string;
}> {}

type CloudProxy = TcpProxiesResultItem | TcpProxyCreateResponse;

const isGone = (proxy: CloudProxy | undefined) =>
  proxy === undefined ||
  proxy.deletedAt != null ||
  proxy.syncStatus === "DELETED";

const normalizeDomain = (domain: string) => domain.replace(/\.+$/, "");

const toAttrs = (proxy: CloudProxy): TcpProxy["Attributes"] => ({
  id: proxy.id,
  domain: normalizeDomain(proxy.domain),
  proxyPort: proxy.proxyPort,
  applicationPort: proxy.applicationPort,
  serviceId: proxy.serviceId,
  environmentId: proxy.environmentId,
  syncStatus: proxy.syncStatus,
});

const serviceIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serviceId?: unknown };
  if (typeof rec.serviceId === "string" && rec.serviceId.length > 0) {
    return rec.serviceId;
  }
  return undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  if (typeof rec.environmentId === "string" && rec.environmentId.length > 0) {
    return rec.environmentId;
  }
  return undefined;
};

const targetOf = (
  props: Pick<TcpProxyProps, "service" | "postgres" | "redis">,
) => props.service ?? props.postgres ?? props.redis;

const listProxies = (environmentId: string, serviceId: string) =>
  railway.tcpProxies({ environmentId, serviceId }).pipe(
    Effect.map((items) => items.filter((proxy) => !isGone(proxy))),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as TcpProxiesResultItem[]),
    ),
  );

const findById = (environmentId: string, serviceId: string, id: string) =>
  listProxies(environmentId, serviceId).pipe(
    Effect.map((items) => items.find((proxy) => proxy.id === id)),
  );

const findByPort = (
  environmentId: string,
  serviceId: string,
  applicationPort: number,
) =>
  listProxies(environmentId, serviceId).pipe(
    Effect.map((items) =>
      items.find((proxy) => proxy.applicationPort === applicationPort),
    ),
  );

const observe = Effect.fn(function* (input: {
  environmentId: string;
  serviceId: string;
  applicationPort?: number;
  id?: string;
}) {
  if (input.id !== undefined && input.id.length > 0) {
    const byId = yield* findById(
      input.environmentId,
      input.serviceId,
      input.id,
    );
    if (byId !== undefined) return byId;
  }
  if (input.applicationPort !== undefined) {
    return yield* findByPort(
      input.environmentId,
      input.serviceId,
      input.applicationPort,
    );
  }
  return undefined;
});

const waitUntilGone = (environmentId: string, serviceId: string, id: string) =>
  findById(environmentId, serviceId, id).pipe(
    Effect.map((proxy) => proxy === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

export const TcpProxyProvider = () =>
  Provider.succeed(TcpProxy, {
    stables: ["id", "domain", "proxyPort", "serviceId", "environmentId"],
    nuke: { dependsOn: ["Railway.Project"] },

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const live = yield* railway
            .project({ id: project.projectId })
            .pipe(
              Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
                Effect.succeed(undefined),
              ),
            );
          const services = (
            live?.services.edges.map((edge) => edge.node) ?? []
          ).filter(
            (service) =>
              service.deletedAt == null &&
              matchesAlchemyPhysicalName(service.name),
          );
          const envIds = yield* projectEnvironmentIds(project);
          const nested = yield* Effect.forEach(services, (service) =>
            Effect.forEach(envIds, (environmentId) =>
              listProxies(environmentId, service.id).pipe(
                Effect.map((proxies) => proxies.map((proxy) => toAttrs(proxy))),
              ),
            ).pipe(Effect.map((rows) => rows.flat())),
          );
          return nested.flat();
        }),
      );
      return rows.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const serviceId = serviceIdOf(targetOf(news));
      const environmentId = environmentIdOf(news.environment);
      const serviceChanged =
        serviceId !== undefined && serviceId !== output.serviceId;
      const environmentChanged =
        environmentId !== undefined && environmentId !== output.environmentId;
      const portChanged = news.applicationPort !== output.applicationPort;
      if (serviceChanged || environmentChanged || portChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const serviceId = output?.serviceId ?? serviceIdOf(targetOf(olds ?? {}));
      const environmentId =
        output?.environmentId ?? environmentIdOf(olds?.environment);
      const applicationPort = output?.applicationPort ?? olds?.applicationPort;
      if (serviceId === undefined || environmentId === undefined) {
        return undefined;
      }
      const found = yield* observe({
        environmentId,
        serviceId,
        applicationPort,
        id: output?.id,
      });
      if (found === undefined) return undefined;
      return toAttrs(found);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const props = news ?? ({} as TcpProxyProps);
      const serviceId = serviceIdOf(targetOf(props)) ?? output?.serviceId;
      const environmentId =
        environmentIdOf(props.environment) ?? output?.environmentId;
      const applicationPort = props.applicationPort ?? output?.applicationPort;
      if (serviceId === undefined || environmentId === undefined) {
        return yield* new TcpProxyTargetMissing({
          message:
            "TcpProxy requires a service (or postgres/redis) and an environment",
        });
      }
      if (applicationPort === undefined) {
        return yield* new TcpProxyNotCreated({
          serviceId,
          environmentId,
          applicationPort: 0,
        });
      }

      let current = yield* observe({
        environmentId,
        serviceId,
        applicationPort,
        id: output?.id,
      });

      if (current === undefined) {
        const created = yield* railway
          .tcpProxyCreate({
            input: {
              applicationPort,
              environmentId,
              serviceId,
            },
          })
          .pipe(
            Effect.catchTag("RailwayValidationError", () =>
              Effect.succeed(undefined),
            ),
          );
        current =
          created !== undefined && !isGone(created)
            ? created
            : yield* observe({
                environmentId,
                serviceId,
                applicationPort,
              });
      }

      if (current === undefined || isGone(current)) {
        return yield* new TcpProxyNotCreated({
          serviceId,
          environmentId,
          applicationPort,
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const id = output.id;
      if (id.length === 0) return;
      yield* railway.tcpProxyDelete({ id }).pipe(
        // Railway serializes proxy mutations per environment: a delete
        // racing an in-flight deploy fails with "Cannot delete TCP proxy:
        // an operation is already in progress".
        Effect.retry({
          while: (e) =>
            e._tag === "RailwayInternalError" &&
            e.message.includes("operation is already in progress"),
          schedule: Schedule.spaced("3 seconds"),
          times: 20,
        }),
        Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
      );
      if (output.environmentId.length > 0 && output.serviceId.length > 0) {
        yield* waitUntilGone(output.environmentId, output.serviceId, id);
      }
    }),
  });
