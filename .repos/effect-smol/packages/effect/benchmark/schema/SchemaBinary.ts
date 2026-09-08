import { Effect, Schema, Stream } from "effect"
import { Msgpack, Ndjson, SchemaBinary } from "effect/unstable/encoding"
import { isNativeAccelerationEnabled, pack, Packr, unpack, Unpackr } from "msgpackr"
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { readFileSync } from "node:fs"
import { gzipSync, zstdCompressSync } from "node:zlib"
import protobuf, { type Message, type Type } from "protobufjs"
import { Bench } from "tinybench"

const streamBatchSize = 32
const repeatedRecordStreamSize = 200

const SmallRecord = Schema.Struct({
  id: Schema.Number,
  active: Schema.Boolean,
  score: Schema.Number,
  retryCount: Schema.Number,
  region: Schema.String,
  verified: Schema.Boolean
})

const LineItem = Schema.Struct({
  sku: Schema.String,
  quantity: Schema.Number,
  unitPrice: Schema.Number
})

const NestedPayload = Schema.Struct({
  orderId: Schema.String,
  customer: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String
  }),
  shipping: Schema.Struct({
    street: Schema.String,
    city: Schema.String,
    postalCode: Schema.String,
    country: Schema.String
  }),
  lines: Schema.Array(LineItem),
  metadata: Schema.Struct({
    source: Schema.String,
    campaign: Schema.String,
    priority: Schema.Boolean
  })
})

const Collections = Schema.Struct({
  tags: Schema.Array(Schema.String),
  metrics: Schema.Record(Schema.String, Schema.Number),
  samples: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number, Schema.Boolean])),
  buckets: Schema.Array(Schema.Array(Schema.Number))
})

const LargeRow = Schema.Struct({
  transactionIdentifier: Schema.String,
  customerIdentifier: Schema.String,
  productDescription: Schema.String,
  fulfillmentLocation: Schema.String,
  quantityPurchased: Schema.Number,
  unitPriceInCents: Schema.Number,
  discountInBasisPoints: Schema.Number,
  requiresManualReview: Schema.Boolean
})

const LargePayload = Schema.Array(LargeRow)

const largeRows = Array.from({ length: repeatedRecordStreamSize }, (_, index) => ({
  transactionIdentifier: `transaction-${index.toString().padStart(4, "0")}`,
  customerIdentifier: `customer-${index % 37}`,
  productDescription: `Product ${index % 19} with a repeated descriptive field value`,
  fulfillmentLocation: ["London", "New York", "Singapore", "Sydney"][index % 4]!,
  quantityPurchased: index % 9 + 1,
  unitPriceInCents: 500 + index % 73 * 25,
  discountInBasisPoints: index % 5 * 125,
  requiresManualReview: index % 17 === 0
}))

const metrics = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`metric-${index}`, index * 1.25]))

type InferredNode =
  | { readonly _tag: "never" }
  | { readonly _tag: "null" | "string" | "number" | "boolean" }
  | { readonly _tag: "array"; readonly element: InferredNode }
  | {
    readonly _tag: "object"
    readonly count: number
    readonly fields: ReadonlyMap<string, { readonly seen: number; readonly node: InferredNode }>
  }
  | { readonly _tag: "union"; readonly members: ReadonlyMap<InferredNode["_tag"], InferredNode> }

const inferredNever: InferredNode = { _tag: "never" }

const inferredMembers = (node: InferredNode): ReadonlyMap<InferredNode["_tag"], InferredNode> =>
  node._tag === "union" ? node.members : new Map([[node._tag, node]])

const mergeInferred = (left: InferredNode, right: InferredNode): InferredNode => {
  if (left._tag === "never") return right
  if (right._tag === "never") return left
  if (left._tag === right._tag) {
    if (left._tag === "array" && right._tag === "array") {
      return { _tag: "array", element: mergeInferred(left.element, right.element) }
    }
    if (left._tag === "object" && right._tag === "object") {
      const fields = new Map(left.fields)
      for (const [key, field] of right.fields) {
        const previous = fields.get(key)
        fields.set(
          key,
          previous === undefined
            ? field
            : { seen: previous.seen + field.seen, node: mergeInferred(previous.node, field.node) }
        )
      }
      return { _tag: "object", count: left.count + right.count, fields }
    }
    if (left._tag === "union" && right._tag === "union") {
      const members = new Map(left.members)
      for (const [tag, member] of right.members) {
        members.set(tag, members.has(tag) ? mergeInferred(members.get(tag)!, member) : member)
      }
      return { _tag: "union", members }
    }
    return left
  }
  const members = new Map(inferredMembers(left))
  for (const [tag, member] of inferredMembers(right)) {
    members.set(tag, members.has(tag) ? mergeInferred(members.get(tag)!, member) : member)
  }
  return { _tag: "union", members }
}

