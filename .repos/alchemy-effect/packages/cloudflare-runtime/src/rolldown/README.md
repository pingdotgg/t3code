# `@alchemy.run/cloudflare-runtime/rolldown`

Rolldown plugin for Cloudflare Workers.

## Install

```bash
bun add @alchemy.run/cloudflare-runtime rolldown
```

## Usage

```ts
import { rolldown } from "rolldown";
import cloudflare from "@alchemy.run/cloudflare-runtime/rolldown";

const bundle = await rolldown({
  input: "./src/index.ts",
  plugins: [
    cloudflare({
      compatibilityDate: "2026-04-01",
      compatibilityFlags: ["nodejs_compat"],
    }),
  ],
});

await bundle.write({
  file: "./dist/index.js",
  format: "esm",
  sourcemap: true,
});
```

## What It Does

- Applies Cloudflare-friendly Rolldown defaults for resolution and output targeting.
- Treats supported `cloudflare:*` imports as external.
- Enables Node.js compatibility shims when `nodejs_compat` is set.
- Supports Cloudflare-style additional modules for `.wasm`, `.bin`, `.txt`, `.html`, and `.sql`.
- Supports `.wasm?init` imports.

## Options

- `compatibilityDate?: string`
- `compatibilityFlags?: string[]`

## License

MIT
