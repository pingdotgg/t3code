import { type } from "arktype"
import { Schema } from "effect"
import { Bench } from "tinybench"
import * as v from "valibot"
import { z } from "zod/v4-mini"

/*
┌─────────┬──────────────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬──────────┐
│ (index) │ Task name        │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples  │
├─────────┼──────────────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼──────────┤
│ 0       │ 'Schema (good)'  │ '186.46 ± 8.13%' │ '167.00 ± 0.00'  │ '5977611 ± 0.01%'      │ '5988024 ± 0'          │ 5363126  │
│ 1       │ 'Schema (bad)'   │ '314.61 ± 4.26%' │ '250.00 ± 0.00'  │ '3722885 ± 0.01%'      │ '4000000 ± 0'          │ 3178549  │
│ 2       │ 'Valibot (good)' │ '56.61 ± 4.79%'  │ '42.00 ± 0.00'   │ '21277611 ± 0.01%'     │ '23809524 ± 1'         │ 17664248 │
│ 3       │ 'Valibot (bad)'  │ '140.10 ± 3.77%' │ '125.00 ± 0.00'  │ '8444864 ± 0.01%'      │ '8000000 ± 0'          │ 7137707  │
│ 4       │ 'Arktype (good)' │ '23.61 ± 0.69%'  │ '41.00 ± 1.00'   │ '32158704 ± 0.01%'     │ '24390244 ± 580720'    │ 42362846 │
│ 5       │ 'Arktype (bad)'  │ '1657.4 ± 3.09%' │ '1583.0 ± 41.00' │ '632160 ± 0.02%'       │ '631712 ± 16796'       │ 603347   │
│ 6       │ 'Zod (good)'     │ '40.67 ± 4.22%'  │ '42.00 ± 0.00'   │ '23805944 ± 0.00%'     │ '23809524 ± 0'         │ 24587718 │
│ 7       │ 'Zod (bad)'      │ '4970.6 ± 1.58%' │ '4791.0 ± 83.00' │ '207106 ± 0.03%'       │ '208725 ± 3635'        │ 201183   │
└─────────┴──────────────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴──────────┘
*/

const bench = new Bench()

const schema = Schema.Struct({
  a: Schema.String
})

const valibot = v.object({
  a: v.string()
})

const arktype = type({
  a: "string"
})

const zod = z.object({
  a: z.string()
})

const good = { a: "a" }
const bad = { a: 1 }

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