const inferNode = (value: unknown): InferredNode => {
  if (value === null) return { _tag: "null" }
  if (typeof value === "string") return { _tag: "string" }
  if (typeof value === "number") return { _tag: "number" }
  if (typeof value === "boolean") return { _tag: "boolean" }
  if (Array.isArray(value)) {
    return { _tag: "array", element: value.reduce((node, item) => mergeInferred(node, inferNode(item)), inferredNever) }
  }
  if (typeof value === "object") {
    return {
      _tag: "object",
      count: 1,
      fields: new Map(Object.entries(value).map(([key, field]) => [key, { seen: 1, node: inferNode(field) }]))
    }
  }
  throw new Error(`Cannot infer a benchmark schema for ${typeof value}`)
}

const inferredSchema = (node: InferredNode): Schema.ConstraintCodec<unknown, unknown> => {
  switch (node._tag) {
    case "never":
      return Schema.Never
    case "null":
      return Schema.Null
    case "string":
      return Schema.String
    case "number":
      return Schema.Number
    case "boolean":
      return Schema.Boolean
    case "array":
      return Schema.Array(inferredSchema(node.element))
    case "union":
      return Schema.Union(Array.from(node.members.values(), inferredSchema))
    case "object":
      return Schema.Struct(Object.fromEntries(Array.from(node.fields, ([key, field]) => [
        key,
        field.seen === node.count
          ? inferredSchema(field.node)
          : Schema.optionalKey(inferredSchema(field.node))
      ])))
  }
}

// From msgpackr's benchmark corpus at e3c852d: https://github.com/kriszyp/msgpackr/blob/e3c852df383059b9ea8a8d3e5517d6e5527bf756/tests/example4.json
const msgpackrClinicalValue: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/msgpackr-example4.json", import.meta.url), "utf8")
)
const MsgpackrClinical = inferredSchema(inferNode(msgpackrClinicalValue))

const protobufRoot = protobuf.parse(`
  syntax = "proto3";

  message SmallRecord {
    double id = 1;
    bool active = 2;
    double score = 3;
    double retryCount = 4;
    string region = 5;
    bool verified = 6;
  }

  message LineItem {
    string sku = 1;
    double quantity = 2;
    double unitPrice = 3;
  }

  message Customer {
    string id = 1;
    string name = 2;
    string email = 3;
  }

  message Shipping {
    string street = 1;
    string city = 2;
    string postalCode = 3;
    string country = 4;
  }

  message Metadata {
    string source = 1;
    string campaign = 2;
    bool priority = 3;
  }

  message NestedPayload {
    string orderId = 1;
    Customer customer = 2;
    Shipping shipping = 3;
    repeated LineItem lines = 4;
    Metadata metadata = 5;
  }

  message Sample {
    double first = 1;
    double second = 2;
    bool third = 3;
  }

  message Bucket {
    repeated double values = 1;
  }

  message Collections {
    repeated string tags = 1;
    map<string, double> metrics = 2;
    repeated Sample samples = 3;
    repeated Bucket buckets = 4;
  }

  message NumberMap {
    map<string, double> values = 1;
  }

  message LargeRow {
    string transactionIdentifier = 1;
    string customerIdentifier = 2;
    string productDescription = 3;
    string fulfillmentLocation = 4;
    double quantityPurchased = 5;
    double unitPriceInCents = 6;
    double discountInBasisPoints = 7;
    bool requiresManualReview = 8;
  }

  message LargePayload {
    repeated LargeRow values = 1;
  }
`).root

interface ProtobufFixture {
  readonly type: Type
  readonly encodeInput: (value: unknown) => object
  readonly decodeOutput: (message: Message) => unknown
}

