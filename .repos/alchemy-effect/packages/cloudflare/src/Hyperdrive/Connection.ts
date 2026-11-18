import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { isResourceOfType, Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { localAccountId } from "../LocalAccount.ts";
import { generateLocalId } from "../LocalRuntime.ts";
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

/**
 * Origin configuration for a private database reached through Workers VPC.
 *
 * Hyperdrive egresses through a TCP VPC Service
 * ({@link https://developers.cloudflare.com/workers-vpc/ Workers VPC}), which
 * routes over a Cloudflare Tunnel into the private network — e.g. an Aurora
 * or RDS instance inside an AWS VPC. The host and port live on the VPC
 * Service, so they are not repeated here. mTLS cannot be combined with a VPC
 * origin; TLS is managed on the VPC Service.
 */
export type VpcOrigin = {
  scheme: Scheme;
  /**
   * Identifier of the TCP VPC Service to connect through, e.g.
   * `service.serviceId` of a `Cloudflare.Connectivity.DirectoryService`
   * with `type: "tcp"`.
   */
  serviceId: string;
  database: string;
  user: string;
  /**
   * Database password.
   */
  password: Redacted.Redacted<string>;
};

export type Origin = PublicOrigin | AccessOrigin | VpcOrigin;

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
   * databases, databases fronted by Cloudflare Access, and private databases
   * reached through a Workers VPC Service.
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
 * ### Creating a Hyperdrive
 * **Example:** Public Postgres origin
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connection("my-pg", {
 *   origin: {
 *     scheme: "postgres",
 *     host: "db.example.com",
 *     port: 5432,
 *     database: "app",
 *     user: "app",
 *     password: yield* Config.Redacted("DB_PASSWORD"),
 *   },
 * });
 * ```
 *
 * ### Connecting to a private database
 * A database inside a private network (e.g. Aurora or RDS in an AWS VPC) is
 * reached through Workers VPC: run `cloudflared` inside the network with the
 * Tunnel's token, expose the database as a TCP VPC Service, and point
 * Hyperdrive at the service.
 *
 * **Example:** Aurora in an AWS VPC through Workers VPC
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel.Tunnel("VpcTunnel");
 * const service = yield* Cloudflare.Connectivity.DirectoryService("Aurora", {
 *   type: "tcp",
 *   tcpPort: 5432,
 *   appProtocol: "postgresql",
 *   host: {
 *     hostname: "my-cluster.cluster-abc123.us-east-1.rds.amazonaws.com",
 *     resolverNetwork: { tunnelId: tunnel.tunnelId },
 *   },
 * });
 * const hd = yield* Cloudflare.Hyperdrive.Connection("Aurora", {
 *   origin: {
 *     scheme: "postgres",
 *     serviceId: service.serviceId,
 *     database: "app",
 *     user: "app",
 *     password: yield* Config.Redacted("DB_PASSWORD"),
 *   },
 * });
 * ```
 *
 * ### Binding to a Worker
 * **Example:** Using Hyperdrive inside a Worker
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connect(MyConnection);
 * const url = yield* hd.connectionString;
 * ```
 *
 * @resource
 * @product Hyperdrive
 * @category Storage & Databases
 */
export const Connection = Resource<Connection>("Cloudflare.Hyperdrive");

export const isHyperdriveConnection = (value: unknown): value is Connection =>
  isResourceOfType(value, "Cloudflare.Hyperdrive");

export const ProviderLive = () =>
  Provider.succeed(Connection, {
    // `hyperdriveId` is stable within live mode: `updateConfig` never changes
    // it, and the dev→deploy transition (which DOES mint a new id) is a
    // mode-switch the engine plans as a REPLACEMENT, so updates can rely on it.
    stables: ["hyperdriveId", "accountId"],
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
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Each replace-forcing field is checked on its own: an unresolved
      // origin (e.g. another resource's output) must not hide a rename.
      const newName = "name" in news ? news.name : undefined;
      if (isResolved(newName)) {
        const oldName = output?.name ?? (yield* createConfigName(id, olds.name));
        // Auto-generated names are engine-owned: the deployed name stays
        // authoritative even if the generator would name this id differently
        // today. Only an explicit user-provided name can force a replace.
        const name = newName ?? oldName;
        if (oldName !== name) {
          return { action: "replace" } as const;
        }
      }
      // `updateConfig` preserves omitted mTLS settings and accepts no null
      // certificate id, so a pinned certificate can only be dropped by
      // creating a fresh config. An explicit name is unique per account, so
      // the old config must go first.
      const oldMtls = output?.mtls ?? olds?.mtls;
      const mtls = "mtls" in news ? news.mtls : undefined;
      if (isResolved(mtls)) {
        const dropped = (key: "caCertificateId" | "mtlsCertificateId") =>
          oldMtls?.[key] !== undefined && mtls?.[key] === undefined;
        if (dropped("caCertificateId") || dropped("mtlsCertificateId")) {
          return { action: "replace", deleteFirst: newName !== undefined } as const;
        }
      }
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output?.hyperdriveId) {
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
            Effect.catchTag("HyperdriveConfigNotFound", () => Effect.undefined),
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
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = output?.name ?? (yield* createConfigName(id, news.name));

      const requestBody = toRequestBody(news);

      // Observe the live config. `output` is only a cache of the id: a
      // config deleted out of band falls through to create.
      const observed = output?.hyperdriveId
        ? yield* hyperdrive
            .getConfig({ accountId: output.accountId, hyperdriveId: output.hyperdriveId })
            .pipe(Effect.catchTag("HyperdriveConfigNotFound", () => Effect.undefined))
        : undefined;

      // Every `updateConfig` opens a new origin pool and leaves the old one
      // connected until its idle timeout, so skip it unless something would
      // change. The API never returns the password or Access client secret:
      // readable fields are compared against the live config (so drift is
      // corrected), and the write-only secrets against the last applied
      // request in `olds`. Without `olds` (adoption) the secrets are unknown,
      // so the config is updated.
      if (
        observed &&
        olds !== undefined &&
        deepEqual(requestBody, toRequestBody(olds)) &&
        isInSync(observed, news.name ?? name, requestBody)
      ) {
        return {
          hyperdriveId: observed.id,
          name: observed.name,
          accountId: output?.accountId ?? accountId,
          origin: news.origin,
          mtls: news.mtls ?? {},
          dev: news.dev,
        };
      }

      // Ensure + sync. With a live config we update it in place; otherwise
      // we createConfig and fall back to "find by name then update" if
      // Cloudflare reports the name is already in use (race or a cold-start
      // adoption).
      const synced = yield* (
        observed
          ? hyperdrive.updateConfig({
              accountId: output?.accountId ?? accountId,
              hyperdriveId: observed.id,
              name: news.name ?? observed.name,
              ...requestBody,
            })
          : hyperdrive.createConfig({ accountId, name, ...requestBody }).pipe(
              Effect.catchTag("InvalidHyperdriveConfig", (originalError) =>
                Effect.gen(function* () {
                  const match = yield* findByName(name);
                  if (!match) {
                    return yield* originalError;
                  }
                  return yield* hyperdrive.updateConfig({
                    accountId,
                    hyperdriveId: match.id,
                    name,
                    ...requestBody,
                  });
                }),
              ),
            )
      ).pipe(
        // Cloudflare connects to the origin on create/update. A just-
        // provisioned database, or a just-created Workers VPC Service that
        // has not propagated yet (`destination_not_found`), is briefly
        // unreachable.
        Effect.retry({
          while: (error) => error._tag === "HyperdriveOriginUnavailable",
          schedule: Schedule.spaced("3 seconds"),
          times: 20,
        }),
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
      yield* hyperdrive
        .deleteConfig({
          accountId: output.accountId,
          hyperdriveId: output.hyperdriveId,
        })
        .pipe(Effect.catchTag("HyperdriveConfigNotFound", () => Effect.void));
    }),
  });

/**
 * Local (dev) provider — the config is purely virtual: reconcile mints a
 * `dev:` id and echoes the desired props into attributes, with no cloud API
 * calls. The actual local behavior lives in the Worker binding: the local
 * runtime's Hyperdrive plugin is an origin passthrough driven by the
 * `hyperdrives` record `ConnectBinding` lowers (the `dev` prop when set,
 * otherwise the real `origin`).
 */
export const ProviderLocal = () =>
  Provider.succeed(Connection, {
    stables: ["accountId"],
    diff: Effect.fn(function* ({ news, output }) {
      const accountId = yield* localAccountId;
      if (!output?.hyperdriveId) return { action: "update" } as const;
      if (!isResolved(news)) return undefined;
      if (output.accountId !== accountId) {
        return { action: "replace" } as const;
      }
      // Fall through to the engine's default prop diff (name/origin/dev
      // changes update in place; reconcile re-echoes them).
    }),
    read: Effect.fn(function* ({ output }) {
      // Purely virtual — the persisted state row is the source of truth.
      return output ?? undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const accountId = yield* localAccountId;
      return {
        hyperdriveId: output?.hyperdriveId ?? generateLocalId(),
        name: yield* createConfigName(id, news.name),
        accountId: output?.accountId ?? accountId,
        origin: news.origin,
        mtls: news.mtls ?? {},
        dev: news.dev,
      };
    }),
    delete: Effect.fn(function* () {
      // Purely virtual — dropping the state row is enough.
    }),
  });

export const ConnectionProvider = () =>
  ProviderLayer.dual(Connection, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
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

export const defaultPort = (scheme: Scheme): number => (scheme === "mysql" ? 3306 : 5432);

const unwrap = (v: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(v) ? Redacted.value(v) : v;

const toRequestBody = (props: Props) => ({
  origin: toRequestOrigin(props.origin),
  caching: props.caching,
  mtls: props.mtls,
  originConnectionLimit: props.originConnectionLimit,
});

const SECRET_ORIGIN_KEYS = new Set(["password", "accessClientSecret"]);
const DEFAULT_MAX_AGE = 60;
const DEFAULT_STALE_WHILE_REVALIDATE = 15;

/**
 * Whether the live config already matches every readable field of the
 * desired request. Secrets are write-only and are not compared here.
 */
const isInSync = (
  observed: hyperdrive.GetConfigResponse,
  name: string,
  desired: ReturnType<typeof toRequestBody>,
): boolean => {
  if (observed.name !== name) return false;

  const live: Readonly<Record<string, unknown>> = { ...observed.origin };
  if (
    Object.entries(desired.origin).some(
      ([key, value]) => !SECRET_ORIGIN_KEYS.has(key) && live[key] !== value,
    )
  ) {
    return false;
  }

  const caching = desired.caching ?? {};
  if ((caching.disabled ?? false) !== observed.caching.disabled) return false;
  if (
    !observed.caching.disabled &&
    ((caching.maxAge ?? DEFAULT_MAX_AGE) !== (observed.caching.maxAge ?? DEFAULT_MAX_AGE) ||
      (caching.staleWhileRevalidate ?? DEFAULT_STALE_WHILE_REVALIDATE) !==
        (observed.caching.staleWhileRevalidate ?? DEFAULT_STALE_WHILE_REVALIDATE))
  ) {
    return false;
  }

  // `updateConfig` preserves omitted mTLS settings, so only the specified
  // ones are compared.
  const mtls = desired.mtls ?? {};
  if (
    (["caCertificateId", "mtlsCertificateId", "sslmode"] as const).some(
      (key) => mtls[key] !== undefined && mtls[key] !== (observed.mtls?.[key] ?? undefined),
    )
  ) {
    return false;
  }

  return (
    desired.originConnectionLimit === undefined ||
    desired.originConnectionLimit === (observed.originConnectionLimit ?? undefined)
  );
};

/**
 * Build the request body shape that the distilled `createConfig`/`updateConfig`
 * methods accept. Secrets are unwrapped here because the distilled TS types
 * declare `password`/`access_client_secret` as plain strings even though the
 * runtime schema also accepts `Redacted<string>`.
 */
const toRequestOrigin = (origin: Origin) => {
  if ("serviceId" in origin) {
    return {
      database: origin.database,
      password: unwrap(origin.password),
      scheme: origin.scheme,
      serviceId: origin.serviceId,
      user: origin.user,
    };
  }
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
