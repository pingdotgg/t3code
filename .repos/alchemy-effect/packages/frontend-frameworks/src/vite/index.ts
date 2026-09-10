/**
 * `@alchemy.run/frontend-frameworks/vite` — plain-Vite integration
 * implementing framework-core's `Framework` service, for client-only sites
 * whose entire deployable output is static assets (React/Vue/Solid SPAs,
 * `index.html` multi-page apps, Foldkit apps, ...).
 *
 * This package drives the PROJECT's own Vite install programmatically —
 * one `vite build` with the project's `vite.config.*` (plugins included)
 * produces the assets directory; `dev` runs the project's own Vite dev
 * server (native HMR). There are no server modules and no adapter forks.
 *
 * The default export is the e2e-harness factory contract: an
 * `(options) => Layer<Framework>` function. Use {@link layer} directly for
 * the fully-typed path with Vite-specific options.
 *
 * Frameworks that wrap Vite with a server half (Octane, SvelteKit, Astro,
 * ...) have their own integrations — this one deliberately never looks for
 * server output.
 */
import type { Framework } from "../core/index.ts";
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import { layer } from "./Vite.ts";

export {
  DEFAULT_TARGET_SPECIFIER,
  layer,
  make,
  readViteOutput,
  type ResolvedViteConfigSlice,
  type ViteBuildConfig,
  type ViteDevServer,
  type ViteModule,
  type ViteOptions,
  type ViteTarget,
  type ViteTargetConfig,
  type ViteTargetInput,
} from "./Vite.ts";

/**
 * The e2e-harness factory contract
 * (`framework: "@alchemy.run/frontend-frameworks/vite"` in `e2e.config.ts`).
 * Plain Vite carries no harness-configurable options.
 */
const factory = (
  _options?: unknown,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> => layer();

export default factory;