const protobufObject = <T extends object>(type: Type, message: Message): T =>
  type.toObject(message, { arrays: true, defaults: true, objects: true }) as T

const directProtobufFixture = (name: string): ProtobufFixture => {
  const type = protobufRoot.lookupType(name)
  return {
    type,
    encodeInput: (value) => value as object,
    decodeOutput: (message) => protobufObject(type, message)
  }
}

const collectionsProtobufType = protobufRoot.lookupType("Collections")
const numberMapProtobufType = protobufRoot.lookupType("NumberMap")
const largePayloadProtobufType = protobufRoot.lookupType("LargePayload")

const collectionsProtobufFixture: ProtobufFixture = {
  type: collectionsProtobufType,
  encodeInput: (value) => {
    const collections = value as (typeof Collections)["Type"]
    return {
      tags: collections.tags,
      metrics: collections.metrics,
      samples: collections.samples.map(([first, second, third]) => ({ first, second, third })),
      buckets: collections.buckets.map((values) => ({ values }))
    }
  },
  decodeOutput: (message) => {
    const collections = protobufObject<{
      readonly tags: ReadonlyArray<string>
      readonly metrics: Readonly<Record<string, number>>
      readonly samples: ReadonlyArray<{ readonly first: number; readonly second: number; readonly third: boolean }>
      readonly buckets: ReadonlyArray<{ readonly values: ReadonlyArray<number> }>
    }>(collectionsProtobufType, message)
    return {
      tags: collections.tags,
      metrics: collections.metrics,
      samples: collections.samples.map((sample) => [sample.first, sample.second, sample.third]),
      buckets: collections.buckets.map((bucket) => bucket.values)
    }
  }
}

const numberMapProtobufFixture: ProtobufFixture = {
  type: numberMapProtobufType,
  encodeInput: (value) => ({ values: value }),
  decodeOutput: (message) =>
    protobufObject<{ readonly values: Readonly<Record<string, number>> }>(numberMapProtobufType, message).values
}

const largePayloadProtobufFixture: ProtobufFixture = {
  type: largePayloadProtobufType,
  encodeInput: (value) => ({ values: value }),
  decodeOutput: (message) =>
    protobufObject<{ readonly values: ReadonlyArray<(typeof LargeRow)["Type"]> }>(largePayloadProtobufType, message)
      .values
}

const largeRowProtobufFixture = directProtobufFixture("LargeRow")

const cases = [
  {
    name: "small record",
    schema: SmallRecord,
    value: {
      id: 42,
      active: true,
      score: 98.5,
      retryCount: 2,
      region: "eu-west-1",
      verified: false
    },
    protobuf: directProtobufFixture("SmallRecord")
  },
  {
    name: "nested payload",
    schema: NestedPayload,
    value: {
      orderId: "order-2026-000184",
      customer: {
        id: "customer-91",
        name: "Ada Lovelace",
        email: "ada@example.com"
      },
      shipping: {
        street: "12 Analytical Engine Way",
        city: "London",
        postalCode: "SW1A 1AA",
        country: "GB"
      },
      lines: [
        { sku: "widget-blue", quantity: 2, unitPrice: 12.5 },
        { sku: "adapter-pro", quantity: 1, unitPrice: 48 },
        { sku: "cable-2m", quantity: 3, unitPrice: 8.25 }
      ],
      metadata: {
        source: "partner-api",
        campaign: "summer-2026",
        priority: true
      }
    },
    protobuf: directProtobufFixture("NestedPayload")
  },
  {
    name: "collections",
    schema: Collections,
    value: {
      tags: Array.from({ length: 24 }, (_, index) => `tag-${index}`),
      metrics: Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`metric-${index}`, index * 1.25])),
      samples: Array.from({ length: 48 }, (_, index) => [index, index / 10, index % 3 === 0] as const),
      buckets: Array.from({ length: 8 }, (_, bucket) => Array.from({ length: 16 }, (_, index) => bucket * 100 + index))
    },
    protobuf: collectionsProtobufFixture
  },
  {
    name: "index signatures / 128 keys",
    schema: Schema.Record(Schema.String, Schema.Number),
    value: metrics(128),
    protobuf: numberMapProtobufFixture
  },
  {
    name: "index signatures / 512 keys",
    schema: Schema.Record(Schema.String, Schema.Number),
    value: metrics(512),
    protobuf: numberMapProtobufFixture
  },
  {
    name: "200-row array payload",
    schema: LargePayload,
    value: largeRows,
    protobuf: largePayloadProtobufFixture
  }
] as const

