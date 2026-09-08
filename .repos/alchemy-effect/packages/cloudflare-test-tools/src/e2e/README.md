# @alchemy.run/cloudflare-test-tools/e2e

The e2e harness that drives a fixture's dev server, production build, and
miniflare preview, and exposes them to Playwright. The harness is
framework-pluggable: every fixture is driven through framework-core's
`Framework` service, and a fixture selects its implementation in
`e2e.config.ts`. When no framework is named, the built-in Vite implementation
(over `@alchemy.run/cloudflare-runtime/vite`) is used — existing Vite
fixtures need no changes.

## How a fixture uses the harness

A fixture's `package.json` scripts call the `e2e` bin:

```jsonc
{
  "scripts": {
    "dev": "e2e dev", // Framework.dev — the framework's dev server
    "build": "e2e build", // Framework.build; the harness persists dist/build.json
    "preview": "e2e preview", // miniflare over dist/build.json
    "test": "playwright test",
  },
}
```

`e2e.config.ts` at the fixture root default-exports `Options.make({...})` (or
an `Effect` of it, for config that reads env via `Config`):

```ts
import * as Options from "@alchemy.run/cloudflare-test-tools/e2e/Options";

export default Options.make({
  framework: "@alchemy.run/frontend-frameworks/waku", // ← optional; omit for the Vite default
  target: {
    // name: "cloudflare" is the default (the only implemented target today)
    cloudflare: {
      worker: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        worker: { name: "fixtures-waku", bindings: [], assets: {} },
      },
      preview: {
        compatibilityDate: "2026-03-10",
        compatibilityFlags: ["nodejs_compat"],
        assets: {
          /* router/asset config */
        },
      },
    },
  },
});
```

Config is **target-scoped**: `target.<platform>` carries everything that
platform's deploy target needs, opaque to the rest of the harness (a future
AWS target adds `target.aws` without touching the plumbing). The pre-target
top-level fields remain as deprecated aliases — `vite` ≙
`target.cloudflare.worker`, `miniflare` ≙ `target.cloudflare.preview` — and
`Options.resolveCloudflareOptions(options)` is the single accessor that
merges them (target-scoped wins). Existing fixture configs work unchanged.

Playwright fixtures come from `@alchemy.run/cloudflare-test-tools/e2e/Playwright`:
`Playwright.make("live")` boots the miniflare preview (building first if
`dist/build.json` is absent), `Playwright.make("dev")` boots the framework dev
server. Both dispatch through the `Framework` service.

## The `framework` option

`Options.framework` selects the `Framework`-service implementation. Accepted
forms:

1. **Omitted** — the built-in Vite implementation, configured by
   `options.vite`. Zero behavior change for existing fixtures.
2. **A package specifier string** (e.g. `"@alchemy.run/frontend-frameworks/waku"`) — resolved
   and imported from the **fixture's own `node_modules`** via framework-core's
   `loadProjectModule(cwd, specifier)`, so the fixture's installed copy of the
   framework (its `waku`, `astro`, `next`, ... dependency tree) is the one
   driven — never whatever is hoisted next to the harness. Relative specifiers
   that the fixture's resolution can reach work too.
3. **A factory function** — called with the fixture's full `Options`.
4. **A `Layer<Framework>`** — used as-is. Build it yourself in `e2e.config.ts`
   by importing the framework package directly; this is the fully-typed path
   for framework-specific options that don't fit the shared `Options` shape.

## What a framework package must export

A package named by the string form must **default-export** (or named-export
`framework`) one of:

- a factory `(options: Options) => Layer<Framework>` — the primary contract;
- a factory returning `Effect<Layer<Framework>>` (for effectful setup);
- a `Layer<Framework>` directly (for packages with no per-fixture options).

```ts
// @alchemy.run/frontend-frameworks/waku — src/waku/index.ts
import type { Options } from "@alchemy.run/cloudflare-test-tools/e2e/Options";
import { Framework } from "@alchemy.run/frontend-frameworks/core";
import * as Layer from "effect/Layer";

export default (options: Options): Layer.Layer<Framework> =>
  Layer.effect(Framework /* ... build/dev over waku ... */);
```

### Options flow

The factory receives the **entire** parsed `Options` object from the fixture's
`e2e.config.ts`. Conventions:

- `options.target.cloudflare.worker` (`CloudflareVitePluginOptions`) carries
  the cloudflare worker configuration — compatibility date/flags, worker
  name, bindings, assets behavior. Framework packages should read
  `options.target?.cloudflare?.worker ?? options.vite` (the deprecated
  top-level alias) so fixtures stay uniform.
