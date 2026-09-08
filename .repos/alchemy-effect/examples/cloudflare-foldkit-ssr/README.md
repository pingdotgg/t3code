# cloudflare-foldkit-ssr

A [Foldkit](https://foldkit.dev) app rendered on the server, deployed to Cloudflare with `Cloudflare.Website.Foldkit`.

The sibling [`cloudflare-foldkit`](../cloudflare-foldkit) example is the client-only shape: it ships a template and the browser builds the page. This one renders each request at the edge and the browser adopts that markup, so the document a crawler reads already carries the page.

## What makes it server-rendered

- `src/entry.server.ts` exposes `renderPage(Request)`. It derives Flags from the request, renders through the same `view` the browser uses, and returns the markup plus the document's title.
- `src/worker.ts` reads the built shell from the `ASSETS` binding, places the render into it with `Server.toResponse`, and answers asset misses and refused methods itself.
- `src/entry.ts` calls `Runtime.hydrate` rather than `Runtime.run`, so the client adopts the served DOM instead of rebuilding it.
- `alchemy.run.ts` turns the asset layer's page handling off so page requests actually reach the Worker.

Load `/?count=7` and view source: the count is in the HTML before any JavaScript runs.

## The two settings that matter

```typescript
assets: {
  htmlHandling: "none",
  notFoundHandling: "none",
}
```

Both are load-bearing, and getting either wrong fails quietly — the site serves 200s carrying an empty document.

`notFoundHandling: "none"` lets a request matching no file fall through to the Worker. Left at `"single-page-application"`, the asset layer answers every deep link with the unrendered template and the Worker is never reached.

`htmlHandling: "none"` stops the asset layer resolving `/` to `/index.html` by itself, which would serve the template for the front page alone even after the first setting is right.

Files are still served straight from the asset layer — only page requests reach the Worker.

## The build id

`renderToString` and `Runtime.hydrate` both require a build id, and hydration refuses a page whose id is not the running build's. `vite.config.ts` takes it from `FOLDKIT_BUILD_ID` and falls back to a fresh value, so a local build always has one. A real deployment should pass a value it already has, such as a commit or release tag, and give the client and server builds the same one. It is published in the page, so it must not be a secret.

## A note on `alchemy dev`

The Foldkit Vite plugin has an `ssr: { serverEntry }` option that serves rendered pages from the Vite dev server. This example deliberately does not set it: it loads the entry through `ssrLoadModule`, which needs a runnable `ssr` environment, and under `alchemy dev` that environment belongs to workerd. It is redundant here in any case — requests reach `src/worker.ts`, which renders through the same entry.

## Commands

```sh
bun dev      # alchemy dev
bun deploy   # alchemy deploy
bun destroy  # alchemy destroy
```
