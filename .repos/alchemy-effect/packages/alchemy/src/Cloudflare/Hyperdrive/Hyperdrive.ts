import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";

import { AlchemyContext } from "../../AlchemyContext.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { HyperdriveBinding } from "./HyperdriveBinding.ts";

export type HyperdriveScheme = "postgres" | "postgresql" | "mysql";

/**
 * Origin configuration for a public PostgreSQL or MySQL database.
 */
export type HyperdrivePublicOrigin = {
  scheme: HyperdriveScheme;
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
export type HyperdriveAccessOrigin = {
  scheme: HyperdriveScheme;
  host: string;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
  accessClientId: Redacted.Redacted<string>;
  accessClientSecret: Redacted.Redacted<string>;
};

export type HyperdriveOrigin = HyperdrivePublicOrigin | HyperdriveAccessOrigin;

export type HyperdriveCaching = {
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

export type HyperdriveMtls = {
  caCertificateId?: string;
  mtlsCertificateId?: string;
  /**
   * @default "require"
   */
  sslmode?: "require" | "verify-ca" | "verify-full";
};

export type HyperdriveDevOrigin = HyperdrivePublicOrigin & {
  /**
   * @default "prefer"
   */
  sslmode?: "disable" | "prefer" | "require" | "verify-ca" | "verify-full";
};

export type HyperdriveProps = {
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
  origin: HyperdriveOrigin;
  /**
   * Caching configuration.
   */
  caching?: HyperdriveCaching;
  /**
   * mTLS configuration.
   */
  mtls?: HyperdriveMtls;
  /**
   * The (soft) maximum number of connections Hyperdrive is allowed to make to
   * the origin database.
   */
  originConnectionLimit?: number;
  /**
   * Local development overrides. When the stack runs in dev mode
   * connect to a locally running database
   */
  dev?: HyperdriveDevOrigin;
};

export type Hyperdrive = Resource<
  "Cloudflare.Hyperdrive",
  HyperdriveProps,
  {
    hyperdriveId: string;
    name: string;
    accountId: string;
    origin: HyperdriveOrigin;
    mtls: HyperdriveMtls;
    dev: HyperdriveDevOrigin | undefined;
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
 *
 * @section Creating a Hyperdrive
 * @example Public Postgres origin
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive("my-pg", {
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
 * const hd = yield* Cloudflare.Hyperdrive.bind(MyDB);
 * const url = yield* hd.connectionString;
 * ```
 */
export const Hyperdrive = Resource<Hyperdrive>("Cloudflare.Hyperdrive")({
  bind: HyperdriveBinding.bind,
});

export const isHyperdrive = (value: unknown): value is Hyperdrive =>
  Predicate.hasProperty(value, "Type") &&
  value.Type === "Cloudflare.Hyperdrive";

export const HyperdriveProvider = () =>
  Provider.effect(
    Hyperdrive,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createConfig = yield* hyperdrive.createConfig;
      const getConfig = yield* hyperdrive.getConfig;
      const updateConfig = yield* hyperdrive.updateConfig;
      const deleteConfig = yield* hyperdrive.deleteConfig;
      const listConfigs = yield* hyperdrive.listConfigs;

      const createConfigName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return yield* createPhysicalName({ id, lowercase: true });
        });

      const findByName = (name: string) =>
        Effect.gen(function* () {
          const list = yield* listConfigs({ accountId });
          return list.result.find((c) => c.name === name);
        });

      return {
        // The `hyperdriveId` is not marked as stable because if you start in dev mode, the ID will change on first deploy.
        stables: ["accountId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          const ctx = yield* AlchemyContext;
          if (ctx.dev) return undefined;

          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const name = yield* createConfigName(id, news.name);
          const oldName = output?.name
            ? output.name
            : yield* createConfigName(id, olds.name);
          if (oldName !== name) {
            return { action: "replace" } as const;
          }
          if (!isHyperdriveId(output?.hyperdriveId)) {
            return { action: "update" };
          }
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const ctx = yield* AlchemyContext;
          if (ctx.dev) {
            return output;
          }

          if (isHyperdriveId(output?.hyperdriveId)) {
            return yield* getConfig({
              accountId: output.accountId,
              hyperdriveId: output.hyperdriveId,
            }).pipe(
              Effect.map((c) => ({
                hyperdriveId: c.id,
                name: c.name,
                accountId: output.accountId,
                origin: {
                  ...c.origin,
                  password: olds?.origin?.password,
                } as HyperdriveOrigin,
                mtls: {
                  caCertificateId: c.mtls?.caCertificateId ?? undefined,
                  mtlsCertificateId: c.mtls?.mtlsCertificateId ?? undefined,
                  sslmode: c.mtls?.sslmode ?? undefined,
                } as HyperdriveMtls,
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
              } as HyperdriveOrigin,
              mtls: {
                caCertificateId: match.mtls?.caCertificateId ?? undefined,
                mtlsCertificateId: match.mtls?.mtlsCertificateId ?? undefined,
                sslmode: match.mtls?.sslmode ?? undefined,
              } as HyperdriveMtls,
              dev: output?.dev,
            };
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = output?.name ?? (yield* createConfigName(id, news.name));

          const ctx = yield* AlchemyContext;
          if (ctx.dev) {
            return {
              hyperdriveId:
                output?.hyperdriveId ?? `dev:${crypto.randomUUID()}`,
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
          const synced = isHyperdriveId(output?.hyperdriveId)
            ? yield* updateConfig({
                accountId: output.accountId,
                hyperdriveId: output.hyperdriveId,
                name: output.name,
                ...requestBody,
              })
            : yield* createConfig({ accountId, name, ...requestBody }).pipe(
                Effect.catchTag("InvalidHyperdriveConfig", (originalError) =>
                  Effect.gen(function* () {
                    const match = yield* findByName(name);
                    if (!match) {
                      return yield* Effect.fail(originalError);
                    }
                    return yield* updateConfig({
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
          if (!isHyperdriveId(output.hyperdriveId)) return;

          yield* deleteConfig({
            accountId: output.accountId,
            hyperdriveId: output.hyperdriveId,
          }).pipe(
            Effect.catchIf(
              (e) =>
                e._tag === "HyperdriveConfigNotFound" ||
                (e._tag === "CloudflareHttpError" && e.status === 404),
              () => Effect.void,
            ),
          );
        }),
      };
    }),
  );

export const defaultPort = (scheme: HyperdriveScheme): number =>
  scheme === "mysql" ? 3306 : 5432;

const unwrap = (v: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(v) ? Redacted.value(v) : v;

const isHyperdriveId = (maybeId: string | undefined): maybeId is string =>
  typeof maybeId === "string" && !maybeId.startsWith("dev:");

/**
 * Build the request body shape that the distilled `createConfig`/`updateConfig`
 * methods accept. Secrets are unwrapped here because the distilled TS types
 * declare `password`/`access_client_secret` as plain strings even though the
 * runtime schema also accepts `Redacted<string>`.
 */
const toRequestOrigin = (origin: HyperdriveOrigin) => {
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
