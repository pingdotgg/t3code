# Large-thread sync optimization

- [x] Add bounded batching for live thread stream items.
- [x] Add regression coverage for ordered, single-publication batches.
- [x] Run focused client-runtime checks and review the diff.
- [ ] Commit the focused sync fix on `perf/large-thread-sync`.

## Review/results

- Client-side batching is implemented in the shared web/mobile runtime.
- Focused sync, reducer, and atom tests pass.
- Targeted typecheck, lint, formatting, and diff checks pass; tsgo reports one unrelated existing suggestion in `src/relay/discovery.ts`.
- Review found no remaining standards issue; server replay/snapshot and per-event reducer costs remain follow-up scope.
