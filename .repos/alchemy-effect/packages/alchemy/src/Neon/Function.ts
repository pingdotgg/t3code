import type * as Redacted from "effect/Redacted";
import type { BundleConfig } from "../Bundle/Bundle.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import type { Resource } from "../Resource.ts";
import type { BranchScope } from "./BranchScope.ts";
import type {
  FunctionEnvironment,
  FunctionRequest,
} from "./FunctionEnvironment.ts";
import {
  makeFunctionRuntimeContext,
  type FunctionRuntimeContext,
} from "./FunctionRuntimeContext.ts";
import type { Providers } from "./Providers.ts";

/**
 * Prebuilt Node 24 Fetch application. The directory or ZIP must contain
 * `index.mjs` at its root, exporting a Fetch handler or an object with `fetch`.
 * Include all runtime dependencies; Alchemy does not bundle prebuilt artifacts.
 * Archives must not contain symlinks, traversal paths, or deployment secrets.
 */
export type FunctionArtifact =
  | {
      /** Directory packaged into a deterministic ZIP. */ directory: string;
      zip?: never;
    }
  | { /** Path to an existing ZIP archive. */ zip: string; directory?: never };

export interface FunctionCommonProps extends PlatformProps {
  /** Immutable lowercase alphanumeric identifier, at most 20 characters. Generated when omitted. */
  slug?: string;
  /** Mutable display name. Removing it restores the slug. */
  name?: string;
  /** Write-only values. Removing a managed key sends an empty deletion value. Platform-injected keys cannot be overridden. */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
  /** Node-targeted bundler options; not used with prebuilt artifacts. */
  bundle?: BundleConfig;
  /** Local Neon CLI executable (version 2.45.0 or newer) and optional listening port. */
  dev?: { command?: string; port?: number };
}

export type FunctionProps = BranchScope &
  FunctionCommonProps &
  (
    | {
        /** Native Fetch or Effect entry module. */ main: string;
        artifact?: never;
      }
    | {
        /** Prebuilt Fetch application, mutually exclusive with main. */ artifact: FunctionArtifact;
        main?: never;
      }
  );

export interface FunctionAttributes {
  /** Owning project. */ projectId: string;
  /** Owning branch. */ branchId: string;
  /** Stable function ID. */ functionId: string;
  /** Immutable invocation slug. */ slug: string;
  /** Observed display name. */ name: string;
  /** Public invocation URL. Authenticate callers in the handler. */ url: string;
  /** Latest deployment identifier. */ currentDeploymentId: number | undefined;
  /** Deployment currently serving traffic. */ activeDeploymentId:
    | number
    | undefined;
  /** Latest deployment build status. */ status: string | undefined;
  /** Digest of the last successfully applied artifact, not a remote code attestation. */ codeHash:
    | string
    | undefined;
  /** Last applied environment digest, not proof of remote write-only value equality. */ environmentHash?: string;
  /** Previously managed environment names. Values cannot be read back. */ environment: string[];
}

export interface FunctionBinding {
  /** Namespaced application configuration; conflicts with user values are rejected. */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

export interface Function extends Resource<
  "Neon.Function",
  FunctionProps,
  FunctionAttributes,
  FunctionBinding,
  Providers
> {}

/**
 * Node.js 24 Fetch function, with native and Effect entrypoints.
 *
 * Functions have public URLs. The `functions:invoke` credential scope does not
 * establish a private invocation policy. Authenticate requests in your handler.
 * Native same-branch database/storage credentials are injected by Neon; a typed
 * read-only binding does not restrict the credentials available to the process.
 * Explicit adoption takes ownership of user-defined environment names: existing
 * keys omitted from `env` and bindings are removed. Values are write-only, so
 * cached digests cannot detect out-of-band value drift.
 *
 * ### Streaming disconnects <!-- api-prose -->
 *
 * Neon’s production host currently does not reliably propagate client disconnects
 * to uncompressed response streams. An abandoned stream can retain its producer
 * and request-scoped resources until it finishes. Prefer finite responses and
 * application-bounded streams; do not rely on disconnect cleanup for long-lived
 * streaming workloads until [the upstream issue](https://github.com/neondatabase/neon-pkgs/issues/636)
 * is resolved. Alchemy propagates abort and body-cancel signals when the host supplies them.
 *
 * ### Native Fetch
 * **Example:** Bundle a native object, bare handler, or Hono application
 * ```typescript
 * const api = yield* Neon.Function("Api", { branch, main: "./src/api.ts" });
 * ```
 *
 * ### Effect Fetch
 * **Example:** Class entrypoint
 * ```typescript
 * export default class Api extends Neon.Function<Api>()(
 *   "Api", { branch, main: import.meta.url },
 *   Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
 * ) {}
 * ```
 *
 * ### Prebuilt Applications
 * **Example:** Deploy Website build output without rebundling
 * ```typescript
 * const site = yield* Neon.Function("Site", { branch, artifact: { directory: "./dist" } });
 * ```
 *
 * @resource
 * @product Function
 */
export const Function: Platform<
  Function,
  FunctionEnvironment,
  Main<FunctionEnvironment | FunctionRequest>,
  FunctionRuntimeContext
> = Platform<Function>("Neon.Function", {
  createRuntimeContext: makeFunctionRuntimeContext,
});
