/**
 * Descriptors of `.proto` files: their messages, enums, extensions and
 * services, resolved from the `FileDescriptorProto`s that protoc, buf, gRPC
 * server reflection and protoc plugins exchange.
 *
 * **Mental model**
 *
 * - A {@link Registry} holds the files of one set of `.proto` files and finds
 *   their types by full name, such as `"acme.v1.User"`.
 * - Descriptors are resolved: every field states its presence, packing,
 *   encoding and UTF-8 validation, as the file's syntax or edition and its
 *   features decide them, and refers to the descriptor of its type.
 * - `ProtobufMessage` encodes and decodes the values of a message descriptor.
 *   Neither module depends on Effect Schema. A Schema can separately transform
 *   these plain values into application types.
 * - Field and oneof names are preserved exactly in JavaScript values.
 *
 * **Gotchas**
 *
 * - Type references must be fully qualified, with a leading dot, as protoc and
 *   buf write them.
 * - proto2, proto3 and editions 2023, 2024 and 2026 are supported. Unknown
 *   editions are rejected rather than interpreted with older defaults.
 * - Descriptors are compiler output. Source-level naming, visibility and
 *   definition-size rules are enforced by protoc, before runtime resolution.
 * - `descriptor.proto` itself is part of this module: `descriptorFile`,
 *   and per message an interface and a `MessageDescriptor` of the same name,
 *   such as `FileDescriptorProto`, generated from protoc's descriptor of it.
 *
 * **Example** (Finding a message)
 *
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { ProtobufDescriptor } from "effect/protobuf"
 *
 * const registry = Result.getOrThrow(ProtobufDescriptor.make([{
 *   name: "user.proto",
 *   package: "acme.v1",
 *   syntax: "proto3",
 *   dependency: [],
 *   message_type: [{
 *     name: "User",
 *     field: [{ name: "display_name", number: 1, label: 1, type: 9 }]
 *   }]
 * }]))
 *
 * const user = registry.getMessage("acme.v1.User")!
 * user.fields.map((field) => field.name) // => ["display_name"]
 * ```
 *
 * @stability experimental
 * @since 4.1.5
 */
import * as Data from "../Data.ts"
import * as Result from "../Result.ts"
import * as Binary from "./internal/binary.ts"
import * as Resolve from "./internal/resolve.ts"
import { FileDescriptorSet as FileDescriptorSetMessage } from "./ProtobufDescriptorProto.ts"
import type {
  DescriptorProto,
  EnumDescriptorProto,
  EnumValueDescriptorProto,
  FieldDescriptorProto,
  FileDescriptorProto,
  FileDescriptorSet,
  MethodDescriptorProto,
  OneofDescriptorProto,
  ServiceDescriptorProto
} from "./ProtobufDescriptorProto.ts"

// -----------------------------------------------------------------------------
// descriptors
// -----------------------------------------------------------------------------

/**
 * The editions this module resolves. proto2 and proto3 files are the editions
 * of their syntax.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type EditionName = "proto2" | "proto3" | "2023" | "2024" | "2026"

/**
 * The scalar types of protobuf fields.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type ScalarType =
  | "double"
  | "float"
  | "int64"
  | "uint64"
  | "int32"
  | "fixed64"
  | "fixed32"
  | "bool"
  | "string"
  | "bytes"
  | "uint32"
  | "sfixed32"
  | "sfixed64"
  | "sint32"
  | "sint64"

/**
 * How a value of a 64-bit integer field is held: a `bigint`, or a `number` or
 * a decimal `string`, as `[jstype = JS_NUMBER]` and `[jstype = JS_STRING]`
 * ask.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type JsType = "bigint" | "number" | "string"

/**
 * When a singular field is present.
 *
 * **Details**
 *
 * - `"implicit"`: when it is not its zero value, as proto3 fields without
 *   `optional`
 * - `"explicit"`: when it is set, even to its zero value
 * - `"required"`: always, as proto2 `required` fields
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type Presence = "implicit" | "explicit" | "required"

/**
 * A resolved `.proto` file.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface FileDescriptor {
  readonly _tag: "FileDescriptor"
  readonly name: string
  readonly package: string
  readonly edition: EditionName
  readonly dependencies: ReadonlyArray<FileDescriptor>
  readonly messages: ReadonlyArray<MessageDescriptor>
  readonly enums: ReadonlyArray<EnumDescriptor>
  readonly extensions: ReadonlyArray<ExtensionDescriptor>
  readonly services: ReadonlyArray<ServiceDescriptor>
  readonly proto: FileDescriptorProto
}

/**
 * A message type. `fields` are in declaration order. Map entry messages are
 * not part of `messages`; their fields are described by the map field.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface MessageDescriptor {
  readonly _tag: "MessageDescriptor"
  readonly typeName: string
  readonly name: string
  readonly file: FileDescriptor
  readonly parent: MessageDescriptor | undefined
  readonly fields: ReadonlyArray<FieldDescriptor>
  readonly oneofs: ReadonlyArray<OneofDescriptor>
  readonly messages: ReadonlyArray<MessageDescriptor>
  readonly enums: ReadonlyArray<EnumDescriptor>
  readonly extensions: ReadonlyArray<ExtensionDescriptor>
  /** Whether its extensions are encoded as MessageSet items. */
  readonly messageSetWireFormat: boolean
  readonly proto: DescriptorProto
}

