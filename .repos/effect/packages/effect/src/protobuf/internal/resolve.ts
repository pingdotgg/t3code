// Resolves `FileDescriptorProto`s into descriptors: types by full name, field
// kinds, and the features of each file's syntax or edition applied to every
// field and enum.
//
// Descriptors refer to each other, so they are built in two passes: first
// every message and enum, by full name, then the fields, extensions and
// services that refer to them.

import type * as D from "../ProtobufDescriptor.ts"

/** @internal */
export class ResolveError extends Error {}

const fail = (message: string): never => {
  throw new ResolveError(message)
}

// -----------------------------------------------------------------------------
// features
// -----------------------------------------------------------------------------

// The numbers of `google.protobuf.Edition`.
const EDITION_2023 = 1000
const EDITION_2024 = 1001
const EDITION_2026 = 1002

// `FieldDescriptorProto.Label` and `.Type`.
const LABEL_REPEATED = 3
const LABEL_REQUIRED = 2
const TYPE_GROUP = 10
const TYPE_MESSAGE = 11
const TYPE_ENUM = 14

const SCALARS: Record<number, D.ScalarType> = {
  1: "double",
  2: "float",
  3: "int64",
  4: "uint64",
  5: "int32",
  6: "fixed64",
  7: "fixed32",
  8: "bool",
  9: "string",
  12: "bytes",
  13: "uint32",
  15: "sfixed32",
  16: "sfixed64",
  17: "sint32",
  18: "sint64"
}

// The resolved features that decide how fields are encoded.
interface Features {
  readonly fieldPresence: "explicit" | "implicit" | "required"
  readonly enumType: "open" | "closed"
  readonly repeatedFieldEncoding: "packed" | "expanded"
  readonly utf8Validation: boolean
  readonly delimited: boolean
}

// The `edition_defaults` of the features in `descriptor.proto`.
const PROTO2: Features = {
  fieldPresence: "explicit",
  enumType: "closed",
  repeatedFieldEncoding: "expanded",
  utf8Validation: false,
  delimited: false
}
const PROTO3: Features = {
  fieldPresence: "implicit",
  enumType: "open",
  repeatedFieldEncoding: "packed",
  utf8Validation: true,
  delimited: false
}
// Editions 2023, 2024 and 2026 share these binary defaults. Naming, visibility
// and definition-size features have source retention and are enforced by protoc.
const EDITIONS: Features = {
  fieldPresence: "explicit",
  enumType: "open",
  repeatedFieldEncoding: "packed",
  utf8Validation: true,
  delimited: false
}

const editionOf = (file: D.FileDescriptorProto): D.EditionName => {
  switch (file.syntax) {
    case undefined:
    case "":
    case "proto2":
      return "proto2"
    case "proto3":
      return "proto3"
    case "editions":
      if (file.edition === EDITION_2023) return "2023"
      if (file.edition === EDITION_2024) return "2024"
      if (file.edition === EDITION_2026) return "2026"
      return fail(`${file.name}: edition ${file.edition} is not supported`)
    default:
      return fail(`${file.name}: syntax ${file.syntax} is not supported`)
  }
}

// Overrides the features that a `FeatureSet` sets. Each is a number of its
// enum in `descriptor.proto`; 0 is unset.
const merge = (features: Features, set: D.FeatureSet | undefined): Features => {
  if (set === undefined) return features
  return {
    fieldPresence: set.field_presence === 1
      ? "explicit"
      : set.field_presence === 2
      ? "implicit"
      : set.field_presence === 3
      ? "required"
      : features.fieldPresence,
    enumType: set.enum_type === 1 ? "open" : set.enum_type === 2 ? "closed" : features.enumType,
    repeatedFieldEncoding: set.repeated_field_encoding === 1
      ? "packed"
      : set.repeated_field_encoding === 2
      ? "expanded"
      : features.repeatedFieldEncoding,
    utf8Validation: set.utf8_validation === 2 ? true : set.utf8_validation === 3 ? false : features.utf8Validation,
    delimited: set.message_encoding === 1 ? false : set.message_encoding === 2 ? true : features.delimited
  }
}

