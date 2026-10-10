/**
 * `@alchemy.run/frontend-frameworks/react-router` — React Router v7
 * (framework mode) integration implementing framework-core's `Framework`
 * service, with the deploy target passed as a value (AWS Lambda by default,
 * via the `@alchemy.run/frontend-frameworks/react-router/aws` subpath
 * module).
 *
 * React Router v7 is expressed as a Vite plugin: `reactRouter()` owns
 * routing, typegen, resource routes, and the client/server builds. This
 * integration drives the project's own Vite install through the same two
 * passes `react-router build` runs, makes the server build's input a fetch
 * handler over the emitted `ServerBuild` manifest, and forces the server
 * bundle to be self-contained so it deploys as a standalone Lambda — the
 * project's `vite.config.ts` needs no adapter wiring.
 *
 * React Server Components (React Router's `unstable` RSC plugin) and
 * multi-environment builds are not supported yet.
 *
 * The default export is the e2e-harness factory contract: a
 * `(options) => Layer<Framework>` function. Use {@link layer} directly for
 * the fully-typed path with React Router-specific options.
 *
 * This module (and `ReactRouter.ts`) is target-agnostic by contract: it must
 * not import anything AWS-specific. The AWS half — the Lambda entry and the
 * streaming adapter — lives behind
 * `@alchemy.run/frontend-frameworks/react-router/aws`.
 */
import type * as FileSystem from "effect/FileSystem";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type { Framework } from "../core/index.ts";
import { layer, type ReactRouterOptions } from "./ReactRouter.ts";

export {
  captureOutDirPlugin,
  DEFAULT_BUILD_DIRECTORY,
  DEFAULT_SERVER_BUILD_FILE,
  DEFAULT_TARGET_SPECIFIER,
  inlineClientBuildConfig,
  inlineServerBuildConfig,
  layer,
  make,
  REACT_ROUTER_PLUGIN_SPECIFIER,
  REACT_ROUTER_SERVER_BUILD_ID,
  readReactRouterOutput,
  selectServerEntryName,
  SERVER_ENTRY_ID,
  serverEntryPlugin,
  serverEntrySource,
  type InlineVitePlugin,
  type OutDirCapture,
  type ReactRouterOptions,
  type ReactRouterOutputDirs,
  type ReactRouterTarget,
  type ReactRouterTargetConfig,
  type ReactRouterTargetInput,
  type ReactRouterViteDevServer,
  type ReactRouterViteModule,
  type ResolvedViteBuildSlice,
} from "./ReactRouter.ts";

/**
 * The structural subset of the e2e harness's `Options` this package reads.
 */
export interface HarnessOptions {
  readonly reactRouter?:
    | { readonly buildDirectory?: string | undefined }
    | undefined;
}

/** Map the harness's options onto {@link ReactRouterOptions}. */
export const fromHarnessOptions = (
  options: HarnessOptions,
): ReactRouterOptions => ({
  buildDirectory: options.reactRouter?.buildDirectory,
});

/**
 * The e2e-harness factory contract
 * (`framework: "@alchemy.run/frontend-frameworks/react-router"` in
 * `e2e.config.ts`).
 */
const factory = (
  options: HarnessOptions,
): Layer.Layer<Framework, never, FileSystem.FileSystem | Path.Path> =>
  layer(fromHarnessOptions(options ?? {}));

export default factory;
