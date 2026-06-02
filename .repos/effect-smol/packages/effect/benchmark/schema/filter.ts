import { type } from "arktype"
import { Schema } from "effect"
import { Bench } from "tinybench"
import * as v from "valibot"
import { z } from "zod/v4-mini"

/*
┌─────────┬──────────────────┬──────────────────┬──────────────────┬────────────────────────┬────────────────────────┬──────────┐
│ (index) │ Task name        │ Latency avg (ns) │ Latency med (ns) │ Throughput avg (ops/s) │ Throughput med (ops/s) │ Samples  │
├─────────┼──────────────────┼──────────────────┼──────────────────┼────────────────────────┼────────────────────────┼──────────┤
│ 0       │ 'Schema (good)'  │ '129.33 ± 0.60%' │ '125.00 ± 0.00'  │ '8158156 ± 0.01%'      │ '8000000 ± 0'          │ 7732112  │
│ 1       │ 'Schema (bad)'   │ '239.58 ± 1.44%' │ '209.00 ± 1.00'  │ '4413764 ± 0.01%'      │ '4784689 ± 23003'      │ 4174352  │
│ 2       │ 'Valibot (good)' │ '49.81 ± 1.01%'  │ '42.00 ± 0.00'   │ '22751446 ± 0.01%'     │ '23809524 ± 1'         │ 20075175 │
│ 3       │ 'Valibot (bad)'  │ '70.52 ± 1.11%'  │ '83.00 ± 1.00'   │ '16762925 ± 0.02%'     │ '12048193 ± 143431'    │ 14179523 │
│ 4       │ 'Arktype (good)' │ '23.37 ± 0.14%'  │ '41.00 ± 1.00'   │ '32327042 ± 0.01%'     │ '24390244 ± 580720'    │ 42787691 │
│ 5       │ 'Arktype (bad)'  │ '1361.2 ± 2.65%' │ '1333.0 ± 41.00' │ '757323 ± 0.01%'       │ '750188 ± 23806'       │ 734659   │
│ 6       │ 'Zod (good)'     │ '44.10 ± 0.72%'  │ '42.00 ± 0.00'   │ '23479006 ± 0.00%'     │ '23809524 ± 0'         │ 22674716 │
│ 7       │ 'Zod (bad)'      │ '5005.9 ± 1.50%' │ '4834.0 ± 83.00' │ '204249 ± 0.03%'       │ '206868 ± 3492'        │ 199767   │
└─────────┴──────────────────┴──────────────────┴──────────────────┴────────────────────────┴────────────────────────┴──────────┘
*/

const bench = new Bench()

const schema = Schema.String.check(Schema.isNonEmpty())

const valibot = v.pipe(v.string(), v.nonEmpty())

const arktype = type("string > 0")

const zod = z.string().check(z.minLength(1))

const good = "a"
const bad = ""

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