// The features of a field, from those of its parent. proto2 and proto3 spell
// some features with their own syntax.
const fieldFeatures = (edition: D.EditionName, parent: Features, field: D.FieldDescriptorProto): Features => {
  const features = merge(parent, field.options?.features)
  if (edition !== "proto2" && edition !== "proto3") {
    return field.type === TYPE_GROUP ? { ...features, delimited: true } : features
  }
  return {
    ...features,
    fieldPresence: field.label === LABEL_REQUIRED
      ? "required"
      : field.proto3_optional === true
      ? "explicit"
      : features.fieldPresence,
    repeatedFieldEncoding: field.options?.packed === true
      ? "packed"
      : field.options?.packed === false
      ? "expanded"
      : features.repeatedFieldEncoding,
    delimited: field.type === TYPE_GROUP
  }
}

// -----------------------------------------------------------------------------
// names
// -----------------------------------------------------------------------------

// `.acme.v1.User` → `acme.v1.User`.
const typeRef = (name: string | undefined, at: string): string => {
  if (name === undefined || !name.startsWith(".")) {
    return fail(`${at}: expected a fully qualified type name, got ${String(name)}`)
  }
  return name.slice(1)
}

// -----------------------------------------------------------------------------
// resolve
// -----------------------------------------------------------------------------

// Descriptors are built mutable, and handed out as the readonly interfaces.
type Mutable<A> = { -readonly [K in keyof A]: A[K] extends ReadonlyArray<infer E> ? Array<E> : A[K] }

interface Pending {
  readonly message: Mutable<D.MessageDescriptor>
  readonly features: Features
}

