// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * In-memory SvelteKit `Adapter` — a wrangler-free fork of
 * `@sveltejs/adapter-cloudflare`'s `adapt()`.
 *
 * Differences from upstream:
 *
 * - No `unstable_readConfig` / wrangler.json: always Workers mode with plain
 *   options (`dest` fixed to kit's `cloudflare` build directory, assets
 *   binding defaults to `ASSETS`).
 * - No Pages mode, no `_routes.json`.
 * - The worker shim is generated directly with real relative import paths
 *   (see `WorkerShim.ts`); upstream ships a prebuilt `files/worker.js` and
 *   string-replaces `SERVER`/`MANIFEST` placeholders.
 * - `emulate()` supplies the dev `platform` from `cloudflare-runtime`'s
 *   platform proxy (`getPlatformProxy`) instead of wrangler's: real bindings
 *   round-trip through a workerd instance, `caches` actually stores/matches
 *   (wrangler's is a no-op), `cf`/`ctx` mocks match wrangler's.
 *
 * The adapter does **not** bundle the app: `adapt()` records the assets
 * directory and the unbundled worker entry on `result`, and the `SvelteKit`
 * Framework service runs the rolldown pass afterwards (replacing the bundling
 * `wrangler deploy` performs for the upstream adapter).
 *
 * Note: this module runs as a SvelteKit build callback (kit calls `adapt()`
 * inside Vite's `buildApp`), so it uses kit's synchronous `Builder` API and
 * `node:fs` directly like upstream — it is framework-callback code, not an
 * Effect service.
 */
import type { BindingHooks } from "@alchemy.run/cloudflare-runtime/core";
import type { Adapter, Builder, Emulator } from "@sveltejs/kit";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import { generateWorkerShim } from "./WorkerShim.ts";

export interface CloudflareAdapterResult {
  /**
   * The static-assets directory (client build + prerendered pages +
   * `_headers`/`_redirects`/`.assetsignore`) — upload wholesale as the
   * Worker's assets directory; becomes `BuildOutput.clientDirectory`.
   */
  readonly dest: string;
  /** The generated (unbundled) worker entry — input for the rolldown pass. */
  readonly workerEntry: string;
}

export interface CloudflareAdapterOptions {
  /**
   * Name of the static-assets binding the worker shim serves files through.
   * @default "ASSETS"
   */
  readonly assetsBinding?: string | undefined;
  /**
   * Mirror of Workers static assets `not_found_handling`, driving fallback
   * page generation: `"404-page"` writes `404.html`,
   * `"single-page-application"` writes `index.html` AND makes the worker
   * shim defer router-level not-founds on navigation-shaped requests to the
   * assets layer so the fallback governs (see `WorkerShim.ts`).
   * @default "none"
   */
  readonly notFoundHandling?:
    | "none"
    | "404-page"
    | "single-page-application"
    | undefined;
  /**
   * With `notFoundHandling: "404-page"`: `"spa"` renders the app shell as the
   * fallback, `"plaintext"` writes a plain `Not Found` page.
   * @default "plaintext"
   */
  readonly fallback?: "spa" | "plaintext" | undefined;
  /**
   * Project root used to locate user-authored `_headers` / `_redirects`
   * files.
   * @default process.cwd()
   */
  readonly root?: string | undefined;
  /**
   * Inputs for the dev platform returned from `emulate()` (see
   * {@link CloudflareDevPlatformOptions}). When present, `emulate()` serves
   * `platform = { env, ctx, caches, cf }` through `cloudflare-runtime`'s
   * platform proxy; when absent (production builds), `emulate()` returns an
   * inert empty platform.
   */
  readonly platform?: CloudflareDevPlatformOptions | undefined;
}

export interface CloudflareAdapter extends Adapter {
  /** Populated by `adapt()`; consumed by the SvelteKit Framework service. */
  readonly result: { current?: CloudflareAdapterResult };
  /**
   * Tear down dev resources held by the adapter (the platform-proxy workerd
   * instance, when one was opened). Safe to call multiple times; a no-op
   * when the proxy was never opened.
   */
  readonly dispose: () => Promise<void>;
}

/**
 * Render kit's fallback page (the SPA / 404 app shell) in-process.
 *
 * `builder.generateFallback` delegates to a `worker_threads` fork whose
 * ready/args handshake matches messages on the module's `import.meta.url`
 * string. Under bun on Windows the parent and child spell that URL
 * differently, the handshake never completes, and no fallback is written —
 * the deployed site then 404s every client route (the assets layer has no
 * shell to fall back to). These are kit's own `core/postbuild/fallback.js`
 * steps, minus the fork; the build process is short-lived in every context
 * that runs `adapt` (harness build, alchemy source build), so the fork's
 * dangling-handle isolation buys nothing here.
 */
const generateFallbackInProcess = async (
  builder: Builder,
  dest: string,
): Promise<void> => {
  const kit = builder.config.kit;
  const serverRoot = NodePath.join(kit.outDir, "output", "server");
  const load = async (file: string): Promise<Record<string, any>> =>
    await import(
      /* @vite-ignore */ pathToFileURL(NodePath.join(serverRoot, file)).href
    );
  const { set_building } = await load("internal.js");
  const { Server } = await load("index.js");
  const { manifest } = await load("manifest-full.js");

  // kit's builder loads .env files through vite's `loadEnv`; the adapter
  // only runs inside a build, where vite is importable. Fall back to the
  // process env when it isn't (the shell render rarely reads env at all).
  const env: Record<string, string> = await import("vite").then(
    (vite) => vite.loadEnv("production", kit.env.dir, ""),
    () =>
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
  );

  set_building();
  const server = new Server(manifest);
  await server.init({ env });
  const origin = kit.paths.origin || "http://sveltekit-prerender";
  const response: Response = await server.respond(
    new Request(`${origin}/[fallback]`),
    {
      getClientAddress: () => {
        throw new Error("Cannot read clientAddress during prerendering");
      },
      prerendering: {
        fallback: true,
        dependencies: new Map(),
        remote_responses: new Map(),
      },
      read: (file: string) =>
        NodeFs.readFileSync(NodePath.join(kit.files.assets, file)),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not create a fallback page — failed with status ${response.status}`,
    );
  }
  NodeFs.writeFileSync(dest, await response.text());
};

export const makeCloudflareAdapter = (
  options: CloudflareAdapterOptions = {},
): CloudflareAdapter => {
  const result: { current?: CloudflareAdapterResult } = {};
  let emulator: CloudflareEmulator | undefined;
  return {
    name: "@alchemy.run/frontend-frameworks/sveltekit",
    result,
    async adapt(builder: Builder) {
      const root = options.root ?? process.cwd();
      const assetsBinding = options.assetsBinding ?? "ASSETS";
      const dest = builder.getBuildDirectory("cloudflare");
      const tmp = builder.getBuildDirectory("cloudflare-tmp");

      builder.rimraf(dest);
      builder.rimraf(tmp);
      builder.mkdirp(dest);
      builder.mkdirp(tmp);

      // client assets and prerendered pages
      const assetsDest = dest + builder.config.kit.paths.base;
      builder.mkdirp(assetsDest);
      if (options.notFoundHandling === "404-page") {
        // generate plaintext 404.html first, which can then be overridden by
        // prerendering if the user defined such a page
        const fallback = NodePath.join(assetsDest, "404.html");
        if (options.fallback === "spa") {
          await generateFallbackInProcess(builder, fallback);
        } else {
          NodeFs.writeFileSync(fallback, "Not Found");
        }
      }
      builder.writeClient(assetsDest);
      builder.writePrerendered(assetsDest);
      if (options.notFoundHandling === "single-page-application") {
        await generateFallbackInProcess(
          builder,
          NodePath.join(assetsDest, "index.html"),
        );
      }

      // manifest module
      NodeFs.writeFileSync(
        NodePath.join(tmp, "manifest.js"),
        `export const manifest = ${builder.generateManifest({
          relativePath: posixify(
            NodePath.relative(tmp, builder.getServerDirectory()),
          ),
        })};\n\n` +
          `export const prerendered = new Set(${JSON.stringify(builder.prerendered.paths)});\n\n` +
          `export const base_path = ${JSON.stringify(builder.config.kit.paths.base)};\n`,
      );

      // worker entry (unbundled shim; relative imports into `output/server`)
      const workerEntry = NodePath.join(dest, "_worker.js");
      NodeFs.writeFileSync(
        workerEntry,
        generateWorkerShim({
          serverImport: `./${posixify(NodePath.relative(dest, builder.getServerDirectory()))}/index.js`,
          manifestImport: `./${posixify(NodePath.relative(dest, tmp))}/manifest.js`,
          assetsBinding,
          notFoundHandling: options.notFoundHandling,
        }),
      );
      if (
        typeof builder.hasServerInstrumentationFile === "function" &&
        builder.hasServerInstrumentationFile()
      ) {
        builder.instrument({
          entrypoint: workerEntry,
          instrumentation: NodePath.join(
            builder.getServerDirectory(),
            "instrumentation.server.js",
          ),
        });
      }

      // _headers
      const userHeaders = readOptionalFile(NodePath.join(root, "_headers"));
      NodeFs.writeFileSync(
        NodePath.join(dest, "_headers"),
        generateHeaders(builder.getAppPath(), userHeaders),
      );

      // _redirects
      const userRedirects = readOptionalFile(NodePath.join(root, "_redirects"));
      const redirects = generateRedirects(
        builder.prerendered.redirects,
        userRedirects,
      );
      if (redirects !== undefined) {
        NodeFs.writeFileSync(NodePath.join(dest, "_redirects"), redirects);
      }

      // Workers-mode assets ignore file
      NodeFs.writeFileSync(
        NodePath.join(dest, ".assetsignore"),
        generateAssetsIgnore(),
      );

      result.current = { dest, workerEntry };
    },
    emulate: () =>
      (emulator ??=
        options.platform !== undefined
          ? makeDevPlatformEmulator(options.platform)
          : makeBuildEmulator()),
    dispose: async () => {
      await emulator?.dispose();
    },
    supports: {
      read: () => true,
      instrumentation: () => true,
    },
  };
};

const readOptionalFile = (path: string): string | undefined =>
  NodeFs.existsSync(path) ? NodeFs.readFileSync(path, "utf8") : undefined;

const posixify = (str: string): string => str.replace(/\\/g, "/");

/**
 * Add a rule block for `url` to a `_headers` file, merging into an existing
 * block for the same URL if present (upstream `append_headers`).
 */
export const appendHeaders = (
  url: string,
  rules: Array<string>,
  content: string,
): string => {
  const regex = new RegExp(`^(${url.replaceAll("*", "\\*")})$`, "m");
  const formattedHeaders = rules.map((rule) => `  ${rule}`).join("\n");

  // if the URL already exists, just add header rules to it
  if (regex.test(content)) {
    return content.replace(regex, `$1\n${formattedHeaders}`);
  }

  // otherwise, we add the url and header rules
  return `
${content}
# === START AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
${url}
${formattedHeaders}
# === END AUTOGENERATED SVELTE IMMUTABLE HEADERS ===
`.trim();
};

/**
 * Merge the user's `_headers` content with the generated kit rules
 * (`noindex` for the app dir, immutable caching for hashed assets).
 */
export const generateHeaders = (appDir: string, content = ""): string => {
  content = appendHeaders(
    `/${appDir}/*`,
    ["X-Robots-Tag: noindex", "Cache-Control: no-cache"],
    content,
  );
  content = appendHeaders(
    `/${appDir}/immutable/*`,
    ["! Cache-Control", "Cache-Control: public, immutable, max-age=31536000"],
    content,
  );
  return content;
};

/**
 * Merge the user's `_redirects` content with rules for kit's prerendered
 * redirects. Returns `undefined` when there is nothing to write.
 */
export const generateRedirects = (
  redirects: Map<string, { status: number; location: string }>,
  content?: string,
): string | undefined => {
  const parts: Array<string> = [];
  if (content !== undefined) {
    parts.push(content);
  }
  if (redirects.size > 0) {
    const rules = Array.from(
      redirects.entries(),
      ([path, redirect]) => `${path} ${redirect.location} ${redirect.status}`,
    ).join("\n");
    parts.push(
      `
# === START AUTOGENERATED SVELTE PRERENDERED REDIRECTS ===
${rules}
# === END AUTOGENERATED SVELTE PRERENDERED REDIRECTS ===
`.trimEnd(),
    );
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
};

/** Workers-mode `.assetsignore`: files in `dest` that are not static assets. */
export const generateAssetsIgnore = (): string =>
  `
_worker.js
_routes.json
_headers
_redirects
`.trimStart();

// ---------------------------------------------------------------------------
// Dev platform emulation (cloudflare-runtime platform proxy)
// ---------------------------------------------------------------------------

/** Inputs for the proxy-backed dev platform served from `emulate()`. */
export interface CloudflareDevPlatformOptions {
  /**
   * Literal `platform.env` overrides. Applied on top of the proxied binding
   * values — a same-named literal always wins (back-compat with the phase-1
   * stub platform, whose env was literals only).
   */
  readonly env?: Record<string, unknown> | undefined;
  /**
   * Bindings to expose on `platform.env` — the same hook shapes
   * `cloudflare-runtime`'s `Runtime.start` accepts (`Text.local`,
   * `KvNamespace.local`, `D1.local`, remote bindings, …). Typed opaquely
   * because the specs travel through the target-agnostic framework half;
   * the values must be `cloudflare-runtime` `BindingHooks`.
   */
  readonly bindings?: ReadonlyArray<unknown> | undefined;
  /**
   * Pre-built `Context<RuntimeServices>` to host the proxy in (opaque —
   * travels through the target-agnostic framework half). Enables
   * remote()-lowered bindings, which the proxy's internal local-only layer
   * cannot serve.
   */
  readonly services?: unknown;
  /** Compatibility date for the binding-proxy workerd instance. */
  readonly compatibilityDate?: string | undefined;
  /** Compatibility flags for the binding-proxy workerd instance. */
  readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  /** Name of the proxy workerd service. @default "sveltekit-dev-platform-proxy" */
  readonly name?: string | undefined;
  /**
   * Override how the platform proxy is opened. A test seam — the default
   * dynamically imports `cloudflare-runtime`'s `getPlatformProxy`.
   */
  readonly openProxy?: OpenDevPlatformProxy | undefined;
}

/** The subset of `cloudflare-runtime`'s `PlatformProxy` the emulator serves. */
export interface DevPlatformProxy {
  readonly env: Record<string, unknown>;
  readonly cf: Record<string, unknown>;
  readonly ctx: unknown;
  readonly caches: unknown;
  readonly dispose: () => Promise<void>;
}

export interface OpenDevPlatformProxyOptions {
  readonly name: string;
  readonly compatibilityDate?: string | undefined;
  readonly compatibilityFlags?: ReadonlyArray<string> | undefined;
  readonly bindings: ReadonlyArray<unknown>;
  /** See {@link CloudflareDevPlatformOptions.services}. */
  readonly services?: unknown;
}

export type OpenDevPlatformProxy = (
  options: OpenDevPlatformProxyOptions,
) => Promise<DevPlatformProxy>;

/** A kit `Emulator` that owns a disposable platform proxy. */
export interface CloudflareEmulator extends Emulator {
  /** Tear down the proxy. No-op when it was never opened. */
  readonly dispose: () => Promise<void>;
}

/**
 * The default proxy opener: `cloudflare-runtime`'s `getPlatformProxy`
 * (workerd hosting the bindings behind the internal proxy worker, local-only
 * layer, state in a temp directory). Imported lazily so production builds
 * never load the runtime machinery.
 */
const openPlatformProxy: OpenDevPlatformProxy = async (options) => {
  const { getPlatformProxy } =
    await import("@alchemy.run/cloudflare-runtime/core/platform-proxy");
  return await getPlatformProxy({
    name: options.name,
    ...(options.compatibilityDate !== undefined
      ? { compatibilityDate: options.compatibilityDate }
      : undefined),
    ...(options.compatibilityFlags !== undefined
      ? { compatibilityFlags: [...options.compatibilityFlags] }
      : undefined),
    bindings: options.bindings as BindingHooks,
    ...(options.services !== undefined
      ? {
          services: options.services as Parameters<
            typeof getPlatformProxy
          >[0]["services"],
        }
      : undefined),
  });
};

/**
 * `platform.env` for prerenderable routes: any key access throws (mirroring
 * upstream), because prerendered pages must not depend on request-time
 * bindings.
 */
const guardPrerenderEnv = (
  env: Record<string, unknown>,
): Record<string, unknown> => {
  const guarded: Record<string, unknown> = {};
  for (const key of Object.keys(env)) {
    Object.defineProperty(guarded, key, {
      get: () => {
        throw new Error(
          `Cannot access platform.env.${key} in a prerenderable route`,
        );
      },
    });
  }
  return guarded;
};

/**
 * The dev-platform emulator: serves `platform = { env, ctx, caches, cf }`
 * from `cloudflare-runtime`'s platform proxy — our wrangler-free equivalent
 * of upstream `adapter-cloudflare`'s `getPlatformProxy`-based `emulate()`.
 *
 * - The proxy (a workerd instance hosting the bindings) is opened lazily on
 *   the first `platform()` call and shared across requests; dispose it with
 *   the dev server via {@link CloudflareEmulator.dispose}.
 * - `env` carries every configured binding, callable from Node
 *   (`env.KV.get("key")`, `env.DB.prepare("...").all()`); literal
 *   `options.env` values override same-named proxied values.
 * - `caches` actually round-trips (`put`/`match`/`delete` hit an in-memory
 *   store in the proxy worker — unlike wrangler, whose dev `caches` is a
 *   no-op); `cf` is the same mock object miniflare falls back to; `ctx` is
 *   wrangler's no-op `ExecutionContext` mock.
 * - Inherited proxy limitations: binding methods returning rich class
 *   instances (e.g. `R2Object`) are unsupported, and intermediate values
 *   (e.g. `DurableObjectId`) need an explicit `await` before synchronous use
 *   — see `cloudflare-runtime/platform-proxy`.
 */
export const makeDevPlatformEmulator = (
  options: CloudflareDevPlatformOptions = {},
): CloudflareEmulator => {
  const openProxy = options.openProxy ?? openPlatformProxy;
  let opened: Promise<DevPlatformProxy> | undefined;
  const open = () =>
    (opened ??= openProxy({
      name: options.name ?? "sveltekit-dev-platform-proxy",
      compatibilityDate: options.compatibilityDate,
      compatibilityFlags: options.compatibilityFlags,
      bindings: options.bindings ?? [],
      services: options.services,
    }));
  return {
    platform: async ({ prerender }) => {
      const proxy = await open();
      const env = { ...proxy.env, ...options.env };
      return {
        env: prerender ? guardPrerenderEnv(env) : env,
        ctx: proxy.ctx,
        caches: proxy.caches,
        cf: proxy.cf,
      } as unknown as App.Platform;
    },
    dispose: async () => {
      if (opened === undefined) return;
      const proxy = await opened.catch(() => undefined);
      await proxy?.dispose();
    },
  };
};

/**
 * The inert platform used when the adapter is constructed without dev
 * platform options (production builds): empty env, no-op `ctx`/`caches`,
 * empty `cf`. Never opens a proxy.
 */
const makeBuildEmulator = (): CloudflareEmulator => {
  const noopCache = {
    match: async () => undefined,
    put: async () => {},
    delete: async () => false,
  };
  const platform = {
    env: {},
    ctx: {
      waitUntil: (_promise: Promise<unknown>) => {},
      passThroughOnException: () => {},
    },
    caches: {
      default: noopCache,
      open: async () => noopCache,
    },
    cf: {},
  };
  return {
    platform: () => platform as unknown as App.Platform,
    dispose: async () => {},
  };
};