const rawCases = [
  {
    name: "small record / raw serializers",
    schema: SmallRecord,
    value: cases[0].value
  },
  {
    name: "msgpackr clinical fixture / raw serializers",
    schema: MsgpackrClinical,
    value: msgpackrClinicalValue
  }
] as const

interface Format {
  readonly name: string
  readonly encodedSize: number
  readonly gzipSize: number
  readonly zstdSize: number
  readonly encode: () => unknown
  readonly decode: () => unknown
}

interface StreamFormat {
  readonly name: string
  readonly framesPerOp: number
  readonly decode: () => ReadonlyArray<unknown> | Promise<ReadonlyArray<unknown>>
}

interface StreamSize {
  readonly name: string
  readonly frames: number
  readonly encodedSize: number
  readonly gzipSize: number
  readonly zstdSize: number
}

const textEncoder = new TextEncoder()

const concatFrames = (frames: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(frames.reduce((length, frame) => length + frame.length, 0))
  let offset = 0
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

const sizes = (encoded: Uint8Array): Pick<Format, "encodedSize" | "gzipSize" | "zstdSize"> => ({
  encodedSize: encoded.length,
  gzipSize: gzipSync(encoded).length,
  zstdSize: zstdCompressSync(encoded).length
})

const prepare = <S extends Schema.ConstraintCodec<unknown, unknown>>(
  schema: S,
  value: S["Type"],
  protobufFixture: ProtobufFixture
): {
  readonly formats: ReadonlyArray<Format>
} => {
  const jsonSchema = Schema.toCodecJson(schema)
  const binaryCodec = SchemaBinary.toCodec(schema)
  const fingerprintCodec = SchemaBinary.toCodec(schema, { fingerprint: true })
  const jsonCodec = Schema.fromJsonString(jsonSchema)
  const msgpackCodec = Msgpack.schema(jsonSchema)

  const binaryEncode = Schema.encodeUnknownSync(binaryCodec)
  const binaryDecode = Schema.decodeUnknownSync(binaryCodec)
  const fingerprintEncode = Schema.encodeUnknownSync(fingerprintCodec)
  const fingerprintDecode = Schema.decodeUnknownSync(fingerprintCodec)
  const jsonEncode = Schema.encodeUnknownSync(jsonCodec)
  const jsonDecode = Schema.decodeUnknownSync(jsonCodec)
  const msgpackEncode = Schema.encodeUnknownSync(msgpackCodec)
  const msgpackDecode = Schema.decodeUnknownSync(msgpackCodec)
  const protobufValue = protobufFixture.encodeInput(value)

  const binary = binaryEncode(value)
  const fingerprint = fingerprintEncode(value).slice()
  const json = jsonEncode(value)
  const jsonBytes = textEncoder.encode(json)
  const msgpack = msgpackEncode(value)
  const protobufBytes = protobufFixture.type.encode(protobufValue).finish()
  const protobufDecode = () => protobufFixture.decodeOutput(protobufFixture.type.decode(protobufBytes))

  assert.deepStrictEqual(binaryDecode(binary), value)
  assert.deepStrictEqual(fingerprintDecode(fingerprint), value)
  assert.deepStrictEqual(jsonDecode(json), value)
  assert.deepStrictEqual(msgpackDecode(msgpack), value)
  assert.deepStrictEqual(protobufDecode(), value)

  return {
    formats: [
      {
        name: "SchemaBinary",
        ...sizes(binary),
        encode: () => binaryEncode(value),
        decode: () => binaryDecode(binary)
      },
      {
        name: "SchemaBinary fingerprint",
        ...sizes(fingerprint),
        encode: () => fingerprintEncode(value),
        decode: () => fingerprintDecode(fingerprint)
      },
      {
        name: "JSON",
        ...sizes(jsonBytes),
        encode: () => jsonEncode(value),
        decode: () => jsonDecode(json)
      },
      {
        name: "Msgpack",
        ...sizes(msgpack),
        encode: () => msgpackEncode(value),
        decode: () => msgpackDecode(msgpack)
      },
      {
        name: "Protobuf",
        ...sizes(protobufBytes),
        encode: () => protobufFixture.type.encode(protobufValue).finish(),
        decode: protobufDecode
      }
    ]
  }
}

const prepareRaw = <S extends Schema.ConstraintCodec<unknown, unknown>>(
  schema: S,
  value: S["Type"]
): { readonly formats: ReadonlyArray<Format> } => {
  const binaryCodec = SchemaBinary.toCodec(schema)
  const fingerprintCodec = SchemaBinary.toCodec(schema, { fingerprint: true })
  const msgpackCodec = Msgpack.schema(Schema.toCodecJson(schema))
  const binaryEncode = Schema.encodeUnknownSync(binaryCodec)
  const binaryDecode = Schema.decodeUnknownSync(binaryCodec)
  const fingerprintEncode = Schema.encodeUnknownSync(fingerprintCodec)
  const fingerprintDecode = Schema.decodeUnknownSync(fingerprintCodec)
  const msgpackEncode = Schema.encodeUnknownSync(msgpackCodec)
  const msgpackDecode = Schema.decodeUnknownSync(msgpackCodec)
  const sharedPackr = new Packr({ structures: [] })

  sharedPackr.pack(value)
  const binary = binaryEncode(value).slice()
  const fingerprint = fingerprintEncode(value).slice()
  const effectMsgpack = msgpackEncode(value)
  const sharedMsgpack = sharedPackr.pack(value).slice()
  const plainMsgpack = pack(value).slice()
  const json = Buffer.from(JSON.stringify(value))

  assert.deepStrictEqual(binaryDecode(binary), value)
  assert.deepStrictEqual(fingerprintDecode(fingerprint), value)
  assert.deepStrictEqual(msgpackDecode(effectMsgpack), value)
  assert.deepStrictEqual(sharedPackr.unpack(sharedMsgpack), value)
  assert.deepStrictEqual(unpack(plainMsgpack), value)
  assert.deepStrictEqual(JSON.parse(json.toString()), value)

  return {
    formats: [
      {
        name: "SchemaBinary",
        ...sizes(binary),
        encode: () => binaryEncode(value),
        decode: () => binaryDecode(binary)
      },
      {
        name: "SchemaBinary fingerprint",
        ...sizes(fingerprint),
        encode: () => fingerprintEncode(value),
        decode: () => fingerprintDecode(fingerprint)
      },
      {
        name: "Effect Msgpack schema",
        ...sizes(effectMsgpack),
        encode: () => msgpackEncode(value),
        decode: () => msgpackDecode(effectMsgpack)
      },
      {
        name: "msgpackr raw / shared structures",
        ...sizes(sharedMsgpack),
        encode: () => sharedPackr.pack(value),
        decode: () => sharedPackr.unpack(sharedMsgpack)
      },
      {
        name: "msgpackr raw / plain",
        ...sizes(plainMsgpack),
        encode: () => pack(value),
        decode: () => unpack(plainMsgpack)
      },
      {
        name: "JSON raw",
        ...sizes(json),
        encode: () => Buffer.from(JSON.stringify(value)),
        decode: () => JSON.parse(json.toString())
      }
    ]
  }
}

const prepared = cases.map((testCase) => ({
  name: testCase.name,
  ...prepare(testCase.schema, testCase.value, testCase.protobuf)
}))

const preparedRaw = rawCases.map((testCase) => ({
  name: testCase.name,
  ...prepareRaw(testCase.schema, testCase.value)
}))

const prepareStream = async <S extends Schema.ConstraintCodec<unknown, unknown>>(
  schema: S,
  values: ReadonlyArray<S["Type"]>,
  protobufFixture: ProtobufFixture
): Promise<{ readonly formats: ReadonlyArray<StreamFormat>; readonly sizes: ReadonlyArray<StreamSize> }> => {
  const binaryCodec = SchemaBinary.toCodec(schema)
  const binaryEncode = Schema.encodeUnknownSync(binaryCodec)
  const binaryFrames = values.map((value) => binaryEncode(value).slice())
  const binaryStream = concatFrames(binaryFrames)
  const binaryFragments = binaryFrames.map((frame) => {
    return [frame.subarray(0, 1), frame.subarray(1)] as const
  })

  const fingerprintEncode = Schema.encodeUnknownSync(SchemaBinary.toCodec(schema, { fingerprint: true }))
  const fingerprintFrames = values.map((value) => fingerprintEncode(value).slice())
  const fingerprintStream = concatFrames(fingerprintFrames)
  const fingerprintFragments = fingerprintFrames.map((frame) => {
    return [frame.subarray(0, 1), frame.subarray(1)] as const
  })

  const jsonSchema = Schema.toCodecJson(schema)
  const encodeMsgpackValue = Schema.encodeUnknownSync(jsonSchema)
  const decodeMsgpackValue = Schema.decodeUnknownSync(jsonSchema)
  const msgpackPackr = new Packr()
  const msgpackStream = concatFrames(values.map((value) => msgpackPackr.pack(encodeMsgpackValue(value)).slice()))
  const msgpackUnpackr = new Unpackr()

  const protobufFrames = values.map((value) =>
    protobufFixture.type.encodeDelimited(protobufFixture.encodeInput(value)).finish()
  )
  const protobufStream = concatFrames(protobufFrames)
  const decodeProtobufStream = () => {
    const reader = protobuf.Reader.create(protobufStream)
    const decoded: Array<unknown> = []
    while (reader.pos < reader.len) {
      decoded.push(protobufFixture.decodeOutput(protobufFixture.type.decodeDelimited(reader)))
    }
    return decoded
  }

  const ndjsonFrames = values.map((value) => textEncoder.encode(`${JSON.stringify(encodeMsgpackValue(value))}\n`))
  const ndjsonStream = concatFrames(ndjsonFrames)
  const ndjsonFragments = ndjsonFrames.map((frame) => {
    return [frame.subarray(0, 1), frame.subarray(1)] as const
  })
  const ndjsonDecoder = Ndjson.decodeSchema(jsonSchema)()
  const runNdjson = (chunks: ReadonlyArray<Uint8Array>) =>
    Effect.runPromise(
      Stream.fromIterable(chunks).pipe(
        Stream.pipeThroughChannel(ndjsonDecoder),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk))
      )
    )
  let ndjsonSingleIndex = 0
  let ndjsonFragmentedIndex = 0
  const decodeNdjsonSingle = () => runNdjson([ndjsonFrames[ndjsonSingleIndex++ % ndjsonFrames.length]!])
  const decodeNdjsonBatch = () => runNdjson([ndjsonStream])
  const decodeNdjsonFragmented = () => runNdjson(ndjsonFragments[ndjsonFragmentedIndex++ % ndjsonFragments.length]!)

  const feedShapes = (options?: { readonly fingerprint: true }) => {
    const frames = options === undefined ? binaryFrames : fingerprintFrames
    const fragments = options === undefined ? binaryFragments : fingerprintFragments
    const stream = options === undefined ? binaryStream : fingerprintStream
    const singleParser = SchemaBinary.parser(schema, options)
    const fragmentedParser = SchemaBinary.parser(schema, options)
    const batchParser = SchemaBinary.parser(schema, options)
    let singleIndex = 0
    let fragmentedIndex = 0
    return {
      single: () => singleParser.feedSync(frames[singleIndex++ % frames.length]),
      fragmented: () => {
        const pair = fragments[fragmentedIndex++ % fragments.length]
        const first = fragmentedParser.feedSync(pair[0])
        const second = fragmentedParser.feedSync(pair[1])
        return first.length === 0 ? second : [...first, ...second]
      },
      batch: () => batchParser.feedSync(stream)
    }
  }

  const defaultFeeds = feedShapes()
  const fingerprintFeeds = feedShapes({ fingerprint: true })
  const decodeSingle = defaultFeeds.single
  const decodeFragmented = defaultFeeds.fragmented
  const decodeBatch = defaultFeeds.batch
  const decodeMsgpackStream = () =>
    msgpackUnpackr.unpackMultiple(msgpackStream).map((value) => decodeMsgpackValue(value))

  assert.deepStrictEqual(decodeSingle(), [values[0]])
  assert.deepStrictEqual(decodeFragmented(), [values[0]])
  assert.deepStrictEqual(decodeBatch(), values)
  assert.deepStrictEqual(fingerprintFeeds.single(), [values[0]])
  assert.deepStrictEqual(fingerprintFeeds.fragmented(), [values[0]])
  assert.deepStrictEqual(fingerprintFeeds.batch(), values)
  assert.deepStrictEqual(decodeMsgpackStream(), values)
  assert.deepStrictEqual(decodeProtobufStream(), values)
  assert.deepStrictEqual(await decodeNdjsonSingle(), [values[0]])
  assert.deepStrictEqual(await decodeNdjsonFragmented(), [values[0]])
  assert.deepStrictEqual(await decodeNdjsonBatch(), values)

  return {
    formats: [
      { name: "SchemaBinary parser / single frame", framesPerOp: 1, decode: decodeSingle },
      { name: "SchemaBinary parser / batch", framesPerOp: values.length, decode: decodeBatch },
      { name: "SchemaBinary parser / fragmented", framesPerOp: 1, decode: decodeFragmented },
      { name: "SchemaBinary fingerprint / single frame", framesPerOp: 1, decode: fingerprintFeeds.single },
      { name: "SchemaBinary fingerprint / batch", framesPerOp: values.length, decode: fingerprintFeeds.batch },
      { name: "SchemaBinary fingerprint / fragmented", framesPerOp: 1, decode: fingerprintFeeds.fragmented },
      { name: "Msgpack unpackMultiple / batch", framesPerOp: values.length, decode: decodeMsgpackStream },
      { name: "Protobuf decodeDelimited / batch", framesPerOp: values.length, decode: decodeProtobufStream },
      { name: "NDJSON Channel / single frame", framesPerOp: 1, decode: decodeNdjsonSingle },
      { name: "NDJSON Channel / batch", framesPerOp: values.length, decode: decodeNdjsonBatch },
      { name: "NDJSON Channel / fragmented", framesPerOp: 1, decode: decodeNdjsonFragmented }
    ],
    sizes: [
      { name: "SchemaBinary", frames: values.length, ...sizes(binaryStream) },
      { name: "SchemaBinary fingerprint", frames: values.length, ...sizes(fingerprintStream) },
      { name: "Msgpack", frames: values.length, ...sizes(msgpackStream) },
      { name: "Protobuf", frames: values.length, ...sizes(protobufStream) },
      { name: "NDJSON", frames: values.length, ...sizes(ndjsonStream) }
    ]
  }
}