/** @internal */
export const resolve = (protos: Iterable<D.FileDescriptorProto>): D.Registry => {
  const byName = new Map<string, D.FileDescriptorProto>()
  for (const proto of protos) {
    const name = proto.name ?? fail("a file without a name")
    if (byName.has(name)) fail(`${name}: the file is given twice`)
    byName.set(name, proto)
  }
  const files = new Map<string, Mutable<D.FileDescriptor>>()
  const messages = new Map<string, Mutable<D.MessageDescriptor>>()
  const enums = new Map<string, D.EnumDescriptor>()
  const services = new Map<string, Mutable<D.ServiceDescriptor>>()
  const extensions = new Map<string, D.ExtensionDescriptor>()
  const extensionsByExtendee = new Map<string, Map<number, D.ExtensionDescriptor>>()
  const pending: Array<Pending> = []
  const pendingExtensions: Array<
    readonly [
      file: Mutable<D.FileDescriptor>,
      parent: Mutable<D.MessageDescriptor> | undefined,
      proto: D.FieldDescriptorProto,
      features: Features
    ]
  > = []
  // Map entry messages, by full name, which map fields read.
  const entries = new Map<string, Pending>()

  const define = (typeName: string): void => {
    if (messages.has(typeName) || enums.has(typeName) || services.has(typeName)) {
      fail(`${typeName} is defined twice`)
    }
  }

  const addEnum = (
    file: Mutable<D.FileDescriptor>,
    parent: D.MessageDescriptor | undefined,
    scope: string,
    proto: D.EnumDescriptorProto,
    features: Features
  ): D.EnumDescriptor => {
    const name = proto.name ?? fail(`${scope}: an enum without a name`)
    const typeName = scope === "" ? name : `${scope}.${name}`
    define(typeName)
    const values: Array<D.EnumValueDescriptor> = []
    const out: Mutable<D.EnumDescriptor> = {
      _tag: "EnumDescriptor",
      typeName,
      name,
      file,
      parent,
      values,
      open: merge(features, proto.options?.features).enumType === "open",
      proto
    }
    for (const value of proto.value ?? []) {
      values.push({
        _tag: "EnumValueDescriptor",
        name: value.name ?? fail(`${typeName}: a value without a name`),
        number: value.number ?? fail(`${typeName}.${value.name}: a value without a number`),
        parent: out,
        proto: value
      })
    }
    if (values.length === 0) fail(`${typeName}: an enum without values`)
    enums.set(typeName, out)
    return out
  }

  const addMessage = (
    file: Mutable<D.FileDescriptor>,
    parent: Mutable<D.MessageDescriptor> | undefined,
    scope: string,
    proto: D.DescriptorProto,
    parentFeatures: Features
  ): Mutable<D.MessageDescriptor> => {
    const name = proto.name ?? fail(`${scope}: a message without a name`)
    const typeName = scope === "" ? name : `${scope}.${name}`
    define(typeName)
    const features = merge(parentFeatures, proto.options?.features)
    const out: Mutable<D.MessageDescriptor> = {
      _tag: "MessageDescriptor",
      typeName,
      name,
      file,
      parent,
      fields: [],
      oneofs: [],
      messages: [],
      enums: [],
      extensions: [],
      messageSetWireFormat: proto.options?.message_set_wire_format === true,
      proto
    }
    messages.set(typeName, out)
    const entry: Pending = { message: out, features }
    if (proto.options?.map_entry === true) entries.set(typeName, entry)
    else pending.push(entry)
    for (const nested of proto.nested_type ?? []) {
      const message = addMessage(file, out, typeName, nested, features)
      if (nested.options?.map_entry !== true) out.messages.push(message)
    }
    for (const nested of proto.enum_type ?? []) out.enums.push(addEnum(file, out, typeName, nested, features))
    for (const extension of proto.extension ?? []) {
      pendingExtensions.push([file, out, extension, features])
    }
    return out
  }

  // Files are added after their dependencies.
  const visiting = new Set<string>()
  const addFile = (name: string, importer: string | undefined): Mutable<D.FileDescriptor> => {
    const done = files.get(name)
    if (done !== undefined) return done
    const proto = byName.get(name)
    if (proto === undefined) {
      return fail(importer === undefined ? `${name} is missing` : `${importer} imports ${name}, which is missing`)
    }
    if (visiting.has(name)) fail(`${name} is part of an import cycle`)
    visiting.add(name)
    const dependencies = (proto.dependency ?? []).map((dependency) => addFile(dependency, name))
    visiting.delete(name)
    const edition = editionOf(proto)
    const features = merge(
      edition === "proto2" ? PROTO2 : edition === "proto3" ? PROTO3 : EDITIONS,
      proto.options?.features
    )
    const file: Mutable<D.FileDescriptor> = {
      _tag: "FileDescriptor",
      name,
      package: proto.package ?? "",
      edition,
      dependencies,
      messages: [],
      enums: [],
      extensions: [],
      services: [],
      proto
    }
    files.set(name, file)
    const scope = file.package
    for (const message of proto.message_type ?? []) {
      file.messages.push(addMessage(file, undefined, scope, message, features))
    }
    for (const e of proto.enum_type ?? []) file.enums.push(addEnum(file, undefined, scope, e, features))
    for (const extension of proto.extension ?? []) {
      pendingExtensions.push([file, undefined, extension, features])
    }
    for (const service of proto.service ?? []) {
      const serviceName = service.name ?? fail(`${name}: a service without a name`)
      const typeName = scope === "" ? serviceName : `${scope}.${serviceName}`
      define(typeName)
      const out: Mutable<D.ServiceDescriptor> = {
        _tag: "ServiceDescriptor",
        typeName,
        name: serviceName,
        file,
        methods: [],
        proto: service
      }
      services.set(typeName, out)
      file.services.push(out)
    }
    return file
  }
  for (const name of byName.keys()) addFile(name, undefined)

  // A field's value type.
  const valueType = (
    proto: D.FieldDescriptorProto,
    features: Features,
    at: string
  ): D.ValueType => {
    const type = proto.type ?? fail(`${at}: a field without a type`)
    if (type === TYPE_MESSAGE || type === TYPE_GROUP) {
      const typeName = typeRef(proto.type_name, at)
      const message = messages.get(typeName) ?? fail(`${at}: message ${typeName} is not defined`)
      return { kind: "message", message, delimited: features.delimited }
    }
    if (type === TYPE_ENUM) {
      const typeName = typeRef(proto.type_name, at)
      return { kind: "enum", enum: enums.get(typeName) ?? fail(`${at}: enum ${typeName} is not defined`) }
    }
    const scalar = SCALARS[type] ?? fail(`${at}: field type ${type} is not supported`)
    const jstype = proto.options?.jstype
    return {
      kind: "scalar",
      scalar,
      jsType: jstype === 1 ? "string" : jstype === 2 ? "number" : "bigint",
      validateUtf8: features.utf8Validation
    }
  }

  const field = (
    parent: D.MessageDescriptor,
    oneof: D.OneofDescriptor | undefined,
    proto: D.FieldDescriptorProto,
    features: Features,
    at: string
  ): D.FieldDescriptor => {
    const name = proto.name ?? fail(`${at}: a field without a name`)
    const where = `${at}.${name}`
    const number = proto.number ?? fail(`${where}: a field without a number`)
    // MessageSet extension IDs are encoded as values, not as field tags.
    const maxNumber = proto.extendee !== undefined && parent.messageSetWireFormat ? 2147483646 : 536870911
    if (!Number.isInteger(number) || number < 1 || number > maxNumber) {
      fail(`${where}: expected a field number from 1 through ${maxNumber}`)
    }
    if (proto.label !== undefined && proto.label !== 1 && proto.label !== 2 && proto.label !== 3) {
      fail(`${where}: invalid field label ${proto.label}`)
    }
    const base = {
      _tag: "FieldDescriptor" as const,
      name,
      number,
      parent,
      oneof,
      proto
    }
    if (proto.label === LABEL_REPEATED) {
      if (proto.type === TYPE_MESSAGE) {
        const entry = entries.get(typeRef(proto.type_name, where))
        if (entry !== undefined) {
          const { proto, file } = entry.message
          const key = proto.field?.find((f) => f.number === 1) ?? fail(`${where}: a map entry without a key`)
          const value = proto.field?.find((f) => f.number === 2) ?? fail(`${where}: a map entry without a value`)
          const keyType = valueType(key, fieldFeatures(file.edition, entry.features, key), where)
          if (
            keyType.kind !== "scalar" || keyType.scalar === "bytes" || keyType.scalar === "float" ||
            keyType.scalar === "double"
          ) {
            return fail(`${where}: expected a string, boolean or integer map key`)
          }
          const valueFeatures = fieldFeatures(file.edition, entry.features, value)
          // Map values are never encoded as groups.
          return {
            ...base,
            kind: "map",
            key: keyType,
            type: valueType(value, { ...valueFeatures, delimited: false }, where)
          }
        }
      }
      const type = valueType(proto, features, where)
      // Only numbers, booleans and enums can be packed.
      const packable = type.kind === "enum" ||
        (type.kind === "scalar" && type.scalar !== "string" && type.scalar !== "bytes")
      return { ...base, kind: "list", type, packed: packable && features.repeatedFieldEncoding === "packed" }
    }
    const type = valueType(proto, features, where)
    // Messages and fields of oneofs always have explicit presence.
    const presence = features.fieldPresence === "required"
      ? "required"
      : type.kind === "message" || oneof !== undefined
      ? "explicit"
      : features.fieldPresence
    return { ...base, kind: "singular", type, presence }
  }

  for (const { features, message } of [...pending, ...entries.values()]) {
    const { proto } = message
    const at = message.typeName
    const names = new Set<string>()
    const numbers = new Set<number>()
    const oneofs = (proto.oneof_decl ?? []).map((decl, index): Mutable<D.OneofDescriptor> | undefined => {
      // A synthetic oneof holds only a proto3 `optional` field.
      const members = (proto.field ?? []).filter((f) => f.oneof_index === index)
      if (members.length > 0 && members.every((f) => f.proto3_optional === true)) return undefined
      const name = decl.name ?? fail(`${at}: a oneof without a name`)
      if (names.has(name)) fail(`${at}: ${name} is defined twice`)
      names.add(name)
      return { _tag: "OneofDescriptor", name, parent: message, fields: [], proto: decl }
    })
    for (const oneof of oneofs) if (oneof !== undefined) message.oneofs.push(oneof)
    for (const f of proto.field ?? []) {
      if (
        f.oneof_index !== undefined &&
        (!Number.isInteger(f.oneof_index) || f.oneof_index < 0 || f.oneof_index >= oneofs.length)
      ) {
        fail(`${at}.${f.name}: invalid oneof index ${f.oneof_index}`)
      }
      if (f.oneof_index !== undefined && f.label !== undefined && f.label !== 1) {
        fail(`${at}.${f.name}: a oneof member must be optional`)
      }
      const oneof = f.oneof_index === undefined ? undefined : oneofs[f.oneof_index]
      const fieldFeaturesOf = fieldFeatures(
        message.file.edition,
        oneof === undefined ? features : merge(features, oneof.proto.options?.features),
        f
      )
      const out = field(message, oneof, f, fieldFeaturesOf, at)
      if (names.has(out.name)) fail(`${at}: ${out.name} is defined twice`)
      if (numbers.has(out.number)) fail(`${at}: field number ${out.number} is defined twice`)
      names.add(out.name)
      numbers.add(out.number)
      message.fields.push(out)
      oneof?.fields.push(out)
    }
  }

  for (const [file, parent, proto, features] of pendingExtensions) {
    const scope = parent?.typeName ?? file.package
    const name = proto.name ?? fail(`${scope}: an extension without a name`)
    const typeName = scope === "" ? name : `${scope}.${name}`
    if (extensions.has(typeName)) fail(`${typeName} is defined twice`)
    const extendeeName = typeRef(proto.extendee, typeName)
    const extendee = messages.get(extendeeName) ?? fail(`${typeName}: message ${extendeeName} is not defined`)
    const resolved = field(extendee, undefined, proto, fieldFeatures(file.edition, features, proto), scope)
    if (resolved.kind === "map") return fail(`${typeName}: an extension cannot be a map`)
    const out: D.ExtensionDescriptor = {
      _tag: "ExtensionDescriptor",
      typeName,
      name,
      file,
      parent,
      extendee,
      // Extensions always have explicit presence.
      field: resolved.kind === "singular" && resolved.presence === "implicit"
        ? { ...resolved, presence: "explicit" }
        : resolved,
      proto
    }
    extensions.set(typeName, out)
    ;(parent ?? file).extensions.push(out)
    let byNumber = extensionsByExtendee.get(extendeeName)
    if (byNumber === undefined) extensionsByExtendee.set(extendeeName, byNumber = new Map())
    if (byNumber.has(resolved.number)) fail(`${typeName}: ${extendeeName} has two extensions ${resolved.number}`)
    byNumber.set(resolved.number, out)
  }

  // All message descriptors exist before resolving service methods.
  for (const service of services.values()) {
    for (const method of service.proto.method ?? []) {
      const at = `${service.typeName}.${method.name}`
      const input = typeRef(method.input_type, at)
      const output = typeRef(method.output_type, at)
      const level = method.options?.idempotency_level
      service.methods.push({
        _tag: "MethodDescriptor",
        name: method.name ?? fail(`${service.typeName}: a method without a name`),
        parent: service,
        input: messages.get(input) ?? fail(`${at}: message ${input} is not defined`),
        output: messages.get(output) ?? fail(`${at}: message ${output} is not defined`),
        clientStreaming: method.client_streaming === true,
        serverStreaming: method.server_streaming === true,
        idempotency: level === 1 ? "noSideEffects" : level === 2 ? "idempotent" : "unknown",
        proto: method
      })
    }
  }

  const visible = (name: string) => entries.has(name) ? undefined : messages.get(name)
  return {
    files: [...files.values()],
    getFile: (name) => files.get(name),
    getMessage: visible,
    getEnum: (name) => enums.get(name),
    getService: (name) => services.get(name),
    getExtension: (name) => extensions.get(name),
    findExtension: (extendee, number) => extensionsByExtendee.get(extendee)?.get(number)
  }
}
