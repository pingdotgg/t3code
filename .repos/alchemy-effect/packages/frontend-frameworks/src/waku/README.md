# @alchemy.run/frontend-frameworks/waku

Wrangler-free [Waku](https://waku.gg) integration. Implements
`@alchemy.run/frontend-frameworks/core`'s `Framework` service — programmatic
`build` / `dev` over waku's public `unstable_` API — with **no wrangler
dependency and no wrangler.json/toml read or written**, and with the deploy
platform decoupled behind a **deploy target** passed as a value. Cloudflare
Workers is the built-in (and default) target, shipped at
`@alchemy.run/frontend-frameworks/waku/cloudflare`.

## Architecture: framework half × deploy-target half

The package separates two concerns (see
`packages/frontend-frameworks/src/core/README.md` → "Architecture: frameworks × deploy
targets" for the full doctrine):

| Module                               | Role                                                                                                                                           | Platform imports                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `.` (`src/waku/index.ts`, `src/waku/Waku.ts`)  | **Framework half**: waku config synthesis, programmatic build/dev orchestration, `BuildOutput` collection, deploy-target resolution            | **None** (enforced by a unit test) |
| `./cloudflare` (`src/waku/cloudflare.ts`) | **Cloudflare target**: `WakuTarget` implementation — injects `@alchemy.run/cloudflare-runtime/vite`, selects the `./adapter` fork           | `cloudflare-vite-plugin`           |
| `./adapter` (`src/waku/adapter.ts`)       | Wrangler-free fork of `waku/adapters/cloudflare`; bundled _into the worker_ by waku's vite pipeline                                            | worker-side only                   |
| `./source` (`src/waku/source.ts`)         | Alchemy `Cloudflare.Worker` source provider (`{ provider: "@alchemy.run/frontend-frameworks/waku/source" }`) wrapping the framework with the cloudflare target | `cloudflare-runtime` (types)       |

A future platform (e.g. AWS Lambda) is a new target module implementing the
same `WakuTarget` hooks — zero changes to the framework half or to
framework-core.

### The `WakuTarget` contract

`WakuTarget` extends framework-core's generic `DeployTarget` (opaque
`config`, `bundle` conditions/externals, optional wholesale `build`,
`finish`, `serve`) with the two hooks waku's toolchain needs:

```ts
interface WakuTarget<Config = unknown> extends DeployTarget<Config> {
  /** Absolute path of the adapter module selected via `unstable_adapter`. */
  adapter(context: WakuTargetContext): Effect<string, DeployTargetError>;
  /** Vite plugins injected FIRST inside waku's `vite.plugins` (dev + build). */
  vitePlugins(context: WakuTargetContext): Effect<PluginOption[], DeployTargetError>;
}
// WakuTargetContext = { root, wakuDirectory, phase: "build" | "dev" }
```

Why exactly these two seams:

- **`adapter` is mandatory.** If `unstable_adapter` is left unset (and no
  `CLOUDFLARE`/`WORKERS_CI` env var is set), waku silently selects
  `waku/adapters/node`, which cannot run on a non-Node runtime — every
  request 500s opaquely. The framework half always pins the target's
  adapter.
- **`vitePlugins` injection position is load-bearing.** The target's plugins
  go _inside_ waku's `config.vite.plugins` (waku's `extraPlugins` places
  them first, ahead of waku's own environments plugin) — the position
  upstream documents for `@cloudflare/vite-plugin`, and the only one where
  the target's request-proxy middleware registers before waku's Node request
  bridge (which assumes a runnable Node environment and breaks against a
  workerd-backed one).

### The cloudflare target (`@alchemy.run/frontend-frameworks/waku/cloudflare`)

Default export: `(config?: CloudflareVitePluginOptions) => WakuTarget` — the
factory shape `resolveDeployTarget` expects from a target module. It:

- resolves `adapter` to this package's `./adapter` fork — a ~200-line fork of
  `waku/adapters/cloudflare` (built entirely on public
  `waku/adapter-builders` + `waku/internals` exports) whose single functional
  change is `buildEnhancers: []`, dropping
  `waku/adapters/cloudflare-build-enhancer` — the **sole wrangler-file
  writer in waku** (it scrapes/writes `wrangler.jsonc`,
  `dist/server/wrangler.json`, `.wrangler/deploy/config.json`). Everything
  else (Hono app, `cloudflare:workers` env access, SSG via the preview
  server) is behavior-identical to upstream.
- produces `@alchemy.run/cloudflare-runtime/vite` with `main` pinned to
  waku's rsc worker entry (`waku/dist/lib/vite-entries/entry.server.js`,
  resolved from the _project's_ waku install — the deep path is not in
  waku's exports map) and the `viteEnvironments: { entry: "rsc", children:
["ssr"] }` topology. Pinning `main` is mandatory: waku's rsc environment
  declares **two** rolldown inputs (`index` + `build`) while the plugin
  asserts exactly one entry.
- declares `bundle: { conditions: ["workerd", "worker", "module",
"browser"], external: ["cloudflare:"] }`.

The target's `config` is the cloudflare vite plugin's options: worker
name/bindings/assets behavior, `compatibilityDate` / `compatibilityFlags`
(defaulted to include `nodejs_als` — required by waku core — unless the
user's flags already provide AsyncLocalStorage via `nodejs_als`,
`nodejs_compat`, or `nodejs_compat_v2`; full `nodejs_compat` only if user
dependencies need it), and (from the alchemy source provider) the in-memory
dev worker wiring. `main` and `viteEnvironments` are pinned and cannot be
overridden.

## How `build` works

Replicates waku's `runBuild` with zero CLI involvement:

1. Load the _project's_ `vite`, `waku/internals`, `waku/vite-plugins`
   (`loadProjectModule` — the project's installed copies are the ones
   driven, never ours).
2. Resolve the deploy target, run its hooks, and synthesize waku's `Config`
   in memory (`unstable_resolveConfig`): the target's adapter as
   `unstable_adapter`, the target's plugins first in `vite.plugins`,
   `waku`/`hono` deduped (so the adapter fork — which lives outside the
   project — resolves the project's copies), the documented rsc/ssr
   `optimizeDeps.include` entries, and `platform: "neutral"`.
3. `vite.createBuilder({ configFile: false, plugins:
[unstable_combinedPlugins(config), collectorPlugin] }).buildApp()`, with
   `process.env.NODE_ENV` set first (waku's environmentsPlugin bakes it into
   `define`) and `globalThis.__WAKU_START_PREVIEW_SERVER__` set — the SSG
   step of `buildApp` calls `unstable_startPreviewServer`, which throws
   without it. The preview server resolves the **same** waku config as the
   build (upstream parity: waku's CLI reuses the loaded config's plugin
   instances for both `createBuilder` and `vite.preview`), so the cloudflare
   target's `configurePreviewServer` hook serves the freshly built worker
   through workerd and **SSG renders inside workerd with real bindings** —
   a top-level `import { env } from "cloudflare:workers"` in a page module
   is fine. Waku's adapter registers its Node fallback middleware behind the
   proxy; it only fires for targets without a preview mode.
4. Collect the `BuildOutput` with framework-core's collector, using a
   **post-`buildApp` disk re-read**: waku writes
   `__waku_build_metadata.js` and prunes static-only server chunks _after_
   the bundler's `writeBundle` (in-memory captures alone are non-bootable —
   the worker imports the metadata module). Entry selection is pinned to
   waku's `server/index.js` (the adapter's `ExportedHandler`), because the
   rsc environment emits multiple entry chunks (`index`, `build`, and any
   wrapped worker entry) and last-entry-wins picking is nondeterministic.
5. Apply the target's `finish` pass, if it defines one (the cloudflare
   target does not), and return the `BuildOutput` **in-memory only** —
   persistence (`dist/build.json`) is the e2e harness's concern.

If the target defines a wholesale `build` hook, the framework delegates the
entire production build to it instead (the OpenNext-style takeover; no waku
orchestration runs).

## How `dev` works

Replicates waku's `runDev`: `vite.createServer({ configFile: false, plugins:
[unstable_combinedPlugins(config)] })` with the target's plugins inside
waku's config. With the cloudflare target, the rsc environment runs in
**workerd** (module-runner) with in-memory bindings and HMR; waku's own Node
request bridge middleware never fires because the workerd proxy middleware
registers ahead of it. A `port` passed to `dev()` is strict; the
options-level `port` is a non-strict default.

## Options

```ts
import wakuFramework, { make } from "@alchemy.run/frontend-frameworks/waku";