const preparedStreams = await Promise.all([
  ...cases.map((testCase) => ({
    name: testCase.name,
    prepared: prepareStream(
      testCase.schema,
      Array.from({ length: streamBatchSize }, () => testCase.value),
      testCase.protobuf
    )
  })),
  { name: "200 single-row frames", prepared: prepareStream(LargeRow, largeRows, largeRowProtobufFixture) }
].map(async ({ name, prepared }) => ({ name, ...await prepared })))

console.log(`Node ${process.version}; codec and schema construction excluded from timings.`)
console.log("JSON and Msgpack use the same Schema.toCodecJson representation; JSON sizes are UTF-8 bytes.")
console.log(`msgpackr native acceleration enabled: ${isNativeAccelerationEnabled}.`)
console.log(
  "Cases suffixed with / raw serializers compare SchemaBinary's public codec with unvalidated raw serializers."
)
console.log("Protobuf uses prebuilt protobufjs descriptors; descriptor construction and encode adapters are excluded.")
console.log(
  "Compare formats within a case and direction in the same run; absolute rates vary with the machine and runtime."
)

console.table(prepared.flatMap((testCase) =>
  testCase.formats.map((format) => ({
    Case: testCase.name,
    Format: format.name,
    "Raw bytes": format.encodedSize,
    "gzip -6 bytes": format.gzipSize,
    "zstd bytes": format.zstdSize
  }))
))

