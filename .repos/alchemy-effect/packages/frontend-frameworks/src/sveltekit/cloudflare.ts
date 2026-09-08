// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * `@alchemy.run/frontend-frameworks/sveltekit/cloudflare` — the Cloudflare Workers deploy
 * target for `@alchemy.run/frontend-frameworks/sveltekit`.
 *
 * Everything Cloudflare-specific lives here (and in the modules this file
 * imports): the wrangler-free in-memory kit adapter (worker shim, `_headers`
 * / `_redirects` / `.assetsignore` generation, the proxy-backed dev
 * platform) and the finishing pass that re-bundles kit's node-flavored
 * `_worker.js` output for workerd with rolldown +
 * `@alchemy.run/cloudflare-runtime/rolldown`.
 *
 * The default export is the target factory the framework package applies to
 * the config it assembles from `SvelteKitOptions`
 * (`resolveDeployTarget(root, target, config)` — a value, a factory, or this
 * module's specifier).
 */
import cloudflare from "@alchemy.run/cloudflare-runtime/rolldown";
import * as FrameworkCore from "../core/index.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";
import * as Path from "effect/Path";
import { rolldown } from "rolldown";
import { makeCloudflareAdapter } from "./Adapter.ts";
import type { SvelteKitTarget, SvelteKitTargetConfig } from "./SvelteKit.ts";

export {
  appendHeaders,
  generateAssetsIgnore,
  generateHeaders,
  generateRedirects,
  makeCloudflareAdapter,
  makeDevPlatformEmulator,
  type CloudflareAdapter,
  type CloudflareAdapterOptions,
  type CloudflareAdapterResult,
  type CloudflareDevPlatformOptions,
  type CloudflareEmulator,
  type DevPlatformProxy,
  type OpenDevPlatformProxy,
  type OpenDevPlatformProxyOptions,
} from "./Adapter.ts";
export { generateWorkerShim, type WorkerShimOptions } from "./WorkerShim.ts";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "cloudflare", message, cause });

/**
 * Create the Cloudflare Workers {@link SvelteKitTarget}:
 *
 * - `adapter(context)` — the in-memory, wrangler-free fork of
 *   `@sveltejs/adapter-cloudflare` (always Workers mode; generates the worker
 *   shim with real relative imports). In dev it supplies the proxy-backed
 *   `platform`: `context.dev.bindings` (cloudflare-runtime binding hooks)
 *   served through `getPlatformProxy`'s workerd instance, `context.dev.env`
 *   literals overriding same-named proxied values, a `caches` that actually
 *   round-trips, and wrangler-parity `cf`/`ctx` mocks.
 * - `finish(output, context)` — re-bundles the adapter's unbundled
 *   `_worker.js` (and the whole `.svelte-kit/output/server` graph it imports)
 *   for workerd, replacing the bundling `wrangler deploy` performs for the
 *   upstream adapter. Produces entry-first `serverModules` plus the external
 *   workspace set.
 * - `bundle` — workerd resolve conditions and the `cloudflare:` externals.
 */
export const makeCloudflareTarget = (
  config: SvelteKitTargetConfig = {},
): SvelteKitTarget =>
  makeDeployTarget({
    platform: "cloudflare",
    config,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    adapter: (context) =>
      makeCloudflareAdapter({
        ...config.adapter,
        root: context.root,
        ...(context.dev !== undefined
          ? {
              platform: {
                env: context.dev.env,
                bindings: context.dev.bindings,
                services: context.dev.services,
                compatibilityDate: config.compatibilityDate,
                compatibilityFlags: config.compatibilityFlags,
              },
            }
          : undefined),
      }),
    finish: (output, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const entry = context.entry;
        if (entry === undefined) {
          return yield* Effect.fail(
            fail(
              "The SvelteKit build produced no on-disk worker entry for the finishing pass " +
                "(context.entry is missing)",
            ),
          );
        }
        const root = context.root;
        const distDirectory =
          output.distDirectory ?? path.resolve(root, "dist");
        const serverOutDir = path.join(distDirectory, "server");
        yield* fs
          .remove(serverOutDir, { recursive: true, force: true })
          .pipe(
            Effect.mapError((error) =>
              fail("Failed to clean dist/server", error),
            ),
          );

        const externalDirectories = yield* Effect.tryPromise({
          try: async () => {
            const bundle = await rolldown({
              cwd: root,
              input: entry,
              plugins: cloudflare({
                ...(config.compatibilityDate !== undefined
                  ? { compatibilityDate: config.compatibilityDate }
                  : undefined),
                compatibilityFlags: config.compatibilityFlags ?? [
                  "nodejs_compat",
                ],
                exports: ["default"],
              }),
            });
            try {
              const { output: chunks } = await bundle.write({
                dir: serverOutDir,
                format: "esm",
                entryFileNames: "index.js",
                chunkFileNames: "chunks/[name].js",
                sourcemap: false,
              });
              const directories = new Set<string>();
              for (const chunk of chunks) {
                if (chunk.type !== "chunk") continue;
                for (const id of Object.keys(chunk.modules)) {
                  if (
                    !NodePath.isAbsolute(id) ||
                    id.includes("node_modules") ||
                    id.startsWith(root)
                  ) {
                    continue;
                  }
                  directories.add(NodePath.dirname(id));
                }
              }
              return directories;
            } finally {
              await bundle.close();
            }
          },
          catch: (error) =>
            fail("Failed to bundle the worker for workerd", error),
        });

        const wrapCollectorError = (error: FrameworkCore.CollectorError) =>
          fail(error.message, error.cause);
        const modules = yield* FrameworkCore.readServerModulesFromDisk({
          directory: serverOutDir,
          prefix: "server",
        }).pipe(Effect.mapError(wrapCollectorError));
        const serverModules = FrameworkCore.sortServerModules(
          modules,
          NodePath.join("server", "index.js"),
        );
        const externalWorkspaces =
          yield* FrameworkCore.collectExternalWorkspaces(
            externalDirectories,
          ).pipe(Effect.mapError(wrapCollectorError));

        return {
          ...output,
          distDirectory,
          serverModules,
          externalWorkspaces,
        } satisfies FrameworkCore.BuildOutput;
      }),
  });

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeCloudflareTarget;

export default makeCloudflareTarget;