/**
 * A field of a message, or of an extension.
 *
 * **Details**
 *
 * - `"singular"`: one value, present as its {@link Presence} says
 * - `"list"`: a repeated field, an array of values
 * - `"map"`: a map field, a record from keys to values
 *
 * `name` is the property that holds the field in a message value: the
 * original protobuf name, without casing changes or escaping.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type FieldDescriptor = SingularFieldDescriptor | ListFieldDescriptor | MapFieldDescriptor

interface FieldBase {
  readonly _tag: "FieldDescriptor"
  readonly name: string
  readonly number: number
  /** The message the field belongs to, or that an extension extends. */
  readonly parent: MessageDescriptor
  readonly oneof: OneofDescriptor | undefined
  readonly proto: FieldDescriptorProto
}

/**
 * A singular field.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface SingularFieldDescriptor extends FieldBase {
  readonly kind: "singular"
  readonly type: ValueType
  readonly presence: Presence
}

/**
 * A repeated field. `packed` decides how number, boolean and enum elements
 * are written; both encodings are read. Strings, bytes and messages are never
 * packed.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface ListFieldDescriptor extends FieldBase {
  readonly kind: "list"
  readonly type: ValueType
  readonly packed: boolean
}

/**
 * A map field. `key` is a scalar type other than a float, double or bytes.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface MapFieldDescriptor extends FieldBase {
  readonly kind: "map"
  readonly key: ScalarValueType
  readonly type: ValueType
}

/**
 * The type of a value of a field: of a singular field, an element of a list,
 * or a value of a map.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export type ValueType = ScalarValueType | EnumValueType | MessageValueType

/**
 * A scalar value. `jsType` applies to 64-bit integers, and `validateUtf8` to
 * strings.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface ScalarValueType {
  readonly kind: "scalar"
  readonly scalar: ScalarType
  readonly jsType: JsType
  readonly validateUtf8: boolean
}

/**
 * An enum value, held as its number.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface EnumValueType {
  readonly kind: "enum"
  readonly enum: EnumDescriptor
}

/**
 * A message value. `delimited` messages are encoded as groups.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface MessageValueType {
  readonly kind: "message"
  readonly message: MessageDescriptor
  readonly delimited: boolean
}

/**
 * A oneof. Synthetic oneofs, of proto3 `optional` fields, are not oneofs here:
 * their fields have explicit presence.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface OneofDescriptor {
  readonly _tag: "OneofDescriptor"
  readonly name: string
  readonly parent: MessageDescriptor
  readonly fields: ReadonlyArray<FieldDescriptor>
  readonly proto: OneofDescriptorProto
}

/**
 * An enum type. An open enum holds any number; a closed enum holds only its
 * values, and decoding keeps other numbers as unknown fields.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface EnumDescriptor {
  readonly _tag: "EnumDescriptor"
  readonly typeName: string
  readonly name: string
  readonly file: FileDescriptor
  readonly parent: MessageDescriptor | undefined
  readonly values: ReadonlyArray<EnumValueDescriptor>
  readonly open: boolean
  readonly proto: EnumDescriptorProto
}

/**
 * A value of an enum.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface EnumValueDescriptor {
  readonly _tag: "EnumValueDescriptor"
  readonly name: string
  readonly number: number
  readonly parent: EnumDescriptor
  readonly proto: EnumValueDescriptorProto
}

/**
 * An extension: a field of `extendee` declared outside of it.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface ExtensionDescriptor {
  readonly _tag: "ExtensionDescriptor"
  readonly typeName: string
  readonly name: string
  readonly file: FileDescriptor
  /** The message the extension is declared in, if any. */
  readonly parent: MessageDescriptor | undefined
  readonly extendee: MessageDescriptor
  readonly field: SingularFieldDescriptor | ListFieldDescriptor
  readonly proto: FieldDescriptorProto
}