console.table(preparedRaw.flatMap((testCase) =>
  testCase.formats.map((format) => ({
    Case: testCase.name,
    Format: format.name,
    "Raw bytes": format.encodedSize,
    "gzip -6 bytes": format.gzipSize,
    "zstd bytes": format.zstdSize
  }))
))

console.log(
  "SchemaBinary streaming reuses one parser per feed shape; NDJSON runs its Channel per operation. Fragmented frames split after the first byte."
)
console.table(preparedStreams.flatMap((testCase) =>
  testCase.sizes.map((format) => ({
    Case: testCase.name,
    Format: format.name,
    Frames: format.frames,
    "Raw bytes": format.encodedSize,
    "Bytes / frame": format.encodedSize / format.frames,
    "gzip -6 bytes": format.gzipSize,
    "zstd bytes": format.zstdSize
  }))
))

const bench = new Bench({
  iterations: 1_000,
  time: 0,
  warmupIterations: 100,
  warmupTime: 0,
  timestampProvider: "hrtimeNow"
})
const tasks = new Map<string, { readonly caseName: string; readonly formatName: string; readonly direction: string }>()
const sinkSentinel = Symbol("benchmark did not run")
let sink: unknown = sinkSentinel

for (const testCase of prepared) {
  for (const format of testCase.formats) {
    for (const [direction, run] of [["encode", format.encode], ["decode", format.decode]] as const) {
      const name = `${testCase.name} / ${format.name} / ${direction}`
      tasks.set(name, { caseName: testCase.name, formatName: format.name, direction })
      bench.add(name, () => {
        sink = run()
      })
    }
  }
}

