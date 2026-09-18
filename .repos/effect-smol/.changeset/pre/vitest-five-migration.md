---
"@effect/vitest": patch
"@effect/doctest": patch
---

Require Vitest `>=5.0.0 <6.0.0` and Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`.

### Breaking changes

- Replace `.sequential` and `{ sequential: true }` with `{ concurrent: false }`.
- Use `bench` from the test context and await `bench(name, fn).run()`. The top-level benchmark API is removed.
- Use `Assertion<void, T>` or `Assertion<Promise<void>, T>`. Define custom matchers through `vitest.Matchers`, not `@vitest/expect`.
- Import reporter types from `vitest/node` and environment/snapshot APIs from `vitest/runtime`. Set `outputFile` when consuming JSON reports.
- Await asynchronous assertions. Mock history now clears before each test.

See the [Vitest migration guide](https://vitest.dev/guide/migration/) for removed types and other upstream changes.
