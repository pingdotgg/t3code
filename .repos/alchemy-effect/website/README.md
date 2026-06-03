# Alchemy Effect Website

This workspace contains the customer-facing docs site for Alchemy Effect.

## Build Pipeline

The site is intentionally split into independent steps:

1. `bun run build:reference` generates Zola-compatible API reference pages from the TypeScript source tree.
2. `bun run build:assets` compiles the shared Tailwind CSS and the custom browser JavaScript bundle.
3. `bun run build:site` renders the site with Zola.
4. `bun run build:search` indexes the built HTML with Pagefind.
5. `alchemy.run.ts` deploys the final `dist/` directory through `Cloudflare.StaticSite(...)`.

This keeps the large markdown corpus on a Rust-first rendering path while still
allowing a modern custom UI.

## Local Commands

- `bun run build`
- `bun run dev:site`
- `bun run deploy`
- `bun run destroy`

## Benchmark Snapshot

Measured locally on 2026-04-02:

- API reference generation: about `2.2s`
- Tailwind + browser bundle build: about `0.9s`
- Zola render: about `0.6s`
- Pagefind indexing: about `0.3s`
- Total built files in `dist/`: `693`
- Total built bytes in `dist/`: `3,120,670`
- Pagefind files: `350`
- Pagefind bytes: `633,383`

These numbers should be treated as a baseline for future changes to the docs
pipeline.
