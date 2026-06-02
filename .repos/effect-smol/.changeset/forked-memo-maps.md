---
"effect": patch
"@effect/vitest": patch
---

Add forked memo maps so nested layer scopes can reuse parent allocations without leaking sibling-local layers. Update `@effect/vitest` to fork memo maps for nested `it.layer` suites, isolating sibling setup while preserving parent sharing.