make({
  /** Deploy target: value | (config) => target | module specifier |
   *  harness carriage. Default: "@alchemy.run/frontend-frameworks/waku/cloudflare",
   *  loaded from the PROJECT's node_modules. */
  target: cloudflareTarget({ compatibilityDate: "2026-03-10" }),
  /** @deprecated — the pre-target alias for the target's config
   *  (the harness's top-level `vite` field). */
  vite: undefined,
  /** Extra waku config merged into the in-memory resolveConfig input
   *  (srcDir, distDir, basePath, vite, ...). */
  waku: { srcDir: "src" },
  /** Project root (default: process.cwd()). */
  root: undefined,
  /** Non-strict default dev port. */
  port: 3101,
});
```

Target forms accepted by `target` (resolved per operation with
framework-core's `resolveDeployTarget`):

- a **target value** — full type safety over the config; build it yourself:

  ```ts
  import cloudflareTarget from "@alchemy.run/frontend-frameworks/waku/cloudflare";
  make({ target: cloudflareTarget({ compatibilityDate: "2026-03-10", worker: { name: "app" } }) });
  ```

- a **factory** `(config) => WakuTarget` — applied to the carried config;
- a **module specifier string** — loaded from the _project's_
  `node_modules`; the module default-exports (or names `target`) a value or
  factory;
- the **e2e harness carriage** `{ name?, cloudflare?: { worker } }` — the
  shape the harness's options spread hands the framework factory; selects
  the default target module with `target.cloudflare.worker ?? vite` as its
  config.

## Usage (e2e harness)

```ts
// e2e.config.ts
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";