/**
 * A service.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface ServiceDescriptor {
  readonly _tag: "ServiceDescriptor"
  readonly typeName: string
  readonly name: string
  readonly file: FileDescriptor
  readonly methods: ReadonlyArray<MethodDescriptor>
  readonly proto: ServiceDescriptorProto
}

/**
 * A method of a service.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface MethodDescriptor {
  readonly _tag: "MethodDescriptor"
  readonly name: string
  readonly parent: ServiceDescriptor
  readonly input: MessageDescriptor
  readonly output: MessageDescriptor
  readonly clientStreaming: boolean
  readonly serverStreaming: boolean
  readonly idempotency: "unknown" | "noSideEffects" | "idempotent"
  readonly proto: MethodDescriptorProto
}

// -----------------------------------------------------------------------------
// registry
// -----------------------------------------------------------------------------

/**
 * The resolved files of a set of `.proto` files, and their types by full
 * name, such as `"acme.v1.User"`.
 *
 * @stability experimental
 * @category models
 * @since 4.1.5
 */
export interface Registry {
  readonly files: ReadonlyArray<FileDescriptor>
  readonly getFile: (name: string) => FileDescriptor | undefined
  readonly getMessage: (typeName: string) => MessageDescriptor | undefined
  readonly getEnum: (typeName: string) => EnumDescriptor | undefined
  readonly getService: (typeName: string) => ServiceDescriptor | undefined
  readonly getExtension: (typeName: string) => ExtensionDescriptor | undefined
  /** The extension of `extendee`, by its full name, with field `number`. */
  readonly findExtension: (extendee: string, number: number) => ExtensionDescriptor | undefined
}

/**
 * The error for descriptors that do not resolve, such as a missing
 * dependency or type, or an unsupported edition.
 *
 * @stability experimental
 * @category errors
 * @since 4.1.5
 */
export class ProtobufDescriptorError extends Data.TaggedError("ProtobufDescriptorError")<{
  readonly message: string
}> {}

/**
 * Resolves `FileDescriptorProto`s into a {@link Registry}. Files may come in
 * any order, but every dependency must be among them.
 *
 * **Details**
 *
 * Resolving checks references and the field layout used by the message codec,
 * including field-number bounds, duplicate names and numbers, oneof membership,
 * and map key types. Invalid layouts return a {@link ProtobufDescriptorError}.
 * This does not replace protoc's validation of `.proto` source files.
 *
 * **Example** (Resolving a file)
 *
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { ProtobufDescriptor } from "effect/protobuf"
 *
 * const registry = Result.getOrThrow(ProtobufDescriptor.make([{
 *   name: "point.proto",
 *   syntax: "proto3",
 *   dependency: [],
 *   message_type: [{
 *     name: "Point",
 *     field: [
 *       { name: "x", number: 1, label: 1, type: 5 },
 *       { name: "y", number: 2, label: 1, type: 5 }
 *     ]
 *   }]
 * }]))
 *
 * const x = registry.getMessage("Point")!.fields[0]
 * x.kind === "singular" && x.presence // => "implicit"
 * ```
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export const make = (files: Iterable<FileDescriptorProto>): Result.Result<Registry, ProtobufDescriptorError> => {
  try {
    return Result.succeed(Resolve.resolve(files))
  } catch (e) {
    if (e instanceof Resolve.ResolveError) return Result.fail(new ProtobufDescriptorError({ message: e.message }))
    throw e
  }
}

/**
 * Decodes a `FileDescriptorSet`, as `protoc --descriptor_set_out` and
 * `buf build` write it, and resolves its files into a {@link Registry}.
 *
 * @stability experimental
 * @category constructors
 * @since 4.1.5
 */
export const fromFileDescriptorSet = (bytes: Uint8Array): Result.Result<Registry, ProtobufDescriptorError> => {
  const set = Binary.decode(FileDescriptorSetMessage, bytes, undefined)
  if (Result.isFailure(set)) return Result.fail(new ProtobufDescriptorError({ message: set.failure.message }))
  return make((set.success as FileDescriptorSet).file ?? [])
}

// -----------------------------------------------------------------------------
// descriptor.proto
// -----------------------------------------------------------------------------

export * from "./ProtobufDescriptorProto.ts"
