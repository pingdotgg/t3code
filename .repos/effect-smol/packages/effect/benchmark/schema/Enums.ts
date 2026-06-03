import { Schema } from "effect"
import { Bench } from "tinybench"

/*
┌─────────┬───────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬──────────┐
│ (index) │ Task name │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples  │
├─────────┼───────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼──────────┤
│ 0       │ 'good'    │ '79.26 ± 0.73%'  │ '83.00 ± 1.00'   │ '14443802 ± 0.02%'     │ '12048193 ± 143431'    │ 12616336 │
│ 1       │ 'bad'     │ '131.52 ± 0.92%' │ '125.00 ± 0.00'  │ '7976946 ± 0.01%'      │ '8000000 ± 0'          │ 7603261  │
└─────────┴───────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴──────────┘
*/

const bench = new Bench()

enum Enum {
  A = "a",
  B = "b"
}

const schema = Schema.Enum(Enum)

const good = "b"
const bad = "c"

const decodeUnknownExit = Schema.decodeUnknownExit(schema)

// console.log(decodeUnknownExit(valid))
// console.log(decodeUnknownExit(invalid))

bench
  .add("good", function() {
    decodeUnknownExit(good)
  })
  .add("bad", function() {
    decodeUnknownExit(bad)
  })

await bench.run()

console.table(bench.table())
