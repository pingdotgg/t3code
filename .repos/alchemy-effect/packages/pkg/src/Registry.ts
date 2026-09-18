import * as Cloudflare from "alchemy/Cloudflare";
import * as Namespace from "alchemy/Namespace";
import type * as ByteSize from "effect/ByteSize";
import * as Config from "effect/Config";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  APP_ID_ENV,
  DEFAULT_API_URL,
  DEFAULT_CRON,
  DEFAULT_TTL,
  PRIVATE_KEY_ENV,
  RegistryConfig,
  SETTINGS_ENV,
  Settings,
  type GitHubCredentials,
  type WorkerOverrides,
} from "./Registry/Bindings.ts";
import { handler } from "./Registry/Handler.ts";

export {
  Bucket,
  Cache,
  Database,
  Policy,
  RegistryConfig,
  Settings,
} from "./Registry/Bindings.ts";

export interface RegistryOptions {
  /**
   * Worker props forwarded verbatim: `domain`, `name`, `compatibility`,
   * `observability`, `access`, and so on. `main`, `env`, and `crons` are
   * owned by the registry.
   */
  readonly worker?: WorkerOverrides;
  /** GitHub App credentials, read at deploy time and bound to the Worker. */
  readonly github: GitHubCredentials & {
    /** @default "https://api.github.com" */
    readonly apiUrl?: string;
  };
  readonly policy: {
    /** Repositories allowed to publish, as `owner/name`. */
    readonly repos: ReadonlyArray<string>;
    /** @default Duration.weeks(1) */
    readonly ttl?: Duration.Duration;
    /** Upper bound on a single tarball. Absent means unlimited. */
    readonly maxPackageSize?: ByteSize.ByteSize;
  };
  /**
   * Hostname to package scope. Requests on an aliased host resolve an
   * unscoped name under that scope, so `pkg.distilled.cloud/core/<sha>`
   * serves `@distilled.cloud/core`.
   */
  readonly aliases?: Readonly<Record<string, string>>;
  /**
   * Cron expression for the expiry sweep.
   * @default "0 * * * *"
   */
  readonly cron?: string;
}

/**
 * The registry Worker. Its props are an Effect so the same declaration
 * serves both sides of the bundle boundary: at plan time
 * {@link RegistryConfig} is the caller's options, inside the isolate it is
 * rebuilt from the Worker's bindings.
 */
export class Registry extends Cloudflare.Worker<Registry, {}>()("Worker") {}

const RegistryLive = Registry.make(
  Effect.gen(function* () {
    const config = yield* RegistryConfig;
    return {
      ...config.worker,
      main: import.meta.url,
      env: {
        [SETTINGS_ENV]: yield* Schema.encodeEffect(Settings)({
          policy: config.policy,
          aliases: config.aliases,
          cron: config.cron,
          github: { apiUrl: config.github.apiUrl },
        }).pipe(Effect.orDie),
        [APP_ID_ENV]: config.github.appId,
        [PRIVATE_KEY_ENV]: config.github.privateKey,
      },
    };
  }),
  handler,
);

/**
 * Runtime side of {@link RegistryConfig}: decode the settings binding and
 * point the credentials at the bindings `RegistryLive` declared.
 */
const RegistryConfigFromEnv = Layer.effect(
  RegistryConfig,
  Effect.gen(function* () {
    const env = yield* Cloudflare.Workers.WorkerEnvironment;
    const settings = yield* Schema.decodeUnknownEffect(Settings)(
      env[SETTINGS_ENV],
    ).pipe(Effect.orDie);
    return {
      ...settings,
      worker: {},
      github: {
        ...settings.github,
        appId: Config.String(APP_ID_ENV),
        privateKey: Config.Redacted(PRIVATE_KEY_ENV),
      },
    };
  }),
);

/**
 * The bundle entry. `RegistryLive` names this file as `main`, so the
 * generated Worker entry imports this default export and builds it once per
 * isolate. User code never imports it; use {@link PkgRegistry}.
 */
export default RegistryLive.pipe(Layer.provide(RegistryConfigFromEnv));

/**
 * A preview package registry: a Worker serving install URLs and the publish
 * API, an R2 bucket of content-addressed tarballs, a D1 index of tags, and a
 * KV namespace caching what the Worker learns from GitHub. They are declared
 * under `id` as `<id>/Worker`, `<id>/Bucket`, `<id>/Database`, and
 * `<id>/Cache`.
 *
 * ### Deploying a registry
 * **Example:** Stack
 * ```typescript
 * // stacks/pkg.ts
 * import { PkgRegistry } from "@alchemy.run/pkg/Registry";
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as ByteSize from "effect/ByteSize";
 * import * as Config from "effect/Config";
 * import * as Duration from "effect/Duration";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "Pkg",
 *   { providers: Cloudflare.providers(), state: Cloudflare.state() },
 *   Effect.gen(function* () {
 *     const registry = yield* PkgRegistry("Pkg", {
 *       worker: { domain: "pkg.alchemy.run" },
 *       github: {
 *         appId: Config.String("GH_APP_ID"),
 *         privateKey: Config.Redacted("GH_APP_PRIVATE_KEY"),
 *       },
 *       policy: {
 *         repos: ["alchemy-run/alchemy", "alchemy-run/distilled"],
 *         ttl: Duration.weeks(1),
 *         maxPackageSize: ByteSize.megabytes(100),
 *       },
 *     });
 *     return { url: registry.url.as<string>() };
 *   }),
 * );
 * ```
 *
 * @resource
 * @product Workers
 * @category Workers & Compute
 */
export const PkgRegistry = <const Id extends string>(
  id: Id,
  options: RegistryOptions,
) =>
  Registry.pipe(
    Effect.provide(
      RegistryLive.pipe(
        Layer.provide(
          Layer.succeed(RegistryConfig, {
            worker: options.worker ?? {},
            policy: {
              repos: options.policy.repos,
              ttl: options.policy.ttl ?? DEFAULT_TTL,
              ...(options.policy.maxPackageSize !== undefined
                ? { maxPackageSize: options.policy.maxPackageSize }
                : {}),
            },
            aliases: options.aliases ?? {},
            cron: options.cron ?? DEFAULT_CRON,
            github: {
              apiUrl: options.github.apiUrl ?? DEFAULT_API_URL,
              appId: options.github.appId,
              privateKey: options.github.privateKey,
            },
          }),
        ),
      ),
    ),
    Namespace.push(id),
  );
