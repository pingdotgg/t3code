# @distilled.cloud/vendor-workflows-shared

Private workspace package vendoring raw TypeScript source from
[`@cloudflare/workflows-shared`](https://github.com/cloudflare/workers-sdk/tree/b7b4ff84477982e7c770bb93928287893fcf2e03/packages/workflows-shared).
This package does not bundle or publish; consumer packages in this monorepo
import the `.ts` files directly and apply their own bundling.

The upstream source and tests are co-located under
`src/internal/workflows-shared/`. Deliberate behavioral differences from
upstream are documented with `Alchemy modifications:` comments in the affected
files. Project metadata and imports are adapted to this monorepo's tooling.

## Provenance

Sourced from [`cloudflare/workers-sdk`](https://github.com/cloudflare/workers-sdk)
at commit [`b7b4ff84477982e7c770bb93928287893fcf2e03`](https://github.com/cloudflare/workers-sdk/commit/b7b4ff84477982e7c770bb93928287893fcf2e03) (path:
`packages/workflows-shared`). Upstream license: MIT OR Apache-2.0.

## Consumer imports

```ts
// Worker entrypoints (Engine DO + WorkflowBinding entrypoint)
import {
  Engine,
  WorkflowBinding,
} from "@distilled.cloud/vendor-workflows-shared/local-binding-worker";

// Type-only imports of individual modules
import type { Engine } from "@distilled.cloud/vendor-workflows-shared/src/engine";
```
