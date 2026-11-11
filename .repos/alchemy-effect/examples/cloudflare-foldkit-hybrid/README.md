# cloudflare-foldkit-hybrid

Based on the routed `create-foldkit-app --rendering ssg` scaffold, extended with
request-derived Flags following Foldkit’s SSR example. One application combines
prerendered pages with a request-rendered counter.

| Route | Rendering |
| --- | --- |
| `/` | Prerendered at build time |
| `/about` | Prerendered at build time |
| `/counter?count=7` | Rendered by the Worker with an initial count of 7 |

Open `/counter?count=7` directly and view source: the count is already in the
HTML. Increment it after hydration, then reload to restore the request-derived
value. Client-side navigation remains within the running app; reload a route to
request fresh SSR Flags. Adding a query to `/` or `/about` does not rerender their
static HTML. Unknown pages return 404.

Only `/counter` sets `Cache-Control: private, no-store`. Prerendered routes return
plain `Server.Rendered` results because static HTML cannot preserve custom
response headers.

## Run on Cloudflare

From this directory, after installing the workspace dependencies:

```sh
pnpm dev
pnpm deploy
pnpm destroy
```

`pnpm build` runs the standard Vite build. `pnpm test` runs the credentialed
Cloudflare integration checks and destroys the example afterward.

`alchemy.run.ts` uses `Cloudflare.Website.Foldkit`. The application’s Vite plugin
supplies the build output and routing metadata; no hand-written Worker wrapper
or build identity declaration is required.

## Scaffold source

Application files follow [Foldkit’s generator and examples](https://github.com/foldkit/foldkit/tree/foldkit%400.167.0/packages/create-foldkit-app/templates/rendering/ssg)
(Foldkit 0.167.0 / `create-foldkit-app` 0.39.0). The original files were produced using the
generator’s `createProject` function. Alchemy adds the deployment file, workspace
package configuration and integration tests.

## Rendering examples

- [SPA / CSR](../cloudflare-foldkit-spa): browser-only counter.
- [SSG](../cloudflare-foldkit-ssg): prerendered home and about pages.
- [SSR](../cloudflare-foldkit-ssr): cookie-backed request rendering.
- [Hybrid](../cloudflare-foldkit-hybrid): prerendered pages and a dynamic counter.

SSR/SSG documents follow the 0.167 scaffold: CSS is imported by the client entry,
and the server exports `renderDocument`. There is no source `index.html`.

`src/route.ts` defines the application routers and derives `prerenderPaths` from
them. Both browser navigation and the server use those route definitions.
