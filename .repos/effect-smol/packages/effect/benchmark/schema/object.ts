import { type } from "arktype"
import { Schema, SchemaParser } from "effect"
import { Bench } from "tinybench"
import * as v from "valibot"
import { z } from "zod/v4-mini"

/*
┌─────────┬──────────────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬──────────┐
│ (index) │ Task name        │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples  │
├─────────┼──────────────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼──────────┤
│ 0       │ 'Schema (good)'  │ '124.63 ± 0.14%' │ '125.00 ± 0.00'  │ '8434862 ± 0.01%'      │ '8000000 ± 0'          │ 8023546  │
│ 1       │ 'Schema (bad)'   │ '203.36 ± 6.27%' │ '208.00 ± 41.00' │ '5319764 ± 0.01%'      │ '4807692 ± 807692'     │ 4917416  │
│ 2       │ 'Valibot (good)' │ '48.91 ± 0.14%'  │ '42.00 ± 0.00'   │ '22152363 ± 0.01%'     │ '23809524 ± 1'         │ 20444356 │
│ 3       │ 'Valibot (bad)'  │ '101.98 ± 0.88%' │ '84.00 ± 1.00'   │ '10439854 ± 0.01%'     │ '11904762 ± 143431'    │ 9806230  │
│ 4       │ 'Arktype (good)' │ '14.57 ± 1.46%'  │ '0.00 ± 0.00'    │ '53567410 ± 0.01%'     │ '68616078 ± 0'         │ 68616080 │
│ 5       │ 'Arktype (bad)'  │ '2001.6 ± 7.05%' │ '1750.0 ± 41.00' │ '554199 ± 0.03%'       │ '571429 ± 13393'       │ 499602   │
│ 6       │ 'Zod (good)'     │ '33.75 ± 6.13%'  │ '41.00 ± 1.00'   │ '25375235 ± 0.00%'     │ '24390240 ± 580716'    │ 29633666 │
│ 7       │ 'Zod (bad)'      │ '5392.2 ± 3.11%' │ '5167.0 ± 42.00' │ '190866 ± 0.03%'       │ '193536 ± 1586'        │ 185454   │
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

const decodeUnknownExit = SchemaParser.decodeUnknownExit(schema)

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
