import * as Effect from "effect/Effect"
import * as OtlpSerialization from "effect/observability/OtlpSerialization"
import * as ProtobufDescriptor from "effect/protobuf/ProtobufDescriptor"
import * as ProtobufMessage from "effect/protobuf/ProtobufMessage"
import * as Result from "effect/Result"
import assert from "node:assert/strict"
import protobuf from "protobufjs"

const variants = 16
const mask = variants - 1
const file: ProtobufDescriptor.FileDescriptorProto = {
  name: "runtimeperf.proto",
  package: "bench",
  syntax: "proto3",
  message_type: [
    {
      name: "Point",
      field: [
        { name: "x", number: 1, label: 1, type: 5 },
        { name: "y", number: 2, label: 1, type: 5 }
      ]
    },
    {
      name: "Shape",
      field: [
        { name: "name", number: 1, label: 1, type: 9 },
        { name: "origin", number: 2, label: 1, type: 11, type_name: ".bench.Point" },
        { name: "points", number: 3, label: 3, type: 11, type_name: ".bench.Point" },
        { name: "ids", number: 4, label: 3, type: 5 },
        { name: "weights", number: 5, label: 3, type: 1 },
        { name: "data", number: 6, label: 1, type: 12 }
      ]
    }
  ]
}

// Independent reference encoding is constructed outside the timed operation.
// All populated singular scalars are nonzero, so protobufjs and Effect use the
// same field presence. Decoded absent messages are omitted, not null.
const reference = protobuf.parse(`
  syntax = "proto3";
  package bench;
  message Point { int32 x = 1; int32 y = 2; }
  message Shape {
    string name = 1; Point origin = 2; repeated Point points = 3;
    repeated int32 ids = 4; repeated double weights = 5; bytes data = 6;
  }
  message AnyValue { oneof value { string stringValue = 1; int64 intValue = 3; } }
  message KeyValue { string key = 1; AnyValue value = 2; }
  message Resource { repeated KeyValue attributes = 1; }
  message Scope { string name = 1; }
  message LogRecord { fixed64 timeUnixNano = 1; AnyValue body = 5; repeated KeyValue attributes = 6; }
  message ScopeLogs { Scope scope = 1; repeated LogRecord logRecords = 2; }
  message ResourceLogs { Resource resource = 1; repeated ScopeLogs scopeLogs = 2; }
  message LogsData { repeated ResourceLogs resourceLogs = 1; }
`).root

const normalize = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).filter(([, value]) => value !== null).map(([key, value]) => [key, normalize(value)])
    )
  }
  return value
}

const assertSuccess = (result: unknown, expected: unknown) => {
  assert.ok(Result.isResult(result) && Result.isSuccess(result))
  assert.deepEqual(result.success, expected)
}

const codecCase = (
  typeName: string,
  values: ReadonlyArray<object>,
  operation: "encode" | "decode"
) =>
() => {
  const descriptor = Result.getOrThrow(ProtobufDescriptor.make([file])).getMessage(typeName)!
  const referenceType = reference.lookupType(typeName)
  const inputs = values.map((value) => {
    const bytes = new Uint8Array(referenceType.encode(value).finish())
    const decoded = normalize(
      referenceType.toObject(referenceType.decode(bytes), { defaults: true, arrays: true, objects: true })
    ) as Record<string, unknown>
    // protobufjs represents an absent bytes field as an empty array.
    if ("data" in decoded) decoded.data = new Uint8Array(decoded.data as Uint8Array | Array<number>)
    assertSuccess(ProtobufMessage.encode(descriptor)(value), bytes)
    assertSuccess(ProtobufMessage.decode(descriptor)(bytes), decoded)
    return { value, bytes, decoded }
  })
  const encode = ProtobufMessage.encode(descriptor)
  const decode = ProtobufMessage.decode(descriptor)
  let index = 0
  return {
    run: operation === "encode"
      ? () => encode(inputs[index++ & mask].value)
      : () => decode(inputs[index++ & mask].bytes),
    validate: (result: unknown) => {
      const input = inputs[(index - 1) & mask]
      assertSuccess(result, operation === "encode" ? input.bytes : input.decoded)
    }
  }
}

const small = Array.from({ length: variants }, (_, i) => ({ x: 150 + i, y: -3 - i }))
const nested = Array.from({ length: variants }, (_, i) => ({
  name: `shape-${i}`,
  origin: { x: i + 1, y: i + 2 },
  points: Array.from({ length: 16 }, (_, j) => ({ x: i + j + 1, y: -j - 1 }))
}))
const packed = Array.from({ length: variants }, (_, i) => ({
  ids: Array.from({ length: 1024 }, (_, j) => i + j),
  weights: Array.from({ length: 1024 }, (_, j) => (i + j) / 2)
}))
const bytePayloads = Array.from({ length: variants }, (_, i) => ({
  name: `payload-${i}`,
  data: new Uint8Array(65536).fill(i)
}))

