import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

export const ClientMessage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("echo"),
    text: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("sum"),
    left: Schema.Number,
    right: Schema.Number
  }),
  Schema.Struct({
    kind: Schema.Literal("time")
  })
])

export type ClientMessage = Schema.Schema.Type<typeof ClientMessage>

export const ServerMessage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("echo"),
    text: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("sumResult"),
    total: Schema.Number
  }),
  Schema.Struct({
    kind: Schema.Literal("time"),
    iso: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    error: Schema.String
  })
])


export type ServerMessage = Schema.Schema.Type<typeof ServerMessage>

export const decodeClientMessage = Schema.decodeUnknownEffect(ClientMessage)

const Utf8StringFromUint8Array = Schema.Uint8Array.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (bytes) => new TextDecoder().decode(bytes),
      encode: (text) => new TextEncoder().encode(text)
    })
  )
)

const ClientMessageFromWire = Schema.Union([
  Schema.String,
  Utf8StringFromUint8Array
]).pipe(
  Schema.decodeTo(Schema.fromJsonString(ClientMessage))
)

export const decodeWireClientMessage = Schema.decodeUnknownEffect(ClientMessageFromWire)

export const routeClientMessage = (message: ClientMessage): ServerMessage => {
  switch (message.kind) {
    case "echo":
      return { kind: "echo", text: message.text }
    case "sum":
      return { kind: "sumResult", total: message.left + message.right }
    case "time":
      return { kind: "time", iso: new Date().toISOString() }
  }
}
