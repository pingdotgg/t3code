import { type } from "arktype"
import { Schema } from "effect"
import { Bench } from "tinybench"
import * as v from "valibot"
import { z } from "zod/v4-mini"

/*
┌─────────┬──────────────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬──────────┐
│ (index) │ Task name        │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples  │
├─────────┼──────────────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼──────────┤
│ 0       │ 'Schema (good)'  │ '218.06 ± 1.54%' │ '208.00 ± 0.00'  │ '4904782 ± 0.01%'      │ '4807692 ± 0'          │ 4585950  │
│ 1       │ 'Schema (bad)'   │ '362.29 ± 3.26%' │ '292.00 ± 1.00'  │ '3199501 ± 0.01%'      │ '3424658 ± 11769'      │ 2760191  │
│ 2       │ 'Valibot (good)' │ '67.50 ± 3.42%'  │ '42.00 ± 1.00'   │ '18944492 ± 0.02%'     │ '23809524 ± 580720'    │ 14872899 │
│ 3       │ 'Valibot (bad)'  │ '129.11 ± 0.74%' │ '125.00 ± 0.00'  │ '8244804 ± 0.01%'      │ '8000000 ± 0'          │ 7745459  │
│ 4       │ 'Arktype (good)' │ '25.76 ± 6.47%'  │ '41.00 ± 1.00'   │ '30181117 ± 0.01%'     │ '24390244 ± 580720'    │ 38824544 │
│ 5       │ 'Arktype (bad)'  │ '1837.1 ± 2.51%' │ '1750.0 ± 41.00' │ '567189 ± 0.02%'       │ '571429 ± 13393'       │ 544325   │
│ 6       │ 'Zod (good)'     │ '43.74 ± 4.91%'  │ '42.00 ± 0.00'   │ '23500345 ± 0.00%'     │ '23809524 ± 0'         │ 22863784 │
│ 7       │ 'Zod (bad)'      │ '5205.5 ± 0.76%' │ '4958.0 ± 83.00' │ '199317 ± 0.04%'       │ '201694 ± 3360'        │ 192106   │
└─────────┴──────────────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴──────────┘
*/

const bench = new Bench()

const schema = Schema.Array(Schema.String)

const valibot = v.array(v.string())

const arktype = type("string[]")

const zod = z.array(z.string())

const good = ["a", "b"]
const bad = ["a", 1]

const decodeUnknownExit = Schema.decodeUnknownExit(schema)

// console.log(decodeUnknownExit(good))
// console.log(decodeUnknownExit(bad))
// console.log(v.safeParse(valibot, good))
// console.log(v.safeParse(valibot, bad))
// console.log(arktype(good))
// console.log(arktype(bad))
// console.log(zod.safeParse(good))
// console.log(zod.safeParse(bad))

bench
  .add("Schema (good)", function() {
    decodeUnknownExit(good)
  })
  .add("Schema (bad)", function() {
    decodeUnknownExit(bad)
  })
  .add("Valibot (good)", function() {
    v.safeParse(valibot, good)
  })
  .add("Valibot (bad)", function() {
    v.safeParse(valibot, bad)
  })
  .add("Arktype (good)", function() {
    arktype(good)
  })
  .add("Arktype (bad)", function() {
    arktype(bad)
  })
  .add("Zod (good)", function() {
    zod.safeParse(good)
  })
  .add("Zod (bad)", function() {
    zod.safeParse(bad)
  })

await bench.run()

console.table(bench.table())
