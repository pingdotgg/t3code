# Persisted state

Minimal save/restore surface: a counter that persists `{count, label}` through
`session.save` and reads it back on reopen through `session.restoreState`.

- `state.ts` is the type reference. `persistedCounterSchema` declares the shape
  once; `RestoreState<typeof schema>` derives the TypeScript type `session.save`
  accepts, and `restoreStateValidator` produces the surface's `validateRestore`.
- Restore is null-only by default and safe: a fresh view gets `null`, a
  reopened view gets the declared shape, and anything else is rejected by the
  host before `createView` runs — the view never sees a save it cannot read.
- `stateVersion` changes are for **changed persisted schemas** — bump it when
  the shape old installs saved would be misread, not for every use of
  persistence.
- Validation errors name the surface, the expected shape, the received value
  and the fix; a surface that receives state without declaring `stateSchema`
  or `validateRestore` is told exactly what to declare.

Build and check with the SDK CLI (`t3-extension build .`, `t3-extension check
.t3-extension`), then run `node --test persistence.test.mjs` — it drives the
built `client.mjs` through the real host: save, close, restore, and the
rejection paths.
