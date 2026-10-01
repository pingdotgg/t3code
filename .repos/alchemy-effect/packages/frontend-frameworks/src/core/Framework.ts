import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { BuildOutput } from "./BuildOutput.ts";

export class FrameworkError extends Data.TaggedError<"FrameworkError">(
  "FrameworkError",
)<{
  /** The framework the implementation drives (e.g. "vite", "waku", "astro"). */
  readonly framework?: string | undefined;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FrameworkBuildOptions {
  /** Project root. Defaults to the implementation's configured root / cwd. */
  readonly root?: string | undefined;
  /**
   * Process environment for the production-build child. Never applied to
   * the parent: framework plugins mutate `process.env`, so the engine
   * process must not share it with concurrent deploys.
   */
  readonly env?: Record<string, string> | undefined;
}

export interface FrameworkDevOptions {
  /** Project root. Defaults to the implementation's configured root / cwd. */
  readonly root?: string | undefined;
  /** Port for the dev server. Defaults to the framework's own choice. */
  readonly port?: number | undefined;
  /** Host the dev server binds to. Defaults to the framework's own choice. */
  readonly host?: string | undefined;
}

export interface FrameworkDevServer {
  /** The local URL the dev server is listening on. */
  readonly url: string;
}

/**
 * The common contract every framework integration implements — the shape the
 * e2e harness drives and the alchemy-side `SourceProvider` adapters wrap.
 *
 * Each framework package exports a concrete `Layer<Framework>` (and may expose
 * its own richer service alongside; e.g. the e2e harness's `Vite` service
 * accepts plugin/config parameters that this contract intentionally omits).
 *
 * Semantics:
 *
 * - `build` runs the framework's production build and returns the
 *   {@link BuildOutput} contract (`serverModules` entry-first) purely
 *   in-memory — implementations write nothing beyond the framework's own
 *   build output. Callers that need persistence (e.g. the e2e harness's
 *   `dist/build.json`) use the standalone `writeBuildOutput` /
 *   `readBuildOutput` helpers themselves.
 * - `dev` starts the framework's dev server; it is scoped — closing the Scope
 *   stops the server.
 *
 * A `SourceProvider` adapter maps `build` onto its own output shape
 * (`clientDirectory` → assets read, `serverModules` → bundle files entry-first,
 * `externalWorkspaces` → additional watched workspaces) and `dev` onto a
 * server-mode dev handle.
 */
export class Framework extends Context.Service<
  Framework,
  {
    readonly build: (
      options?: FrameworkBuildOptions,
    ) => Effect.Effect<BuildOutput, FrameworkError>;
    readonly dev: (
      options?: FrameworkDevOptions,
    ) => Effect.Effect<FrameworkDevServer, FrameworkError, Scope.Scope>;
  }
>()("@alchemy.run/frontend-frameworks/core/Framework") {}
