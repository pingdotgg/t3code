import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { AlchemyContext } from "../../AlchemyContext.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { generateLocalId, isLiveId } from "../LocalRuntime.ts";
import type { Providers } from "../Providers.ts";

export type Scheme = "postgres" | "postgresql" | "mysql";

/**
 * Origin configuration for a public PostgreSQL or MySQL database.
 */
export type PublicOrigin = {
  scheme: Scheme;
  host: string;
  port?: number;
  database: string;
  user: string;
  /**
   * Database password.
   */
  password: Redacted.Redacted<string>;
};

/**
 * Origin configuration for a database fronted by Cloudflare Access.
 */
export type AccessOrigin = {
  scheme: Scheme;
  host: string;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
  accessClientId: Redacted.Redacted<string>;
  accessClientSecret: Redacted.Redacted<string>;
};

export type Origin = PublicOrigin | AccessOrigin;

export type Caching = {
  /**
   * Whether caching is disabled.
   * @default false
   */
  disabled?: boolean;
  /**
   * Maximum duration items should persist in the cache, in seconds.
   * @default 60
   */
  maxAge?: number;
  /**
   * Number of seconds the cache may serve a stale response while revalidating.
   * @default 15
   */
  staleWhileRevalidate?: number;
};

export type Mtls = {
  caCertificateId?: string;
  mtlsCertificateId?: string;
  /**
   * @default "require"
   */
  sslmode?: "require" | "verify-ca" | "verify-full";
};

export type DevOrigin = PublicOrigin & {
  /**
   * @default "prefer"
   */
  sslmode?: "disable" | "prefer" | "require" | "verify-ca" | "verify-full";
};

export type Props = {
  /**
   * Name of the Hyperdrive configuration. If omitted, a unique name will be
   * generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Database connection origin. Hyperdrive supports public Postgres/MySQL
   * databases and databases fronted by Cloudflare Access.
   */
  origin: Origin;
  /**
   * Caching configuration.
   */
  caching?: Caching;
  /**
   * mTLS configuration.
   */
  mtls?: Mtls;
  /**
   * The (soft) maximum number of connections Hyperdrive is allowed to make to
   * the origin database.
   */
  originConnectionLimit?: number;
  /**
   * Local development overrides. When the stack runs in dev mode
   * connect to a locally running database
   */
  dev?: DevOrigin;
};

