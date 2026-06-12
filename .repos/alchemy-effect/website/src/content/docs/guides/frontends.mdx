---
title: Frontend frameworks
description: Deploy Vite-based frameworks (TanStack Start, Astro, SolidStart, Nuxt, React) and any custom-built static site (Hugo, Eleventy) to Cloudflare with one declaration.
sidebar:
  order: 5
---

`Cloudflare.Vite` covers TanStack Start, Astro, SolidStart, Nuxt, and
plain React. `Cloudflare.StaticSite` wraps any custom build pipeline
— Hugo, Eleventy, mdBook, Jekyll. One declaration. Alchemy builds
and deploys to Cloudflare.

## Vite-based frameworks

`Cloudflare.Vite` uses Cloudflare's Vite plugin to build the server
bundle and client assets in one `vite build`. No manual entrypoint,
no Wrangler config, no asset directory plumbing. Inputs are
content-hashed so unchanged projects skip the build entirely.

**TanStack Start (SSR)**

```typescript
import * as Cloudflare from "alchemy/Cloudflare";

export const App = Cloudflare.Vite("App", {
  compatibility: { flags: ["nodejs_compat"] },
});
```

**Astro**

```typescript
import * as Cloudflare from "alchemy/Cloudflare";

// Astro builds via Vite — one declaration, static or SSR.
export const Site = Cloudflare.Vite("Site");
```

**React + Vite**

```typescript
import * as Cloudflare from "alchemy/Cloudflare";

export const App = Cloudflare.Vite("App");
```

- **SSR with `nodejs_compat`** — For frameworks that need Node APIs
  at runtime (TanStack Start, SolidStart, Nuxt), enable
  `nodejs_compat` in one line.
- **Static — also one line** — Pure SPA or static site? Drop the
  `compatibility` option. The Worker just serves the built assets.
- **Content-hashed builds** — Every input file is hashed (respecting
  `.gitignore` by default). Unchanged projects skip both build and
  deploy.

## Static sites with any build pipeline

For everything Vite doesn't build, `Cloudflare.StaticSite` runs a
shell command, hashes the output directory, and deploys the result
as a Worker with static assets:

```typescript
import * as Cloudflare from "alchemy/Cloudflare";

// Any custom build pipeline — point command at the script,
// outdir at the output directory.
export const Blog = Cloudflare.StaticSite("Blog", {
  command: "hugo --minify",
  outdir: "public",
});
```

Hugo, Eleventy, mdBook, Jekyll — anything that produces a directory
of files.

## Bind backend resources from your SSR Worker

The Worker that powers your SSR app can bind to R2, KV, D1,
DynamoDB — anything you've declared elsewhere in the stack. Server
functions and loaders read a typed `env` with no extra wiring.

```typescript
// Frontend Workers can bind to backend resources.
import { Bucket } from "./Bucket.ts";
import { DB } from "./DB.ts";

export const App = Cloudflare.Vite("App", {
  env: { Bucket, DB },
});

// In your SSR loader / server function:
//   env.Bucket.get(key)   // typed via Cloudflare.InferEnv
//   env.DB.prepare(sql)
```
