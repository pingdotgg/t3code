---
"effect": patch
---

Fix `Schema.make` to preserve existing nested `Schema.Class` instances, including in array fields, while recursively constructing plain class inputs provided at runtime inside unions. Constructor defaults remain scoped to structural field and element occurrences, with `SchemaAST.Context.constructorDefault` representing the single default link for each occurrence.

Optimize `Function.memoize` to use a single `WeakMap` lookup for cached values. Its callback no longer accepts `undefined` as a return type because `undefined` represents a cache miss.

The performance of the two array paths can be reproduced by saving the following program as
`scratchpad/schema-make-6890-benchmark.ts` and running `node scratchpad/schema-make-6890-benchmark.ts` from the repository
root:

```ts
import { Schema } from "effect"
import { performance } from "node:perf_hooks"

class Row extends Schema.Class<Row>("Row")({ value: Schema.String }) {}
class DirectTable extends Schema.Class<DirectTable>("DirectTable")({ rows: Schema.Array(Row) }) {}
class UnionTable extends Schema.Class<UnionTable>("UnionTable")({ rows: Schema.Array(Schema.Union([Row])) }) {}

const rows = Array.from({ length: 30_000 }, (_, value) => Row.make({ value: String(value) }))

function benchmark(label: string, make: () => { readonly rows: ReadonlyArray<Row> }) {
  const samples: Array<number> = []
  for (let i = 0; i < 6; i++) {
    const start = performance.now()
    const result = make()
    samples.push(performance.now() - start)
    if (result.rows[0] !== rows[0] || result.rows.at(-1) !== rows.at(-1)) {
      throw new Error(`${label} did not preserve Row identity`)
    }
  }
  console.log(`${label}: ${samples.slice(1).map((n) => n.toFixed(3)).join(", ")} ms`)
}

benchmark("Array(Class)", () => DirectTable.make({ rows }))
benchmark("Array(Union([Class]))", () => UnionTable.make({ rows }))
```

Representative local results on Node 24.12.0 (six runs, with the first discarded):

```text
Array(Class): 0.639, 0.498, 0.447, 0.448, 0.451 ms
Array(Union([Class])): 3.141, 2.195, 2.126, 2.108, 2.057 ms
```
