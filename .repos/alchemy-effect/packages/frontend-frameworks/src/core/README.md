# @alchemy.run/frontend-frameworks/core

Platform-neutral core for framework integrations (Vite, Waku, Astro, SvelteKit, Next.js):

- **`BuildOutput` contract** — `{ clientDirectory, serverModules (entry first, sha256-hashed), externalWorkspaces }`, plus standalone persistence helpers (`writeBuildOutput` / `readBuildOutput`) used by the e2e harness for its `dist/build.json` (persistence is a harness/testing concern, not part of the `Framework` contract).
- **Build-output collector** — the `alchemy:build-output` Vite plugin (`makeBuildOutputCollector`): captures client/server outputs across environments, with `skipEnvironments` (e.g. Astro's `prerender`), deterministic server-entry selection (pins the wrapped `\0distilled:worker-entry:` main), and a post-`buildApp` disk re-read mode (`collect({ fromDisk: true })`) for frameworks that write or prune server modules after the bundler finishes (e.g. Waku).
- **`readServerModulesFromDisk`** — for frameworks whose final server bundle lives on disk (SvelteKit's rolldown pass, Next.js's `.open-next` output).
- **`loadProjectModule`** — load the _project's_ `vite`/framework install instead of ours.
- **`Framework` service contract** — the common effectful `{ build, dev }` service each framework package implements; `build` returns the `BuildOutput` purely in-memory.
- **`DeployTarget` contract** — the deploy target as a _value_ passed to framework integrations, with Cloudflare Workers as the first implementation. See the architecture section below.

## Architecture: frameworks × deploy targets

A framework integration answers "how do I drive this framework's build and dev
servers programmatically?". A **deploy target** answers "what platform is the
server code being produced _for_?". These are orthogonal, and the package
layout reflects it:

- **framework-core** (this package) is platform-neutral: `BuildOutput`, the
  collector, the loaders, the `Framework` service, and the generic
  `DeployTarget` seams below. It never imports a platform SDK or bundler
  plugin for a specific runtime.
- **Framework packages** (`@alchemy.run/frontend-frameworks/waku`, `.../astro`,
  `.../sveltekit`, and later `.../nextjs`) own the framework mechanics —
  programmatic build/dev entry points, config synthesis, adapter plumbing —
  and take the deploy target as a **prop** (`target:`) rather than hardcoding
  Cloudflare.
- **Per-framework target modules** own the halves that are neither generic
  nor platform-neutral: waku's cloudflare adapter fork, astro's integration
  fork, kit's in-memory adapter + post-adapt re-bundle. Each ships as a
  subpath of its framework package (e.g. `@alchemy.run/frontend-frameworks/waku/cloudflare`
  exporting the `WakuCloudflareTarget`). A future AWS target is a new subpath
  (`@alchemy.run/frontend-frameworks/waku/aws`) implementing the same seams — no change to
  the framework package or to framework-core.

### The `DeployTarget` interface

```ts
interface DeployTarget<Config = unknown> {
  /** Stable platform identifier: "cloudflare", "aws", ... */
  readonly platform: string;
  /** Opaque target configuration — never inspected by framework-core.
   *  Cloudflare: worker name/bindings/compatibility; AWS later: its own shape. */
  readonly config: Config;
  /** The USER's own server entry, when the target config carries one: a module
   *  that wraps the framework's emitted entry (Cloudflare: a worker entry
   *  re-exporting Durable Object classes). `{ main: string }`, relative to the
   *  project root or absolute — resolve via `resolveDeployTargetEntry`. */
  readonly entry?: DeployTargetEntry;
  /** Resolve/bundle settings for server code: conditions (e.g. ["workerd",
   *  "worker", "module", "browser"]), externals (e.g. ["cloudflare:"]), mainFields. */
  readonly bundle?: DeployTargetBundleOptions;
  /** WHOLESALE build takeover: when defined, the framework package delegates
   *  its entire production build here (the OpenNext case for Next.js).
   *  Most targets leave this undefined and let the framework drive. */
  readonly build?: (
    context: DeployTargetBuildContext,
  ) => Effect<BuildOutput, DeployTargetError, DeployTargetServices>;
  /** Finishing pass over the framework-produced BuildOutput — the
   *  SvelteKit-style post-adapt re-bundle for the target runtime.
   *  `context.entry` carries the on-disk server entry when the framework's
   *  adapt step wrote one. Run via `applyDeployTargetFinish`. */
  readonly finish?: (
    output: BuildOutput,
    context: DeployTargetFinishContext,
  ) => Effect<BuildOutput, DeployTargetError, DeployTargetServices>;
  /** The target's local serving story for BUILT server code (preview-parity:
   *  miniflare / cloudflare-runtime today; a Lambda emulator later).
   *  Scoped — closing the Scope stops the server. Returns { url, fetch? }. */
  readonly serve?: (
    context: DeployTargetServeContext,
  ) => Effect<DeployTargetServer, DeployTargetError, Scope | DeployTargetServices>;
}
```

(`DeployTargetServices = FileSystem | Path` — the same services the harness
provides to `Framework` layers.)

Only these seams are generic. Everything else a platform needs — the vite
plugin to inject, the adapter to select, dev-server integration that reaches
inside a framework's toolchain — belongs to the per-framework target module,
which **extends** `DeployTarget` with framework-specific hooks:

```ts
// packages/frontend-frameworks/src/waku/cloudflare.ts (illustrative)
export interface WakuTarget extends DeployTarget<WakuCloudflareConfig> {
  /** Absolute path of the adapter module waku's config should select. */
  readonly adapterPath: Effect<string, DeployTargetError>;
  /** Vite plugins to inject into waku's `vite.plugins` (dev + build). */
  readonly vitePlugins: (context: ...) => Effect<PluginOption[], ...>;
}
export default (config: WakuCloudflareConfig): WakuTarget => ...;
```

Helpers exported by framework-core:

- `makeDeployTarget(target)` — identity with contract checking; preserves
  framework-specific extensions.
- `isDeployTarget(value)` — structural guard (`platform: string` + `config`).
- `resolveDeployTarget(root, input, config)` — resolves a
  `DeployTargetInput`: a target value (as-is), a factory
  (`(config) => target`, applied to `config`), or a module specifier string
  (loaded from the _project's_ `node_modules` via `loadProjectModule`; the
  module's `default` — or named `target` — export is the value or factory).
- `applyDeployTargetFinish(target, output, context)` — run the finishing pass
  if defined, else pass the build through.
- `resolveDeployTargetEntry(target, { root })` — the user-entry seam's
  accessor: the absolute path of `target.entry.main` (resolved against the
  project root), or `undefined` when no user entry is configured.
- `selectEntryByFacade(entryPath)` (collector) — a `selectEntry` predicate
  pinning the chunk whose facade module is that entry file (tolerates the
  `\0distilled:worker-entry:` wrapper id).

### The user-entry seam (`target.entry`)

Some apps need their **own module** to be the deployed entry instead of the
framework's — on Cloudflare, a worker entry that wraps the framework's fetch
handler and additionally exports Durable Object / Workflow classes (they must
live on the same worker for their bindings to resolve). The seam is designed
once, cross-framework:

1. **Carriage.** The target's config carries the raw value in its own shape
   (Cloudflare: the vite plugin's `main` option — so the built-in Vite path
   honors it natively). The target surfaces it platform-neutrally as
   `entry: { main }`; framework packages read it via
   `resolveDeployTargetEntry(target, { root })`.
2. **Bundler entry.** The framework package makes the user entry the entry
   module its build/dev pipeline serves, instead of unconditionally pinning
   the framework's own emitted entry (waku:
   `makeWakuPluginOptions` honors the user main; dev's module runner serves
   the wrapped entry, so DO classes exist in dev too).
3. **Wrappable handler.** The framework package exposes a stable importable
   specifier for its emitted server handler so the user entry has something
   to wrap. Convention: `virtual:{framework}/server-entry` (precedent: React
   Router's `virtual:react-router/server-build`; waku ships
   `virtual:waku/server-entry`).
4. **Entry selection.** The chunk built from the user entry becomes
   `serverModules[0]` (`selectEntryByFacade`); the framework's own entry
   remains an ordinary chunk the user entry imports.

### How a framework package consumes the target

1. Its options gain `target?: <Framework>TargetInput` (a
   `DeployTargetInput<<Framework>Target, Config>`), defaulting to its own
   cloudflare subpath specifier (e.g. `"@alchemy.run/frontend-frameworks/waku/cloudflare"`).
   Resolve it once per operation with
   `resolveDeployTarget(root, input, config)` where `config` is the
   target-scoped configuration the caller passed.
2. `Framework.build`:
   - if `target.build` is defined, delegate wholesale (OpenNext).
   - otherwise run the framework build, consulting the target's
     framework-specific hooks (plugin/adapter injection) and `target.bundle`
     where the framework package does its own resolving/bundling, then finish
     with `applyDeployTargetFinish(target, output, { root, framework, entry })`.
3. `Framework.dev`: the HMR dev server is framework-owned; target-specific
   dev integration (the workerd module-runner vite plugin, dev `platform`
   stubs) comes from the per-framework target hooks. `target.serve` is NOT
   the HMR path — it serves _built_ output (preview parity).
4. Never import a platform package (`@alchemy.run/cloudflare-runtime/vite`,
   `cloudflare-runtime`, a future AWS SDK) from the framework package's core
   modules — only from its target subpath module.

### Harness carriage (`e2e.config.ts`)

The e2e harness carries target configuration target-scoped:

```ts
export default Options.make({
  target: {
    // name: "cloudflare" is the default (the only implemented target today)
    cloudflare: {
      worker: {
        /* CloudflareVitePluginOptions: compat date/flags, name, bindings, assets */
      },
      preview: {
        /* miniflare options for `e2e preview` / Playwright "live" */
      },
    },
  },
  framework: "@alchemy.run/frontend-frameworks/waku",
});
```

The pre-target top-level fields remain as deprecated aliases
(`vite` ≙ `target.cloudflare.worker`, `miniflare` ≙
`target.cloudflare.preview`); `Options.resolveCloudflareOptions(options)` is
the single accessor that merges them (target-scoped wins). Framework packages
that read harness options structurally must read
`options.target?.cloudflare?.worker ?? options.vite`. The harness's miniflare
preview is exposed as the cloudflare target's `serve`
(`packages/cloudflare-test-tools/src/e2e/CloudflareTarget.ts`) — serving built output is the
target's concern; the implementation lives in the harness while miniflare is
a harness dependency.

### Migration recipe per framework

Common steps: add `target?:` to the framework options (default: the package's
`./cloudflare` subpath), create `src/<framework>/cloudflare.ts` + a `./cloudflare` export
map entry, move every cloudflare import out of the core module into it, and
read harness options via the target-scoped carriage above.

- **Waku** — `WakuTarget` extends `DeployTarget` with the adapter-path hook
  (today: the wrangler-free fork at `@alchemy.run/frontend-frameworks/waku/adapter`, selected
  via `unstable_adapter`) and the vite-plugin hook (today:
  `cloudflareVitePlugin(makeWakuPluginOptions(...))` with the pinned
  rsc/ssr topology). `Waku.ts` keeps: config synthesis, the SSG
  preview-server global, the collector, dev/build orchestration.
- **Astro** — `AstroTarget` supplies the integration (today: the
  `@astrojs/cloudflare` fork over our vite plugin, with its server
  entrypoints) injected into `AstroInlineConfig`; `Astro.ts` keeps the
  programmatic `dev()`/`build()` driving and the collector
  (`entryEnvironment: "ssr"`, `skipEnvironments: ["prerender"]`).
- **SvelteKit** — `SvelteKitTarget` supplies the kit `Adapter` instance
  (today: the in-memory cloudflare adapter fork) and implements the generic
  `finish` seam (today: the rolldown re-bundle of `_worker.js` for workerd,
  using `target.bundle` conditions); `SvelteKit.ts` keeps kit config
  synthesis, `buildApp` driving, and the Node-SSR dev server (the dev
  `platform` emulation is a target hook).
- **Next.js** (separate branch; adopts this interface) — the OpenNext
  pipeline is the canonical `target.build` wholesale takeover: the
  cloudflare target owns the OpenNext orchestration, the final bundle pass,
  and dev v1 serving via cloudflare-runtime; the framework package is a thin
  shell that resolves the target and delegates.

### Doctrine (applies to every target implementation)

- **Wrangler-free, programmatic-only.** No `wrangler.json` is read or
  written anywhere; every piece of configuration a wrangler file would carry
  is expressed as in-memory options on the target's `config`. We never spawn
  a framework's CLI binary (upstream pipelines may internally — e.g. OpenNext
  spawning `next build` — but that is upstream orchestration, not ours).
- **Platform-proxy policy.** Wherever an upstream integration reaches for
  wrangler's `getPlatformProxy` (SvelteKit `adapter-cloudflare`, OpenNext
  `initOpenNextCloudflareForDev`, Astro `platformProxy`), the replacement is
  `@alchemy.run/cloudflare-runtime/core/platform-proxy` (workerd-backed
  Node-side proxies for `env`/`cf`/`ctx`/`caches`, configured in-memory) —
  never a wrangler dependency. SvelteKit's `makeDevPlatformEmulator` is the
  first consumer.
- **Version pinning.** Upstream surfaces the integrations touch are
  `@experimental`/`unstable_`/unexported: pin exact framework versions,
  e2e-test against real apps in CI, and treat version bumps as deliberate
  migrations.