export default Options.make({
  framework: "@alchemy.run/frontend-frameworks/waku",
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_als"],
        worker: { name: "my-waku-app", bindings: [] },
      },
      preview: {
        /* miniflare options for `e2e preview` / Playwright "live" */
      },
    },
  },
});
```

Or the typed factory form for waku-specific options:

```ts
import wakuFramework from "@alchemy.run/frontend-frameworks/waku";

framework: (options) => wakuFramework({ ...options, port: 3101, waku: { srcDir: "app" } }),
```

The deprecated top-level `vite` / `miniflare` fields keep working as aliases
for `target.cloudflare.worker` / `target.cloudflare.preview`.

## SSG runs inside workerd

The SSG step of `buildApp` boots a `vite.preview` server over the **same**
resolved config as the build, and the cloudflare vite plugin's
`configurePreviewServer` hook serves the freshly built worker through
workerd (`cloudflare-runtime`'s `Runtime.start` over the built server
modules + the client assets directory). Consequences:

- A **top-level** `import { env } from "cloudflare:workers"` in a page
  module works — waku prerenders every static page through the worker, not
  the Node process, so the `cloudflare:` scheme resolves natively. (In a
  build without a platform vite plugin, upstream renders SSG through the
  adapter's Node fallback middleware and the same import breaks with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`.)
- Static pages that read Cloudflare bindings at build time render **with**
  them — the preview worker is configured from the target's plugin options
  (bindings, compatibility date/flags, assets), so the emitted HTML bakes in
  real binding values.

This matches what upstream's `@cloudflare/vite-plugin` provides via its own
`configurePreviewServer` (miniflare over the built output).

## Limitations

- **Durable Objects cannot be defined in a waku app** (upstream
  limitation) — use service bindings to a separate worker.
- **Waku assumes `process.cwd()` is the project root** in places (html-shell
  input, relative rolldown inputs). The alchemy source provider compensates
  by running build/dev under a cwd lock; the e2e harness runs from the
  fixture directory anyway.
- **`nodejs_als` is required** (AsyncLocalStorage); waku core needs nothing
  more from nodejs_compat. The cloudflare target defaults
  `compatibilityFlags` to include `nodejs_als` when the user's flags provide
  no ALS (`nodejs_als`, `nodejs_compat`, or `nodejs_compat_v2`).

## Version pinning

Everything this package touches in waku is `unstable_`-prefixed
(`unstable_combinedPlugins`, `unstable_resolveConfig`,
`unstable_createServerEntryAdapter`, `unstable_startPreviewServer`, the
adapter system itself) and waku is in beta — `waku` is pinned exactly
(`1.0.0-beta.7`). Treat version bumps as deliberate migrations: re-verify
the adapter fork against upstream's `packages/waku/src/adapters/cloudflare.ts`,
the two-input rsc environment merge, and the preview-server global.
