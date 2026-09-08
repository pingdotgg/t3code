# @alchemy.run/frontend-frameworks/nuxt

Wrangler-free Nuxt integration: programmatic build and dev for Nuxt projects,
with the deploy platform passed in as a **deploy target** value. Cloudflare
Workers is the built-in target (`@alchemy.run/frontend-frameworks/nuxt/cloudflare`); the
framework half of this package contains no Cloudflare code at all.

## Architecture: framework half × target half

The package follows the framework × deploy-target split defined in
`@alchemy.run/frontend-frameworks/core` (see its README for the full `DeployTarget`
contract):

| Module                                                   | Role                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@alchemy.run/frontend-frameworks/nuxt` (`src/nuxt/Nuxt.ts`, `src/nuxt/index.ts`)  | **Framework half.** Drives the PROJECT's `@nuxt/kit` programmatically (loaded via the universally-resolvable `nuxt/kit` subpath): `loadNuxt` for build and dev, hook registration, nitro output mapping onto framework-core's `BuildOutput`, and the `Framework` service implementation. Target-agnostic — zero Cloudflare imports. |
| `@alchemy.run/frontend-frameworks/nuxt/cloudflare` (`src/nuxt/cloudflare.ts`) | **Target half.** The Cloudflare Workers `NuxtTarget`: nitro's `cloudflare_module` preset, the wrangler-free nitro config enforcement (`deployConfig: false`, `nodeCompat: true`), the user-entry seam (`main` → nitro's entry), and the proxy-backed dev platform (`src/nuxt/dev/host.ts`).                                              |
| `@alchemy.run/frontend-frameworks/nuxt/source` (`src/nuxt/source.ts`)         | Alchemy Worker **source provider** (structural `WorkerSourceModule` contract): maps the Nuxt build onto alchemy's bundle/assets/hash slots, plus a rebuild-free memo hash and nitro-dev `dev()`. Cloudflare-specific by nature; it passes the cloudflare target factory to the framework directly.                                  |
| `src/nuxt/dev/{host,plugin,shared}.ts`                        | The **dev transport**: host half opens cloudflare-runtime's platform proxy and injects connect info; worker half is a dev-only nitro plugin that reconstructs `event.context.cloudflare` inside nitro's dev SSR worker thread.                                                                                                      |

Background on why the integration is shaped this way:

- **The project's `nuxt.config.ts` loads natively.** `loadNuxt({ cwd, dev,
ready: false, overrides })` resolves the user's config, layers, and modules
  through c12 exactly as `nuxi` would. The integration's injection rides the
  highest-priority `overrides` layer (`src/UserConfig.ts`); the user's file
  stays authoritative for everything not named there.
- **Hooks register before `nuxt.ready()`.** With `ready: true` the hooks fire
  inside `loadNuxt` itself and a late registration misses them, so the
  package always loads with `ready: false`, registers `nitro:config` /
  `nitro:init`, then calls `ready()` + `buildNuxt` — the same flow `nuxi`
  drives.
- **The deploy target owns the nitro preset.** `nitro:config` gets the last
  word on the keys the integration owns. Because the overrides layer would
  silently shadow a user-set preset in the merged options, the user's raw
  value is read from the project's own config layer
  (`nuxt.options._layers[0].config`) and a foreign `nitro.preset` **fails the
  build with an actionable error** (`findPresetConflict`) — the user's nitro
  output would never be deployed.
- **The `cloudflare_module` output needs no finishing pass.** Nitro emits
  self-contained workerd ESM: `.output/server/index.mjs` + chunks and
  `.output/public` (prerendered pages and `_headers` merged in). The
  `BuildOutput` is read straight from disk — `serverModules` entry-first
  from `.output/server`, `clientDirectory` = `.output/public`.

### The `NuxtTarget` contract

The framework half declares what any deploy target must provide
(`src/Nuxt.ts`):

```ts
interface NuxtTarget extends DeployTarget<NuxtTargetConfig> {
  /** The nitro deployment preset this target builds with. */
  nitroPreset: string;
  /** Last-word mutation of the resolved nitro config (`nitro:config`). */
  configureNitro?(nitroConfig: NitroConfigSlice, context: NuxtNitroContext): void;
  /** Acquire the dev platform (scoped) and return the injection dev needs. */
  devPlatform?(context: NuxtDevPlatformContext): Effect<NuxtDevPlatform, DeployTargetError, Scope>;
}
```

- `nitroPreset` — enforced on the resolved nitro config after every module
  and layer has contributed.
- `configureNitro(nitroConfig, context)` — runs from the `nitro:config` hook;
  `context.entry` carries the resolved user worker entry when one is
  configured.
- `devPlatform(context)` — the target's dev story: acquire whatever serves
  the platform environment in dev (scoped — the finalizer runs AFTER the dev
  server closes, so the platform outlives the last in-flight request) and
  return `{ nitroPlugins, runtimeConfig }` for the framework half to inject
  through the `loadNuxt` overrides. When absent, `dev` runs the plain
  framework dev server with no platform bridge.

`Framework.build` runs: resolve target → (`target.build`? delegate wholesale)
→ `loadNuxt` with the preset + user overrides → register hooks → `ready()` +
`buildNuxt` → read `.output` → `applyDeployTargetFinish` (a no-op for
cloudflare_module, but the contract is honored for targets that
post-process). `Framework.dev` runs `loadNuxt({ dev: true })` → hooks →
`ready()` → `nuxt.server.listen` → `buildNuxt` (the same flow `nuxi dev`
drives), with a bounded readiness probe before returning the URL.

### The Cloudflare target

`makeCloudflareTarget(config)` (default export of
`@alchemy.run/frontend-frameworks/nuxt/cloudflare`) implements the contract:

- **`nitroPreset`** — `"cloudflare_module"`.
- **`configureNitro`** — wrangler-free doctrine: `cloudflare.deployConfig:
false` (nitro must never write a `wrangler.json` into user projects) and
  `cloudflare.nodeCompat: true` by default (without a wrangler config on
  disk nitro would otherwise skip its hybrid workerd node-compat; the
  deployed worker enables the `nodejs_compat` flag to match).
- **The user-entry seam** — a configured `main` becomes nitro's `entry`, so
  the user module's exports are the worker's exports. The entry is set on
  the nitro INSTANCE at `nitro:init`, not in the config: nitro's prerenderer
  clones `options._config` for its Node-preset sub-build, and a
  workerd-flavored user entry (importing `cloudflare:` modules) must not
  leak into that clone. A user entry wraps nitro's runtime handler and adds
  its own exports (Durable Object classes, ...):

  ```ts
  // worker-entry.mjs
  import nitroHandler from "nitropack/presets/cloudflare/runtime/cloudflare-module";
  export { MyDurableObject } from "./durable-object.mjs";
  export default nitroHandler;
  ```

- **`devPlatform`** — the wrangler-free dev bridge (next section).

## The dev transport

Dev runs Nuxt's own dev server (nitro dev, SSR in a Node worker thread, full
HMR) with the `cloudflare_module` runtime contract served wrangler-free. The
transport has two halves sharing one contract (`src/dev/shared.ts`):

- **Host half (`src/dev/host.ts`)** — runs in the alchemy / e2e-harness
  process. It opens cloudflare-runtime's platform proxy (`getPlatformProxy`,
  our wrangler-free reimplementation of wrangler's API: a local workerd
  instance hosting the configured binding hooks) and produces the
  `NuxtDevPlatform` injection: the dev-only nitro plugin path plus a
  `runtimeConfig` entry carrying the `DevConnectInfo` — the proxy's `url` and
  `token` (two plain strings), the absolute path of cloudflare-runtime's
  runtime-free client module, and the literal env overrides.
- **Worker half (`src/dev/plugin.ts`)** — a nitro plugin bundled into
  nitro's dev SSR worker thread. It reads the connect info back out of
  `useRuntimeConfig()` and reconstructs the platform over HTTP with
  `platform-proxy/connect`. On every request it sets the same contract
  `nitro-cloudflare-dev` provides and production serves natively:
  `event.context.cf`, `event.context.waitUntil`, and
  `event.context.cloudflare = { request, env, context }` — `env` is the live
  proxied environment (binding calls round-trip to the host's workerd
  instance, so state is SHARED with the host proxy).

Because the client state is just `{ url, token }`, the worker-thread hop is
trivial: `runtimeConfig` strings survive nitro's bundling and worker
replacement, so the plugin reconnects on its own after every dev reload
while binding state (KV, DO storage, ...) stays live in the host's workerd
instance. The connection is established lazily on the first request and
re-created after a failure; when the host proxy is gone, requests fail fast
with a descriptive cause instead of hanging.

Injected plugins live under `node_modules` (this package's dist), so their
directories are forced into `nitro.externals.inline` — nitro's externals
pass would otherwise keep the plugin external and node would resolve its
`nitropack/runtime` import against the raw package, whose
`#nitro-internal-virtual/*` imports only exist inside the dev bundle.

