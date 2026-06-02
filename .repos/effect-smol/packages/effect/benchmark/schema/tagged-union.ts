import { Array as RA, Schema } from "effect"
import { Bench } from "tinybench"

/*
┌─────────┬────────────────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬─────────┐
│ (index) │ Task name          │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples │
├─────────┼────────────────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼─────────┤
│ 0       │ 'Schema (good)'    │ '488.43 ± 0.48%' │ '459.00 ± 1.00'  │ '2119495 ± 0.01%'      │ '2178649 ± 4757'       │ 2047396 │
│ 1       │ 'Schema (bad)'     │ '629.17 ± 0.29%' │ '584.00 ± 1.00'  │ '1645689 ± 0.01%'      │ '1712329 ± 2937'       │ 1589395 │
│ 2       │ 'candidate (good)' │ '327.20 ± 0.27%' │ '292.00 ± 1.00'  │ '3205291 ± 0.01%'      │ '3424658 ± 11769'      │ 3056264 │
│ 3       │ 'candidate (bad)'  │ '449.52 ± 2.41%' │ '417.00 ± 0.00'  │ '2372897 ± 0.01%'      │ '2398082 ± 0'          │ 2224610 │
└─────────┴────────────────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴─────────┘
*/

const bench = new Bench({ time: 1000 })

const n = 100
const f = (i: number) =>
  Schema.Struct({
    kind: Schema.Literal(i),
    a: Schema.String,
    b: Schema.Number,
    c: Schema.Boolean
  })
const members = RA.makeBy(n, f)

const schema = Schema.Union(members)

const candidate = f(n - 1)

const good = {
  kind: n - 1,
  a: "a",
  b: 1,
  c: true
}

const bad = {
  kind: n - 1,
  a: "a",
  b: 1,
  c: "c"
}

const decodeUnknownExit = Schema.decodeUnknownExit(schema)
const decodeUnknownExitCandidate = Schema.decodeUnknownExit(candidate)

// console.log(decodeUnknownExit(good))
// console.log(decodeUnknownExit(bad))
// console.log(decodeUnknownExitCandidate(good))
// console.log(decodeUnknownExitCandidate(bad))

bench
  .add("Schema (good)", function() {
    decodeUnknownExit(good)
  })
  .add("Schema (bad)", function() {
    decodeUnknownExit(bad)
  })
  .add("candidate (good)", function() {
    decodeUnknownExitCandidate(good)
  })
  .add("candidate (bad)", function() {
    decodeUnknownExitCandidate(bad)
  })

await bench.run()

console.table(bench.table())