export type Connection = Resource<
  "Cloudflare.Hyperdrive",
  Props,
  {
    hyperdriveId: string;
    name: string;
    accountId: string;
    origin: Origin;
    mtls: Mtls;
    dev: DevOrigin | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Hyperdrive configuration.
 *
 * Hyperdrive accelerates and pools connections to existing PostgreSQL or
 * MySQL databases, exposing them to Workers via a binding. Create a config
 * as a resource, then bind it to a Worker to obtain a connection string.
 * @resource
 * @product Hyperdrive
 * @category Storage & Databases
 * @section Creating a Hyperdrive
 * @example Public Postgres origin
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connection("my-pg", {
 *   origin: {
 *     scheme: "postgres",
 *     host: "db.example.com",
 *     port: 5432,
 *     database: "app",
 *     user: "app",
 *     password: alchemy.secret.env.DB_PASSWORD,
 *   },
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Using Hyperdrive inside a Worker
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connect(MyConnection);
 * const url = yield* hd.connectionString;
 * ```
 */
export const Connection = Resource<Connection>("Cloudflare.Hyperdrive");

export const isHyperdriveConnection = (value: unknown): value is Connection =>
  isResourceOfType(value, "Cloudflare.Hyperdrive");

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    // The `hyperdriveId` is not marked as stable because if you start in dev mode, the ID will change on first deploy.
    stables: ["accountId"],
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* hyperdrive.listConfigs.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((c) => ({
              hyperdriveId: c.id,
              name: c.name,
              accountId,
              // The connection-string password is write-only and never
              // returned by the API, so it is absent here (matching `read`,
              // which sources it from `olds`).
              origin: { ...c.origin } as Origin,
              mtls: {
                caCertificateId: c.mtls?.caCertificateId ?? undefined,
                mtlsCertificateId: c.mtls?.mtlsCertificateId ?? undefined,
                sslmode: c.mtls?.sslmode ?? undefined,
              } as Mtls,
              dev: undefined,
            })),
          ),
        ),
      );
    }),
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const ctx = yield* AlchemyContext;
      if (ctx.dev) return undefined;

      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldName = output?.name ?? (yield* createConfigName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      if (oldName !== name) {
        return { action: "replace" } as const;
      }
      if (!isLiveId(output?.hyperdriveId)) {
        return { action: "update" };
      }
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const ctx = yield* AlchemyContext;
      if (ctx.dev) {
        return output;
      }

      if (isLiveId(output?.hyperdriveId)) {
        return yield* hyperdrive
          .getConfig({
            accountId: output.accountId,
            hyperdriveId: output.hyperdriveId,
          })
          .pipe(
            Effect.map((c) => ({
              hyperdriveId: c.id,
              name: c.name,
              accountId: output.accountId,
              origin: {
                ...c.origin,
                password: olds?.origin?.password,
              } as Origin,
              mtls: {
                caCertificateId: c.mtls?.caCertificateId ?? undefined,
                mtlsCertificateId: c.mtls?.mtlsCertificateId ?? undefined,
                sslmode: c.mtls?.sslmode ?? undefined,
              } as Mtls,
              dev: output?.dev,
            })),
            Effect.catchTag("HyperdriveConfigNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      const name = yield* createConfigName(id, olds?.name);
      const match = yield* findByName(name);
      if (match) {
        return {
          hyperdriveId: match.id,
          name: match.name,
          accountId,
          origin: {
            ...match.origin,
            password: olds?.origin?.password,
          } as Origin,
          mtls: {
            caCertificateId: match.mtls?.caCertificateId ?? undefined,
            mtlsCertificateId: match.mtls?.mtlsCertificateId ?? undefined,
            sslmode: match.mtls?.sslmode ?? undefined,
          } as Mtls,
          dev: output?.dev,
        };
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = output?.name ?? (yield* createConfigName(id, news.name));

      const ctx = yield* AlchemyContext;
      if (ctx.dev) {
        return {
          hyperdriveId: output?.hyperdriveId ?? generateLocalId(),
          name,
          accountId: output?.accountId ?? accountId,
          origin: news.origin,
          mtls: news.mtls ?? {},
          dev: news.dev,
        };
      }

      const requestBody = {
        origin: toRequestOrigin(news.origin),
        caching: news.caching,
        mtls: news.mtls,
        originConnectionLimit: news.originConnectionLimit,
      };

      // Observe + ensure. When we know the hyperdriveId we go straight
      // to update; otherwise we createConfig and fall back to "find by
      // name then update" if Cloudflare reports the name is already in
      // use (race or a cold-start adoption).
      const synced = isLiveId(output?.hyperdriveId)
        ? yield* hyperdrive.updateConfig({
            accountId: output.accountId,
            hyperdriveId: output.hyperdriveId,
            name: output.name,
            ...requestBody,
          })
        : yield* hyperdrive
            .createConfig({ accountId, name, ...requestBody })
            .pipe(
              Effect.catchTag("InvalidHyperdriveConfig", (originalError) =>
                Effect.gen(function* () {
                  const match = yield* findByName(name);
                  if (!match) {
                    return yield* Effect.fail(originalError);
                  }
                  return yield* hyperdrive.updateConfig({
                    accountId,
                    hyperdriveId: match.id,
                    name,
                    ...requestBody,
                  });
                }),
              ),
            );

      return {
        hyperdriveId: synced.id,
        name: synced.name,
        accountId: output?.accountId ?? accountId,
        origin: news.origin,
        mtls: news.mtls ?? {},
        dev: news.dev,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      if (!isLiveId(output.hyperdriveId)) return;

      yield* hyperdrive
        .deleteConfig({
          accountId: output.accountId,
          hyperdriveId: output.hyperdriveId,
        })
        .pipe(Effect.catchTag("HyperdriveConfigNotFound", () => Effect.void));
    }),
  });

const createConfigName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id, lowercase: true });
  });

const findByName = (name: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    return yield* hyperdrive.listConfigs.items({ accountId }).pipe(
      Stream.filter((c) => c.name === name),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    );
  });

export const defaultPort = (scheme: Scheme): number =>
  scheme === "mysql" ? 3306 : 5432;

const unwrap = (v: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(v) ? Redacted.value(v) : v;

/**
 * Build the request body shape that the distilled `createConfig`/`updateConfig`
 * methods accept. Secrets are unwrapped here because the distilled TS types
 * declare `password`/`access_client_secret` as plain strings even though the
 * runtime schema also accepts `Redacted<string>`.
 */
const toRequestOrigin = (origin: Origin) => {
  if ("accessClientId" in origin) {
    return {
      accessClientId: unwrap(origin.accessClientId),
      accessClientSecret: unwrap(origin.accessClientSecret),
      database: origin.database,
      host: origin.host,
      password: unwrap(origin.password),
      scheme: origin.scheme,
      user: origin.user,
    };
  }
  return {
    database: origin.database,
    host: origin.host,
    password: unwrap(origin.password),
    port: origin.port ?? defaultPort(origin.scheme),
    scheme: origin.scheme,
    user: origin.user,
  };
};