## Usage

### With the e2e harness (`e2e.config.ts`)

```ts
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import * as Nuxt from "@alchemy.run/frontend-frameworks/nuxt";

export default Options.make({
  // string form: framework: "@alchemy.run/frontend-frameworks/nuxt"
  framework: (options) => Nuxt.layer(Nuxt.fromHarnessOptions(options as Nuxt.HarnessOptions)),
  target: {
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        main: "worker-entry.ts",
        worker: {
          bindings: [
            /* ... */
          ],
        },
      },
      preview: {
        /* miniflare options for `e2e preview` / Playwright "live" */
      },
    },
  },
});
```

`fromHarnessOptions` reads the target-scoped carriage
(`target.cloudflare.worker`, falling back to the deprecated top-level `vite`
alias): compatibility date/flags, the user worker entry, and the declared
binding hooks, which pass through wholesale to the dev platform proxy —
resource bindings (KV, D1, …) included, not just literal values.

### Direct (typed) usage

```ts
import * as Nuxt from "@alchemy.run/frontend-frameworks/nuxt";

const layer = Nuxt.layer({
  compatibilityDate: "2026-03-10",
  compatibilityFlags: ["nodejs_compat"],
  main: "worker-entry.ts",
  nuxt: { routeRules: { "/about": { prerender: true } } },
  dev: {
    port: 3104,
    // cloudflare-runtime binding hooks, served on event.context.cloudflare.env
    bindings: [KvNamespace.local("MY_KV")],
    // literal overrides — win over same-named proxied values
    env: { MY_SECRET: "..." },
  },
});
```

