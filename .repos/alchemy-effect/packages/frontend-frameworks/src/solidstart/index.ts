/**
 * `@alchemy.run/frontend-frameworks/solidstart` — SolidStart integration
 * implementing framework-core's `Framework` service, with the deploy target
 * passed as a value (AWS Lambda by default, via the
 * `@alchemy.run/frontend-frameworks/solidstart/aws` subpath module).
 *
 * SolidStart 2 is expressed entirely as Vite plugins: `solidStart()` owns
 * routing, SSR, and the client/server environments, and
 * `@solidjs/vite-plugin-nitro-2` turns the emitted SSR bundle into a nitro
 * server. This integration drives the project's own Vite install
 * (`createBuilder(...).buildApp()`) and appends its own nitro-plugin
 * instance so the deploy target owns the nitro preset — the project's
 * `vite.config.*` needs no adapter wiring.
 *
 * The default export is the e2e-harness factory contract: a
 * `(options) => Layer<Framework>` function. Use {@link layer} directly for
 * the fully-typed path with SolidStart-specific options.
 *
 * This module (and `SolidStart.ts`) is target-agnostic by contract: it must
 * not import anything AWS-specific. The AWS half — nitro's `aws-lambda`
 * preset and its streaming handler — lives behind
 * `@alchemy.run/frontend-frameworks/solidstart/aws`.
 */
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type { Framework } from "../core/index.ts";
import { layer, type SolidStartOptions } from "./SolidStart.ts";

export {
  DEFAULT_TARGET_SPECIFIER,
  layer,
  make,
  NITRO_PLUGIN_SPECIFIER,
  readNitroOutput,
  SERVER_ENTRY_NAME,
  type NitroOutputDirs,
  type SolidStartNitroContext,
  type SolidStartNitroPluginModule,
  type SolidStartOptions,
  type SolidStartTarget,
  type SolidStartTargetConfig,
  type SolidStartTargetInput,
  type SolidStartViteBuilder,
  type SolidStartViteDevServer,
  type SolidStartViteModule,
} from "./SolidStart.ts";

export {
  findPresetConflict,
  hasForeignNitroPlugin,
  isSamePreset,
  markInjectedPlugins,
  NITRO_PLUGIN_NAME,
  normalizePresetName,
  pluginConflictMessage,
  presetConflictMessage,
  resolveNitroConfig,
  resolveNitroOutputDirs,
  type NitroConfigSlice,
  type NitroOutputConfigSlice,
  type ResolveNitroConfigInput,
} from "./UserConfig.ts";

/**
 * The structural subset of the e2e harness's `Options` this package reads.
 * SolidStart's build carries no harness-configurable options today — the
 * nitro overrides ride on {@link SolidStartOptions} instead.
 */
export interface HarnessOptions {
  readonly solidstart?:
    | { readonly nitro?: Record<string, unknown> | undefined }
    | undefined;
}

/** Map the harness's options onto {@link SolidStartOptions}. */
export const fromHarnessOptions = (
  options: HarnessOptions,
): SolidStartOptions => ({ nitro: options.solidstart?.nitro });

/**
 * The e2e-harness factory contract
 * (`framework: "@alchemy.run/frontend-frameworks/solidstart"` in
 * `e2e.config.ts`).
 */
const factory = (
  options: HarnessOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  layer(fromHarnessOptions(options ?? {}));

export default factory;
