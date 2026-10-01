/**
 * `@alchemy.run/frontend-frameworks/tanstack-start` — TanStack Start
 * integration implementing framework-core's `Framework` service, with the
 * deploy target passed as a value (AWS Lambda by default, via the
 * `@alchemy.run/frontend-frameworks/tanstack-start/aws` subpath module).
 *
 * TanStack Start is expressed entirely as Vite plugins: `tanstackStart()`
 * owns routing, server functions, server routes, and the `client`/`ssr`
 * environments, and its `builder.buildApp` builds both in one pass. This
 * integration drives the project's own Vite install
 * (`createBuilder(...).buildApp()`) and forces the SSR bundle to be
 * self-contained so it deploys as a standalone Lambda — the project's
 * `vite.config.ts` needs no adapter wiring.
 *
 * The default export is the e2e-harness factory contract: a
 * `(options) => Layer<Framework>` function. Use {@link layer} directly for
 * the fully-typed path with TanStack Start-specific options.
 *
 * This module (and `TanStackStart.ts`) is target-agnostic by contract: it
 * must not import anything AWS-specific. The AWS half — the Lambda entry
 * and the streaming adapter — lives behind
 * `@alchemy.run/frontend-frameworks/tanstack-start/aws`.
 */
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type { Framework } from "../core/index.ts";
import { layer, type TanStackStartOptions } from "./TanStackStart.ts";

export {
  DEFAULT_OUT_DIR,
  DEFAULT_SERVER_ENTRY_FILE_NAME,
  DEFAULT_TARGET_SPECIFIER,
  inlineBuildConfig,
  layer,
  make,
  readTanStackStartOutput,
  selectServerEntryName,
  TANSTACK_START_PLUGIN_SPECIFIER,
  type TanStackStartOptions,
  type TanStackStartOutputDirs,
  type TanStackStartTarget,
  type TanStackStartTargetConfig,
  type TanStackStartTargetInput,
  type TanStackStartViteBuilder,
  type TanStackStartViteDevServer,
  type TanStackStartViteModule,
} from "./TanStackStart.ts";

/**
 * The structural subset of the e2e harness's `Options` this package reads.
 */
export interface HarnessOptions {
  readonly tanstackStart?: { readonly outDir?: string | undefined } | undefined;
}

/** Map the harness's options onto {@link TanStackStartOptions}. */
export const fromHarnessOptions = (
  options: HarnessOptions,
): TanStackStartOptions => ({ outDir: options.tanstackStart?.outDir });

/**
 * The e2e-harness factory contract
 * (`framework: "@alchemy.run/frontend-frameworks/tanstack-start"` in
 * `e2e.config.ts`).
 */
const factory = (
  options: HarnessOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  layer(fromHarnessOptions(options ?? {}));

export default factory;