### Selecting a deploy target

`NuxtOptions.target` accepts a `DeployTargetInput`:

```ts
// 1. default — omitted: resolves "@alchemy.run/frontend-frameworks/nuxt/cloudflare"
//    from the project's node_modules
Nuxt.layer({});

// 2. factory — applied to the config the framework assembles from options
import cloudflareTarget from "@alchemy.run/frontend-frameworks/nuxt/cloudflare";
Nuxt.layer({ target: cloudflareTarget });

// 3. value — full control; options-level compat fields are ignored
Nuxt.layer({ target: cloudflareTarget({ compatibilityDate: "2026-03-10" }) });

// 4. specifier — loaded from the project's dependency tree
Nuxt.layer({ target: "@my-scope/nuxt-aws" });
```

A future target (e.g. AWS) implements `NuxtTarget` in its own module — no
change to this package's framework half.

## Options

### `NuxtOptions` (framework)

| Option               | Default                                                | Purpose                                                                                                                            |
| -------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `root`               | `process.cwd()`                                        | Project root (the directory containing `nuxt.config.ts`).                                                                          |
| `target`             | `"@alchemy.run/frontend-frameworks/nuxt/cloudflare"`                   | Deploy target: value, factory, or module specifier.                                                                                |
| `compatibilityDate`  | —                                                      | Forwarded to the target config (carried for serve/deploy consumers).                                                               |
| `compatibilityFlags` | `["nodejs_compat"]` (applied by the cloudflare target) | Forwarded to the target config. Nitro's workerd build uses hybrid Node compat, so `nodejs_compat` is effectively required.         |
| `main`               | —                                                      | The USER's worker entry (nitro's entry/exports seam). Relative paths resolve against the root.                                     |
| `nuxt`               | —                                                      | Nuxt config overrides merged over the project's `nuxt.config.ts` (integration wins). `nitro.preset` is always owned by the target. |
| `dev.port`           | random                                                 | Dev-server port (overridden by `FrameworkDevOptions.port`).                                                                        |
| `dev.bindings`       | `[]`                                                   | Binding specs the target's dev platform serves (Cloudflare: cloudflare-runtime `BindingHooks`).                                    |
| `dev.env`            | `{}`                                                   | Literal env overrides on the dev platform — a same-named literal wins over the proxied binding value.                              |

