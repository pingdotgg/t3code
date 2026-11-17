# Cloudflare Federated API

One URL, one Effect `HttpApi`, four Workers — and no gateway Worker in the request path.

```
api.example.com/products*   → Products  (KV: read catalog)
api.example.com/orders*     → Orders    (KV: read catalog, read/write orders)
api.example.com/admin/*     → Admin     (KV: write catalog)
api.example.com/*           → Home      (custom domain, no bindings)
```

`Home` owns the hostname as a custom domain (DNS record + certificate). The other Workers claim paths with zone routes, which Cloudflare matches before custom domains — so each request goes straight to the Worker that owns its path, and each Worker binds only the access its handlers need.

```ts
export default class Products extends Cloudflare.Worker<Products>()(
  "Products",
  {
    main: import.meta.url,
    routes: [{ pattern: `${HOSTNAME}/products*` }],
  },
  Effect.gen(function* () {
    const catalog = yield* Cloudflare.KV.ReadNamespace(Catalog);
    // ...serve the `products` group of the shared HttpApi
  }),
) {}
```

The API is defined once in `src/Api.ts`. Each Worker serves one group; clients use the combined `StoreApi` against the single URL.

## Dev

```sh
bun alchemy dev
```

`alchemy dev` emulates the zone routes locally: the `url` output (`Home`'s local URL) applies the same routing table, so `http://localhost:<port>/orders` runs the local `Orders` Worker.

## Deploy

Set `API_HOSTNAME` to a hostname in a zone on your Cloudflare account:

```sh
API_HOSTNAME=api.your-domain.com bun alchemy deploy
```