export const encodeSmall = codecCase("bench.Point", small, "encode")
export const decodeSmall = codecCase("bench.Point", small, "decode")
export const encodeNested = codecCase("bench.Shape", nested, "encode")
export const decodeNested = codecCase("bench.Shape", nested, "decode")
export const encodePacked = codecCase("bench.Shape", packed, "encode")
export const decodePacked = codecCase("bench.Shape", packed, "decode")
export const encodeBytes = codecCase("bench.Shape", bytePayloads, "encode")
export const decodeBytes = codecCase("bench.Shape", bytePayloads, "decode")

export const decodeMergedUnknown = () => {
  const descriptor = Result.getOrThrow(ProtobufDescriptor.make([file])).getMessage("bench.Shape")!
  // 500 occurrences of origin, each with one unknown field. Their spans must
  // accumulate on the surviving message without repeatedly copying its bytes.
  const bytes = new Uint8Array(Buffer.from("12050801f80701".repeat(500), "hex"))
  const expected = {
    name: "",
    origin: { x: 1, y: 0, [ProtobufMessage.unknownFields]: new Uint8Array(Buffer.from("f80701".repeat(500), "hex")) },
    points: [],
    ids: [],
    weights: [],
    data: new Uint8Array(0)
  }
  const decode = ProtobufMessage.decode(descriptor)
  return { run: () => decode(bytes), validate: (result: unknown) => assertSuccess(result, expected) }
}

export const decodeMessageSet = () => {
  const registry = Result.getOrThrow(ProtobufDescriptor.make([{
    name: "message-set.proto",
    syntax: "proto2",
    message_type: [
      {
        name: "Container",
        options: { message_set_wire_format: true },
        extension_range: [{ start: 4, end: 2147483647 }]
      },
      { name: "Payload", field: [{ name: "value", number: 1, type: 5, label: 1 }] }
    ],
    extension: [{ name: "payload", number: 1000, type: 11, type_name: ".Payload", label: 1, extendee: ".Container" }]
  }]))
  const extension = registry.getExtension("payload")!
  const count = 128
  const unknown = new Uint8Array(Buffer.concat(
    Array.from({ length: count }, (_, j) => Buffer.from([0xf8, 0x07, j]))
  ))
  const inputs = Array.from({ length: variants }, (_, i) => {
    // Each item contains a value and unknown field 127. Decoding merges all
    // payloads while retaining each payload's unknown bytes in wire order.
    const items = Array.from(
      { length: count },
      (_, j) => Buffer.from([0x0b, 0x10, 0xe8, 0x07, 0x1a, 0x05, 0x08, (i + j) & 127, 0xf8, 0x07, j, 0x0c])
    )
    return {
      message: { [ProtobufMessage.unknownFields]: new Uint8Array(Buffer.concat(items)) },
      expected: {
        value: (i + count - 1) & 127,
        [ProtobufMessage.unknownFields]: unknown
      }
    }
  })
  let index = 0
  return {
    run: () => ProtobufMessage.getExtension(inputs[index++ & mask].message, extension),
    validate: (result: unknown) => assertSuccess(result, inputs[(index - 1) & mask].expected)
  }
}

export const decodeFreshDescriptor = () => {
  const bytes = new Uint8Array([8, 1])
  return {
    run: () => {
      const descriptor = Result.getOrThrow(ProtobufDescriptor.make([file])).getMessage("bench.Point")!
      return ProtobufMessage.decode(descriptor)(bytes)
    },
    validate: (result: unknown) => assertSuccess(result, { x: 1, y: 0 })
  }
}

export const decodeMalformed = () => {
  const descriptor = Result.getOrThrow(ProtobufDescriptor.make([file])).getMessage("bench.Point")!
  const decode = ProtobufMessage.decode(descriptor)
  const bytes = new Uint8Array([8, 128])
  return {
    run: () => decode(bytes),
    validate: (result: unknown) => {
      assert.ok(Result.isResult(result) && Result.isFailure(result))
      assert.ok(result.failure instanceof ProtobufMessage.ProtobufMessageError)
      assert.deepEqual(result.failure.path, ["x"])
      assert.equal(result.failure.message, "x: Expected a complete value at offset 2")
    }
  }
}

export const encodeOtlpLogs = () => {
  const serialization = Effect.runSync(
    Effect.provide(OtlpSerialization.OtlpSerialization, OtlpSerialization.layerProtobuf)
  )
  const referenceType = reference.lookupType("bench.LogsData")
  const inputs = Array.from({ length: variants }, (_, i) => {
    const value = {
      resourceLogs: [{
        resource: { attributes: [{ key: "name", value: { stringValue: "example" } }], droppedAttributesCount: 0 },
        scopeLogs: [{
          scope: { name: "test" },
          logRecords: Array.from({ length: 16 }, (_, j) => ({
            timeUnixNano: i + j + 1,
            body: { stringValue: "message" },
            attributes: [{ key: "count", value: { intValue: i + j + 1 } }]
          }))
        }]
      }]
    }
    return { value, bytes: new Uint8Array(referenceType.encode(value).finish()) }
  })
  let index = 0
  return {
    run: () => serialization.logs(inputs[index++ & mask].value),
    validate: (result: unknown) => {
      assert.ok(
        typeof result === "object" && result !== null && "_tag" in result && result._tag === "Uint8Array" &&
          "body" in result
      )
      assert.deepEqual(result.body, inputs[(index - 1) & mask].bytes)
    }
  }
}
