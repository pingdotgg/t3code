import { Schema } from "effect"
import { SchemaBinary } from "effect/encoding"
import assert from "node:assert/strict"
import { Bench } from "tinybench"

const fixtureCount = 256
const rounds = 3

// `Schema.Int` keeps the schema pass around the binary layer; `Schema.Number`
// and the fixed-width schemas skip it, which separates the two effects.
const Int = Schema.Struct({
  version: Schema.Int,
  offset: Schema.Int,
  sequence: Schema.BigInt,
  timestamp: Schema.BigInt
})

const Number_ = Schema.Struct({
  version: Schema.Number,
  offset: Schema.Number,
  sequence: Schema.BigInt,
  timestamp: Schema.BigInt
})

const Fixed = Schema.Struct({
  version: SchemaBinary.uint32,
  offset: SchemaBinary.int32,
  sequence: SchemaBinary.uint64,
  timestamp: SchemaBinary.int64
})

interface Packet {
  readonly version: number
  readonly offset: number
  readonly sequence: bigint
  readonly timestamp: bigint
}

// Deterministic xorshift32, so every run sees the same fixtures.
let seed = 0x9E3779B9
const next32 = (): number => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed >>> 0
}
const next64 = (): bigint => (BigInt(next32()) << BigInt(32)) | BigInt(next32())

const fixtures = {
  small: Array.from({ length: fixtureCount }, (_, i): Packet => ({
    version: i % 4,
    offset: (i % 16) - 8,
    sequence: BigInt(i),
    timestamp: BigInt((i % 32) - 16)
  })),
  "full-range": Array.from({ length: fixtureCount }, (): Packet => ({
    version: next32(),
    offset: next32() | 0,
    sequence: next64(),
    timestamp: BigInt.asIntN(64, next64())
  }))
}

interface Case {
  readonly name: string
  readonly encode: () => unknown
  readonly decode: () => unknown
  readonly bytes: number
  readonly values: number
}

const cases: Array<Case> = []

for (const [fixtureName, packets] of Object.entries(fixtures)) {
  for (const fingerprint of [false, true]) {
    const mode = fingerprint ? "fingerprint" : "default"
    for (const [schemaName, schema] of [["int", Int], ["number", Number_], ["fixed", Fixed]] as const) {
      // One frame per packet.
      const codec = SchemaBinary.toCodec(schema, { fingerprint })
      const encode = Schema.encodeUnknownSync(codec)
      const decode = Schema.decodeUnknownSync(codec)
      const frames = packets.map((packet) => encode(packet).slice())
      frames.forEach((frame, i) => assert.deepStrictEqual(decode(frame), packets[i]))
      cases.push({
        name: `${fixtureName} / ${mode} / frame / ${schemaName}`,
        encode: () => {
          let last: unknown
          for (let i = 0; i < packets.length; i++) last = encode(packets[i])
          return last
        },
        decode: () => {
          let last: unknown
          for (let i = 0; i < frames.length; i++) last = decode(frames[i])
          return last
        },
        bytes: frames.reduce((total, frame) => total + frame.length, 0),
        values: packets.length
      })

      // One frame holding every packet as a row run.
      const arrayCodec = SchemaBinary.toCodec(Schema.Array(schema), { fingerprint })
      const encodeArray = Schema.encodeUnknownSync(arrayCodec)
      const decodeArray = Schema.decodeUnknownSync(arrayCodec)
      const frame = encodeArray(packets).slice()
      assert.deepStrictEqual(decodeArray(frame), packets)
      cases.push({
        name: `${fixtureName} / ${mode} / array / ${schemaName}`,
        encode: () => encodeArray(packets),
        decode: () => decodeArray(frame),
        bytes: frame.length,
        values: packets.length
      })
    }
  }
}

console.log(`${fixtureCount} packets per fixture; frame cases encode each packet as its own frame.`)
console.table(cases.map((c) => ({
  Case: c.name,
  "Total bytes": c.bytes,
  "Bytes / packet": (c.bytes / c.values).toFixed(2)
})))

const sinkSentinel = Symbol("benchmark did not run")
let sink: unknown = sinkSentinel
const throughput = new Map<string, Array<number>>()

// Alternate the registration order each round so neither schema always runs
// first.
for (let round = 0; round < rounds; round++) {
  const bench = new Bench({
    iterations: 500,
    time: 0,
    warmupIterations: 50,
    warmupTime: 0,
    timestampProvider: "hrtimeNow"
  })
  const ordered = round % 2 === 0 ? cases : [...cases].reverse()
  for (const c of ordered) {
    for (const [direction, run] of [["encode", c.encode], ["decode", c.decode]] as const) {
      bench.add(`${c.name} / ${direction}`, () => {
        sink = run()
      })
    }
  }
  await bench.run()
  for (const task of bench.tasks) {
    const result = task.result
    if (result?.state !== "completed") throw new Error(`${task.name}: ${result?.state ?? "missing result"}`)
    const values = cases.find((c) => task.name.startsWith(c.name))!.values
    let samples = throughput.get(task.name)
    if (samples === undefined) throughput.set(task.name, samples = [])
    samples.push(result.throughput.mean * values)
  }
}

if (sink === sinkSentinel) {
  throw new Error("Benchmark did not run")
}

console.log(`Packets per second, mean of ${rounds} rounds (min - max).`)
console.table(
  [...throughput].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, samples]) => ({
    Task: name,
    "Packets/s": Math.round(samples.reduce((a, b) => a + b, 0) / samples.length),
    Range: `${Math.round(Math.min(...samples))} - ${Math.round(Math.max(...samples))}`
  }))
)
