# `@alchemy.run/frontend-frameworks/octane`

Wrangler-free [OctaneJS](https://octanejs.dev) integration implementing the
framework-core `Framework` service, with the deploy target passed as a value
(Cloudflare Workers built in at `./cloudflare`).

Keep the native `octane()` plugin in `vite.config.ts` and application routes
in `octane.config.ts`. Cloudflare builds no longer require
`@octanejs/adapter-cloudflare` or an `adapter` declaration:

```diff
-import { cloudflare } from "@octanejs/adapter-cloudflare";
 import { defineConfig, RenderRoute } from "@octanejs/vite-plugin";

 export default defineConfig({
-  adapter: cloudflare(),
   router: {
     routes: [new RenderRoute({ path: "/", entry: ["App", "/src/App.tsx"] })],
   },
 });
```

Existing Cloudflare adapter declarations remain supported. The native config
is never rewritten, and other native Vite plugins remain active.

Alchemy keeps Octane's client compilation, hydration, and asset metadata,
but replaces its automatic server build with a Worker-targeted Vite build.
Octane's public server-manifest generator supplies the routes and runtime;
Alchemy generates the small `fetch(request, env, ctx)` entry and embeds the
HTML template. The existing source provider isolates builds in a child process
and collects the output:

- `dist/client` — static assets, served asset-first
- `dist/server/worker.js` — the Worker entry; custom Octane `build.outDir`
  values are also supported

The Worker needs `nodejs_compat` for Octane's hashing and asynchronous request
context. No Wrangler configuration is required. The build integration uses
the installed Octane Vite plugin's client-asset helper and production config
facade alongside its public code-generation API; compatibility is covered by
a real adapter-free build regression.

`dev` runs Octane's own Vite dev server (the plugin's dev SSR middleware —
rendering, server routes, and RPC in-process with full HMR).

## Usage

```ts
// e2e.config.ts (the fixture harness)
export default Options.make({
  framework: "@alchemy.run/frontend-frameworks/octane",
  target: {
    cloudflare: {
      worker: { compatibilityDate: "2026-03-10", compatibilityFlags: ["nodejs_compat"] },
    },
  },
});
```

On the alchemy side, `Cloudflare.Website.Octane` uses the
`@alchemy.run/frontend-frameworks/octane/source` subpath (the alchemy Worker source-provider
contract).

## Limitations

- **Dev bindings**: Octane's dev middleware supplies no request-scoped
  `context.platform` (upstream limitation), so Cloudflare bindings are only
  observable in production builds and previews, not in `dev`.
- **SPA apps**: a client-only Octane app (no `octane.config.ts` routes) is a
  plain Vite SPA — deploy it through the plain Vite integration
  (`Cloudflare.Website.Vite`), where the `octane()` compiler plugin composes
  with the injected Cloudflare Vite plugin.