for (const testCase of preparedRaw) {
  for (const format of testCase.formats) {
    for (const [direction, run] of [["encode", format.encode], ["decode", format.decode]] as const) {
      const name = `${testCase.name} / ${format.name} / ${direction}`
      tasks.set(name, { caseName: testCase.name, formatName: format.name, direction })
      bench.add(name, () => {
        sink = run()
      })
    }
  }
}

await bench.run()

if (sink === sinkSentinel) {
  throw new Error("Benchmark did not run")
}

console.table(bench.tasks.map((task) => {
  const labels = tasks.get(task.name)!
  const result = task.result
  if (result?.state === "errored") {
    return {
      Case: labels.caseName,
      Format: labels.formatName,
      Direction: labels.direction,
      Error: result.error.message
    }
  }
  if (result?.state !== "completed") {
    return {
      Case: labels.caseName,
      Format: labels.formatName,
      Direction: labels.direction,
      State: result?.state ?? "missing result"
    }
  }
  return {
    Case: labels.caseName,
    Format: labels.formatName,
    Direction: labels.direction,
    "Throughput avg (ops/s)": Math.round(result.throughput.mean),
    "Latency med (us/op)": (result.latency.p50 * 1_000).toFixed(2),
    "Latency RME": `${result.latency.rme.toFixed(2)}%`,
    Samples: result.latency.samplesCount
  }
}))