- `options.target.cloudflare.preview` (alias: `options.miniflare`) is
  consumed by the harness's preview server only; framework packages should
  not read it.
- Anything richer than the shared worker config (framework-specific knobs)
  should be taken via the Layer/factory forms (3)/(4) above, where the
  fixture calls your typed API directly.

### Layer environment

The Layer is built inside the harness runtime, which provides
`@effect/platform-node`'s `NodeServices` (so `FileSystem.FileSystem` and
`Path.Path` may appear in the Layer's requirements — the
`Options.FrameworkServices` type) and a dotenv/env `ConfigProvider`. The
process working directory is the fixture root. Anything else the layer needs,
it must provide itself.

Load the _project's_ framework module (its `vite`, `waku`, `astro`, ...) with
framework-core's `loadProjectModule(root, specifier)` /
`resolveProjectPackageDirectory` — never a bare `import` from your own
dependency tree.

## The `Framework` service contract

Defined in `@alchemy.run/frontend-frameworks/core` (`Framework.ts`):

```ts
class Framework extends Context.Service<
  Framework,
  {
    readonly build: (options?: FrameworkBuildOptions) => Effect<BuildOutput, FrameworkError>;
    readonly dev: (
      options?: FrameworkDevOptions,
    ) => Effect<FrameworkDevServer, FrameworkError, Scope.Scope>; // { url: string }
  }
>()("@alchemy.run/frontend-frameworks/core/Framework") {}
```

Semantics every implementation must honor:

- **`build`** runs the framework's production build and returns the
  `BuildOutput` contract **purely in-memory** — implementations write nothing
  beyond the framework's own build output (no `dist/build.json`; persistence
  is the harness's job, see below). Errors surface as `FrameworkError` (set
  the `framework` field to your framework name).
- **`dev`** starts the framework's dev server and returns `{ url }`. It is
  scoped: closing the `Scope` must stop the server. Honor
  `FrameworkDevOptions.port` when given.
- `FrameworkBuildOptions.root` / `FrameworkDevOptions.root` override the
  project root (default: the configured root / cwd).

### The `dist/build.json` convention (`BuildOutput`)

`dist/build.json` is the **harness's** E2E persistence mechanism, not part of
the `Framework` contract: `e2e build` persists the returned `BuildOutput`
there itself (framework-core's `writeBuildOutput`), and `e2e preview` reads
it back (framework-core's `readBuildOutput`), so preview stays uniform across
frameworks without any framework writing files into user projects.

`BuildOutput` (framework-core `BuildOutput.ts`) is the cross-framework build
contract:

- `clientDirectory` — the static-assets directory, captured **as a path** so
  files written after the bundler finishes (SSG HTML, prerendered pages) ride
  along. `undefined` if there are no client assets.
- `serverModules` — the worker modules as `OutputFile`s (`name` relative to
  `distDirectory`, `content`, sha256 `hash`), **entry module first**
  (`sortServerModules` enforces this ordering). `undefined` for assets-only
  builds.
- `externalWorkspaces` — workspace roots of modules imported from outside the
  project root (for watch/memoization); collect with
  `collectExternalWorkspaces`.
- `distDirectory` — the build's root output directory (e.g. `<root>/dist`).

The harness persists with `writeBuildOutput(path, output)` and reads with
`readBuildOutput(path)` — they handle the JSON round-trip (Buffer revival for
binary modules, `externalWorkspaces` Set). Vite-based frameworks can produce
the whole shape with `makeBuildOutputCollector`; frameworks whose final
bundles land on disk after the bundler (SvelteKit, Next.js) can use
`readServerModulesFromDisk`.

## How the harness consumes the contract

- `e2e build` → `Framework.build()`, then the harness persists the returned
  `BuildOutput` to `<fixture>/dist/build.json` (`Server.buildAndPersist`).
- `e2e dev` (and `Server.dev()` / `Playwright.make("dev")`) →
  `Framework.dev()`; the harness wraps the returned `url` with fetch helpers.
- `e2e preview` (and `Server.live()` / `Playwright.make("live")`) → reads
  `dist/build.json` (framework-core's `readBuildOutput`), falling back to
  `Framework.build()` + persist when it is missing or unreadable; then hands
  the `BuildOutput` to the cloudflare deploy target's `serve`
  (`src/e2e/CloudflareTarget.ts`, a framework-core `DeployTarget` value), which
  boots miniflare (`@alchemy.run/cloudflare-test-tools/miniflare`) with the
  fixture's `target.cloudflare.preview` options. Serving built output is the
  target's concern; the framework implementation is only involved in
  producing a correct `BuildOutput`.