### `NuxtSourceOptions` (`./source`, alchemy)

`rootDir`, `memo` (`include`/`exclude` globs + `lockfile`, default
gitignore-aware), `nuxt`, `main` — all JSON-serializable (they persist in
alchemy state and participate in the Worker's metadata hash). `build()` maps
the nitro output onto alchemy's source contract (entry-first bundle files,
manifest-hashed assets honoring `.assetsignore`/`_headers`/`_redirects`,
project-tree `input` hash); `hash()` recomputes the input hash without
building; `dev()` starts nitro's dev server with the proxy-backed platform:
the Worker's binding hooks (`ctx.worker.bindings`) serve on
`event.context.cloudflare.env`, while literal `props.env` values (strings;
`Redacted` values unwrapped) apply as overrides.

## Limitations & known constraints

- **Pinned upstream surfaces.** nuxt `4.5.x`, nitropack `2.13.x` (see
  `fixtures/nuxt`); treat version bumps as deliberate migrations. Note the
  repo's `minimumReleaseAge` install gate (3 days) when bumping.
- **`isr` route rule ignored.** Nitro implements `isr` only in the Vercel
  and Netlify presets — on `cloudflare_module` it is silently dropped at
  build time and the route renders on demand like any other SSR route. Use
  `prerender` for build-time static routes or `cache` rules for runtime
  caching.
- **Durable Objects are not servable in dev.** The platform proxy cannot
  host user worker-entry classes — DOs declared via the entry/exports seam
  only exist in the production build, so DO namespace bindings fail in dev.
- **Foreign `nitro.preset` is a hard error.** The deploy target owns the
  preset; a user-configured preset fails the build with an actionable
  message instead of being silently replaced.
- **Dev fidelity.** SSR runs in nitro's Node worker thread, not workerd —
  forcing nitro's dev flow into workerd is a non-goal. The platform proxy's
  documented limitations apply in dev:
  - binding methods whose results are rich class instances (e.g. R2's
    `R2Object`) are not supported over the proxy — results must be
    JSON-compatible values, bytes, dates, streams, or `DurableObjectId`s;
  - no synchronous materialisation of intermediate values —
    `env.DO.idFromName("a").toString()` needs
    `(await env.DO.idFromName("a")).toString()`;
  - `connect()` on sockets is unsupported, and cross-binding stub arguments
    are rejected.
- **`event.context.waitUntil` is accepted and dropped in dev** (long-lived
  dev process: background work simply runs). Production serves the real
  `ExecutionContext`.
- **`context.cloudflare.request` carries no body in dev.** The node request
  stream belongs to h3's own body parsing — read bodies through h3
  (`readBody`), not `context.cloudflare.request`.
- **Telemetry/devtools are disabled in dev** — the dev server runs headless
  under alchemy / the e2e harness.

## Testing

- `bun run test` — unit tests: build hook wiring and output mapping
  (`test/Nuxt.test.ts`), the target contract (`test/Target.test.ts`),
  config synthesis and preset-conflict policy (`test/UserConfig.test.ts`),
  and the dev transport — host platform acquisition, connect-info shape,
  and the plugin's request bridge against a fake proxy server
  (`test/Dev.test.ts`).
- `fixtures/nuxt` — the end-to-end fixture (Playwright against both the
  miniflare-served production build and the nitro dev server); see its
  layout for the covered surface (SSR routes, `server/` API routes,
  prerendered pages, `event.context.cloudflare.env` with real bindings and
  literal overrides, and the custom `worker-entry.ts` seam).
