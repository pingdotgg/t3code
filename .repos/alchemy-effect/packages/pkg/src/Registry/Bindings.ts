import * as Cloudflare from "alchemy/Cloudflare";
import type * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * What the registry Worker binds: its three resources, the settings binding
 * that carries the policy into the isolate, and the credential bindings.
 * Shared by `Registry.ts` (which declares the Worker) and the runtime
 * modules in this folder.
 */

/**
 * Registry policy. The `Type` side is what the Worker runs against
 * (`Duration`, `ByteSize`); the `Encoded` side is plain JSON, which is how
 * the policy crosses into the isolate as a Worker binding.
 */
export const Policy = Schema.Struct({
  /**
   * Repositories allowed to publish, as `owner/name`. A publication may
   * contain any package; every package gets the commit, short commit,
   * `branch:` and `pr:` tags of the run that produced it.
   */
  repos: Schema.Array(Schema.String),
  /**
   * How long a publication lives: from the push for branch publications,
   * from close or merge for pull request publications. Publishing the same
   * content again refreshes the clock.
   */
  ttl: Schema.DurationFromMillis,
  /** Upper bound on a single tarball. Absent means unlimited. */
  maxPackageSize: Schema.optionalKey(Schema.ByteSizeFromNumber),
});
export type Policy = typeof Policy.Type;

/**
 * Everything the Worker needs that is plain data. Encoded into the
 * {@link SETTINGS_ENV} binding at deploy time and decoded back inside the
 * isolate, so the deploy-time and runtime views of the registry are the
 * same value by construction.
 */
export const Settings = Schema.Struct({
  policy: Policy,
  /**
   * Hostname to package scope. Requests on an aliased host resolve an
   * unscoped name under that scope, so `pkg.distilled.cloud/core/<sha>`
   * serves `@distilled.cloud/core`.
   */
  aliases: Schema.Record(Schema.String, Schema.String),
  /** Cron expression for the expiry sweep. */
  cron: Schema.String,
  github: Schema.Struct({
    apiUrl: Schema.String,
  }),
});
export type Settings = typeof Settings.Type;

/**
 * Worker props the registry forwards verbatim. `main`, `env`, and `crons`
 * are owned by the registry itself.
 */
export type WorkerOverrides = Omit<
  Cloudflare.WorkerProps,
  "main" | "env" | "crons"
>;

export interface GitHubCredentials {
  /** The App id. Read from the deploy environment, bound to the Worker. */
  readonly appId: Config.Config<string>;
  /** The App's private key PEM. Bound to the Worker as a secret. */
  readonly privateKey: Config.Config<Redacted.Redacted<string>>;
}

/**
 * The resolved registry configuration, provided to the Worker's Init phase.
 * At plan time it is the value `PkgRegistry(id, options)` built from the
 * caller's options; inside the isolate it is rebuilt from the Worker's
 * bindings (see `RegistryConfigFromEnv` in `Registry.ts`). Either way the
 * handler code sees one shape.
 */
export class RegistryConfig extends Context.Service<
  RegistryConfig,
  Settings & {
    readonly worker: WorkerOverrides;
    readonly github: Settings["github"] & GitHubCredentials;
  }
>()("@alchemy.run/pkg/RegistryConfig") {}

/** Worker `json` binding carrying the encoded {@link Settings}. */
export const SETTINGS_ENV = "PKG_SETTINGS";

/** Worker env var the GitHub App id is bound under. */
export const APP_ID_ENV = "PKG_GITHUB_APP_ID";

/** Worker secret the GitHub App private key PEM is bound under. */
export const PRIVATE_KEY_ENV = "PKG_GITHUB_APP_PRIVATE_KEY";

export const DEFAULT_TTL = Duration.weeks(1);
export const DEFAULT_CRON = "0 * * * *";
export const DEFAULT_API_URL = "https://api.github.com";

/** Marker that identifies the sticky install comment. */
export const COMMENT_MARKER = "<!-- pkg-preview-comment -->";

/** Uploaded tarballs no tag points at are deleted once older than this. */
export const ORPHAN_GRACE = Duration.hours(24);

/** Tags tied to pull requests are re-checked when due within this window. */
export const SWEEP_LOOKAHEAD = Duration.hours(2);

/** Content-addressed tarballs, keyed `<encoded name>/<sha256>.tgz`. */
export const Bucket = Cloudflare.R2.Bucket("Bucket", { forceDestroy: true });

export const tarballKey = (name: string, sha256: string) =>
  `${encodeURIComponent(name)}/${sha256}.tgz`;

// The migrations ship inside this package. `import.meta.url` is a file URL
// during plan/deploy and absent or opaque inside the isolate, where the
// resource declaration is only evaluated for its binding.
const migrations =
  typeof import.meta.url === "string" && import.meta.url.startsWith("file:")
    ? decodeURIComponent(new URL("../../migrations", import.meta.url).pathname)
    : undefined;

/** Publications, tags, and tarball bookkeeping. */
export const Database = Cloudflare.D1.Database("Database", { migrations });

/**
 * Resolved runs and installation tokens, shared by every isolate of the
 * Worker. Everything in it is re-derivable from GitHub; see `KVCache.ts`.
 */
export const Cache = Cloudflare.KV.Namespace("Cache");
