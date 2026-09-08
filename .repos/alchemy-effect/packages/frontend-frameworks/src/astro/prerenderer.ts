// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Wrangler-free workerd prerenderer: the build-side driver of the
 * `__astro_*` prerender protocol, ported from `@astrojs/cloudflare` v14.1.3
 * (`src/prerenderer.ts`).
 *
 * Upstream boots a Vite preview server wrapped around
 * `@cloudflare/vite-plugin` to host the built `prerender` environment. We
 * skip the preview-server indirection entirely: the built output under
 * `dist/server/.prerender/` is loaded from disk into workerd via
 * `cloudflare-runtime`'s `Runtime.start`, with the same bindings, assets
 * directory, and compatibility settings as the entry worker — so prerendered
 * pages render in the same runtime that serves them in production
 * (top-level `cloudflare:*` imports included).
 *
 * Protocol (served by the vendored runtime handler when
 * `virtual:astro-cloudflare:config`'s `isPrerender` is true):
 * - `POST /__astro_static_paths` → all paths to prerender (serialized routes)
 * - `POST /__astro_prerender` → renders one page; a failure is signalled via
 *   the `x-astro-prerender-error` response header
 *
 * This module is heavyweight (Effect + cloudflare-runtime); the integration
 * imports it lazily inside the `astro:build:start` hook so `astro dev` and
 * node-mode builds never load it.
 */
import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import type {
  BindingHooks,
  Module,
} from "@alchemy.run/cloudflare-runtime/core";
import * as Runtime from "@alchemy.run/cloudflare-runtime/core/Runtime";
import * as RuntimeServices from "@alchemy.run/cloudflare-runtime/core/RuntimeServices";
import * as Credentials from "@distilled.cloud/cloudflare/Credentials";
import type { AstroConfig, AstroPrerenderer, PathWithRoute } from "astro";
import { deserializeRouteData, serializeRouteData } from "astro/app/manifest";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { PlatformServices } from "../Platform.ts";
import type {
  PrerenderRequest,
  StaticPathsResponse,
} from "./runtime/prerender-types.ts";
import {
  PRERENDER_ENDPOINT,
  STATIC_PATHS_ENDPOINT,
} from "./runtime/utils/prerender-constants.ts";

/** Matches `dev-server.ts` in `@alchemy.run/cloudflare-runtime/vite`. */
const DEFAULT_COMPATIBILITY_DATE = "2026-05-12";

/** The subdirectory of the server output dir that hosts the prerender build. */
const PRERENDER_OUTPUT_SUBDIR = "./.prerender/";

/** Astro core's entry chunk name pattern for the prerender environment. */
const PRERENDER_ENTRY_PATTERN = /^prerender-entry\..*\.mjs$/;

export interface WorkerdPrerendererOptions {
  /** `config.build.server` — the prerender build lives in `.prerender/` inside it. */
  readonly serverDir: URL;
  /** `config.build.client` — served as the worker's assets directory. */
  readonly clientDir: URL;
  /** `config.trailingSlash` — needed to serialize route data for the protocol. */
  readonly trailingSlash: AstroConfig["trailingSlash"];
  /**
   * The integration's `@alchemy.run/cloudflare-runtime/vite` options: the
   * prerender worker reuses the entry worker's name, bindings, assets
   * options, compatibility settings, and (optionally) runtime context.
   */
  readonly vite?: CloudflareVitePluginOptions | undefined;
}

/**
 * Creates the workerd prerenderer registered via `setPrerenderer` in the
 * `astro:build:start` hook when `prerenderEnvironment` is `"workerd"`.
 */
export function createWorkerdPrerenderer(
  options: WorkerdPrerendererOptions,
): AstroPrerenderer {
  const { serverDir, clientDir, trailingSlash, vite } = options;
  let scope: Scope.Closeable | undefined;
  let serverUrl: string | undefined;

  const origin = (): string => {
    if (serverUrl === undefined) {
      throw new Error(
        "The workerd prerender server is not running. " +
          "This is a bug in @alchemy.run/frontend-frameworks/astro — `setup()` must run before the prerender protocol is driven.",
      );
    }
    return serverUrl;
  };

  return {
    name: "@alchemy.run/frontend-frameworks/astro:workerd-prerenderer",

    async setup() {
      const prerenderDir = fileURLToPath(
        new URL(PRERENDER_OUTPUT_SUBDIR, serverDir),
      );
      const clientDirPath = fileURLToPath(clientDir);
      // The assets manifest is read from the client dir; make sure it exists
      // even for all-prerendered sites where the client build emitted nothing.
      await NodeFs.mkdir(clientDirPath, { recursive: true });
      const modules = await collectOutputModules(prerenderDir);

      scope = Scope.makeUnsafe();
      const context = vite?.context ?? (await buildDefaultContext(scope));
      const worker = vite?.worker;

      const program = Effect.gen(function* () {
        const runtime = yield* Runtime.Runtime;
        return yield* runtime.start({
          ...worker,
          // Suffixed so the prerender instance never collides with a
          // concurrently running dev server in the local dev registry.
          name:
            worker?.name !== undefined
              ? `${worker.name}-prerender`
              : "astro-prerender",
          compatibilityDate:
            vite?.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
          compatibilityFlags: vite?.compatibilityFlags ?? [],
          bindings: (worker?.bindings ?? []) as BindingHooks,
          modules,
          assets: {
            ...worker?.assets,
            directory: worker?.assets?.directory ?? clientDirPath,
          },
        });
      });

      const url = await program.pipe(
        Effect.provide(
          context as Context.Context<RuntimeServices.RuntimeServices>,
        ),
        Scope.provide(scope),
        Effect.runPromise,
      );
      serverUrl = url.origin;
    },

    async getStaticPaths(): Promise<Array<PathWithRoute>> {
      const response = await fetch(`${origin()}${STATIC_PATHS_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const body = await response.text();
        const details = body ? `\n${body}` : "";
        throw new Error(
          `Failed to get static paths from the workerd prerender server (${response.status}: ${response.statusText}).${details}`,
        );
      }

      const data = (await response.json()) as StaticPathsResponse;
      return data.paths.map(({ pathname, route }) => ({
        pathname,
        route: deserializeRouteData(route),
      }));
    },

    async render(request, { routeData }) {
      const body: PrerenderRequest = {
        url: request.url,
        routeData: serializeRouteData(routeData, trailingSlash),
      };

      const response = await fetch(`${origin()}${PRERENDER_ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
      });

      // Only the header marks a failure: pages may intentionally return
      // non-2xx responses while prerendering (e.g. a custom 404 page).
      const prerenderError = response.headers.get("x-astro-prerender-error");
      if (prerenderError) {
        throw new Error(
          `Failed to prerender ${request.url}: ${prerenderError}`,
        );
      }

      return response;
    },

    async teardown() {
      serverUrl = undefined;
      if (scope === undefined) return;
      const closing = scope;
      scope = undefined;
      await Effect.runPromiseExit(
        Scope.closeUnsafe(closing, Exit.void) ?? Effect.void,
      );
    },
  };
}

/**
 * Loads the prerender environment's build output from disk as workerd
 * modules. Module names are output-relative POSIX paths, so the bundle's
 * relative chunk imports (`./chunks/*.mjs`) resolve natively in workerd; the
 * entry chunk (astro core names it `prerender-entry.[hash].mjs`) is listed
 * first, which makes it the worker's main module.
 */
export const collectOutputModules = async (
  outputDir: string,
): Promise<Array<Module>> => {
  let entries: Array<{
    parentPath: string;
    name: string;
    isFile: () => boolean;
  }>;
  try {
    entries = await NodeFs.readdir(outputDir, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (cause) {
    throw new Error(
      `Failed to read the prerender build output at "${outputDir}". ` +
        "The workerd prerenderer requires the `prerender` environment to have been built first.",
      { cause },
    );
  }
  const modules: Array<Module> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = NodePath.join(entry.parentPath, entry.name);
    const relative = NodePath.relative(outputDir, absolute);
    const module = await moduleForFile(absolute, relative);
    if (module !== undefined) modules.push(module);
  }
  // Deterministic order, entry first.
  modules.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entryIndex = modules.findIndex((module) =>
    PRERENDER_ENTRY_PATTERN.test(module.name),
  );
  if (entryIndex === -1) {
    throw new Error(
      `No prerender entry chunk (prerender-entry.*.mjs) found in "${outputDir}". ` +
        "This is a bug in @alchemy.run/frontend-frameworks/astro — the prerender environment should have built the worker server entrypoint.",
    );
  }
  const [entryModule] = modules.splice(entryIndex, 1);
  modules.unshift(entryModule);
  return modules;
};

const TEXT_EXTENSIONS = new Set([".css", ".html", ".svg", ".txt", ".xml"]);

const moduleForFile = async (
  absolute: string,
  relative: string,
): Promise<Module | undefined> => {
  const extension = NodePath.extname(relative).toLowerCase();
  if (extension === ".map") return undefined;
  const name = relative.split(NodePath.sep).join("/");
  switch (extension) {
    case ".js":
    case ".mjs":
      return {
        name,
        type: "ESModule",
        content: await NodeFs.readFile(absolute, "utf8"),
      };
    case ".cjs":
      return {
        name,
        type: "CommonJsModule",
        content: await NodeFs.readFile(absolute, "utf8"),
      };
    case ".json":
      return {
        name,
        type: "Json",
        content: await NodeFs.readFile(absolute, "utf8"),
      };
    case ".wasm":
      return {
        name,
        type: "Wasm",
        content: new Uint8Array(await NodeFs.readFile(absolute)),
      };
    default:
      return TEXT_EXTENSIONS.has(extension)
        ? {
            name,
            type: "Text",
            content: await NodeFs.readFile(absolute, "utf8"),
          }
        : {
            name,
            type: "Data",
            content: new Uint8Array(await NodeFs.readFile(absolute)),
          };
  }
};

/**
 * The default runtime context, mirroring the Cloudflare vite plugin's dev
 * server (`createDefaultContext`): the full `layerRuntime` stack, so local
 * AND remote bindings behave identically to `astro dev`. Built into the
 * prerenderer's scope so `teardown()` disposes everything (including the
 * workerd process).
 */
const buildDefaultContext = (
  scope: Scope.Scope,
): Promise<Context.Context<RuntimeServices.RuntimeServices>> =>
  RuntimeServices.layerRuntime({
    api: {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    },
  }).pipe(
    Layer.provideMerge(PlatformServices),
    Layer.provide(Layer.merge(Credentials.fromEnv(), FetchHttpClient.layer)),
    Layer.buildWithScope(scope),
    Effect.runPromise,
  );
