# cloudflare-foldkit-ssr

The cookie-backed counter scaffold from `create-foldkit-app --rendering ssr`.
Foldkit renders each page request in a Cloudflare Worker. Its Flags contain the
count from the request cookie and the render timestamp. `Runtime.hydrate` adopts
that HTML, and clicking a counter button persists the new count in the browser
cookie. Reloading demonstrates that the Worker renders the persisted count.

Responses use `Cache-Control: private, no-store` and `Vary: cookie`. There are no
prerendered pages in this example.

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

Application files follow [Foldkit’s generator and examples](https://github.com/foldkit/foldkit/tree/foldkit%400.167.0/packages/create-foldkit-app/templates/rendering/ssr)
(Foldkit 0.167.0 / `create-foldkit-app` 0.39.0). The original files were produced using the
generator’s `createProject` function. Alchemy adds the deployment file, workspace
package configuration and integration tests. The SSR cookie helper uses the HTTP
module path from this workspace’s Effect version.

## Rendering examples

- [SPA / CSR](../cloudflare-foldkit-spa): browser-only counter.
- [SSG](../cloudflare-foldkit-ssg): prerendered home and about pages.
- [SSR](../cloudflare-foldkit-ssr): cookie-backed request rendering.
- [Hybrid](../cloudflare-foldkit-hybrid): prerendered pages and a dynamic counter.

SSR/SSG documents follow the 0.167 scaffold: CSS is imported by the client entry,
and the server exports `renderDocument`. There is no source `index.html`.
