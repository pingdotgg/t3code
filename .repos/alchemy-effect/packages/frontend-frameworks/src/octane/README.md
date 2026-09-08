# `@alchemy.run/frontend-frameworks/octane`

Wrangler-free [OctaneJS](https://octanejs.dev) integration implementing the
framework-core `Framework` service, with the deploy target passed as a value
(Cloudflare Workers built in at `./cloudflare`).

Octane wraps Vite, so this integration is deliberately thin: the project's own
`vite build` — with `@octanejs/vite-plugin` in `vite.config.ts` and
`adapter: cloudflare()` (from `@octanejs/adapter-cloudflare`) in
`octane.config.ts` — already produces the deployable output:

- `dist/client` — static assets, served asset-first
- `dist/server/worker.js` — the module Worker entry the adapter emits
  (self-contained ESM; only `node:` externals, so the deployed Worker needs
  the `nodejs_compat` compatibility flag)

`build` drives that pipeline programmatically through the **project's** Vite
install and maps the on-disk `dist` onto the `BuildOutput` contract
(`serverModules` entry-first, `clientDirectory`, sha256 hashes). No adapter
forks, no bundler-plugin injection, no `wrangler.json`.

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