const streamBench = new Bench({
  iterations: 250,
  time: 0,
  warmupIterations: 25,
  warmupTime: 0,
  timestampProvider: "hrtimeNow"
})
const streamTasks = new Map<
  string,
  { readonly caseName: string; readonly formatName: string; readonly framesPerOp: number }
>()

for (const testCase of preparedStreams) {
  for (const format of testCase.formats) {
    const name = `${testCase.name} / ${format.name} / stream decode`
    streamTasks.set(name, {
      caseName: testCase.name,
      formatName: format.name,
      framesPerOp: format.framesPerOp
    })
    streamBench.add(name, () => {
      const decoded = format.decode()
      if (decoded instanceof Promise) {
        return decoded.then((value) => {
          sink = value
        })
      }
      sink = decoded
    })
  }
}

await streamBench.run()

console.table(streamBench.tasks.map((task) => {
  const labels = streamTasks.get(task.name)!
  const result = task.result
  if (result?.state === "errored") {
    return {
      Case: labels.caseName,
      Format: labels.formatName,
      Error: result.error.message
    }
  }
  if (result?.state !== "completed") {
    return {
      Case: labels.caseName,
      Format: labels.formatName,
      State: result?.state ?? "missing result"
    }
  }
  return {
    Case: labels.caseName,
    Format: labels.formatName,
    "Throughput avg (values/s)": Math.round(result.throughput.mean * labels.framesPerOp),
    "Latency med (us/value)": (result.latency.p50 * 1_000 / labels.framesPerOp).toFixed(2),
    "Latency RME": `${result.latency.rme.toFixed(2)}%`,
    Samples: result.latency.samplesCount
  }
}))
