/**
 * Minimal reader for Evan Wallace's kiwi binary format, enough to decode a
 * Figma `.fig` file: the file ships its own binary schema, so decoders are
 * built at runtime from that schema instead of generated code.
 *
 * Reference: https://github.com/evanw/kiwi (js/bb.ts, js/binary.ts, js/js.ts).
 */

const BUILTIN_TYPES = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"];
const DEFINITION_KINDS = ["ENUM", "STRUCT", "MESSAGE"] as const;

export interface KiwiField {
  readonly name: string;
  /** Builtin name or definition name; `null` for enum values. */
  readonly type: string | null;
  readonly isArray: boolean;
  readonly value: number;
}

export interface KiwiDefinition {
  readonly name: string;
  readonly kind: (typeof DEFINITION_KINDS)[number];
  readonly fields: ReadonlyArray<KiwiField>;
}

export interface KiwiSchema {
  readonly definitions: ReadonlyArray<KiwiDefinition>;
}

const int32 = new Int32Array(1);
const float32 = new Float32Array(int32.buffer);
const utf8 = new TextDecoder();
/** Array items that consume no bytes (empty structs) before a decode gives up. */
const MAX_EMPTY_ITEMS = 1_000_000;

class KiwiReader {
  index = 0;
  emptyItems = 0;
  readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }

  readByte(): number {
    if (this.index >= this.data.length) throw new Error("kiwi: index out of bounds");
    return this.data[this.index++]!;
  }

  readByteArray(): Uint8Array {
    const length = this.readVarUint();
    const end = this.index + length;
    if (end > this.data.length) throw new Error("kiwi: byte array out of bounds");
    const result = this.data.slice(this.index, end);
    this.index = end;
    return result;
  }

  readVarFloat(): number {
    const data = this.data;
    const index = this.index;
    if (index >= data.length) throw new Error("kiwi: index out of bounds");
    const first = data[index]!;
    if (first === 0) {
      this.index = index + 1;
      return 0;
    }
    if (index + 4 > data.length) throw new Error("kiwi: index out of bounds");
    let bits =
      first | (data[index + 1]! << 8) | (data[index + 2]! << 16) | (data[index + 3]! << 24);
    this.index = index + 4;
    bits = (bits << 23) | (bits >>> 9);
    int32[0] = bits;
    return float32[0]!;
  }

  readVarUint(): number {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.readByte();
      value |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128 && shift < 35);
    return value >>> 0;
  }

  readVarInt(): number {
    const value = this.readVarUint() | 0;
    return value & 1 ? ~(value >>> 1) : value >>> 1;
  }

  /** 64-bit varints come back as numbers; precision past 2^53 is not needed here. */
  readVarUint64(): number {
    let value = 0;
    let scale = 1;
    let byte: number;
    let shift = 0;
    while ((byte = this.readByte()) & 128 && shift < 56) {
      value += (byte & 127) * scale;
      scale *= 128;
      shift += 7;
    }
    return value + byte * scale;
  }

  readVarInt64(): number {
    const value = this.readVarUint64();
    const half = Math.floor(value / 2);
    return value % 2 ? -half - 1 : half;
  }

  readString(): string {
    const data = this.data;
    const start = this.index;
    let end = start;
    while (end < data.length && data[end] !== 0) end++;
    if (end >= data.length) throw new Error("kiwi: unterminated string");
    this.index = end + 1;
    return utf8.decode(data.subarray(start, end));
  }
}

export function decodeKiwiSchema(bytes: Uint8Array): KiwiSchema {
  const reader = new KiwiReader(bytes);
  const definitionCount = reader.readVarUint();
  const raw: Array<{
    name: string;
    kind: (typeof DEFINITION_KINDS)[number];
    fields: Array<{ name: string; type: number; isArray: boolean; value: number }>;
  }> = [];
  for (let i = 0; i < definitionCount; i++) {
    const name = reader.readString();
    const kind = DEFINITION_KINDS[reader.readByte()];
    if (!kind) throw new Error(`kiwi: invalid definition kind for ${name}`);
    const fieldCount = reader.readVarUint();
    const fields = [];
    for (let j = 0; j < fieldCount; j++) {
      const fieldName = reader.readString();
      const type = reader.readVarInt();
      const isArray = (reader.readByte() & 1) === 1;
      const value = reader.readVarUint();
      fields.push({ name: fieldName, type, isArray, value });
    }
    raw.push({ name, kind, fields });
  }
  return {
    definitions: raw.map((definition) => ({
      name: definition.name,
      kind: definition.kind,
      fields: definition.fields.map((field) => {
        let type: string | null = null;
        if (definition.kind !== "ENUM") {
          if (field.type < 0) {
            type = BUILTIN_TYPES[~field.type] ?? null;
          } else {
            type = raw[field.type]?.name ?? null;
          }
          if (type === null)
            throw new Error(`kiwi: invalid type for ${definition.name}.${field.name}`);
        }
        return { name: field.name, type, isArray: field.isArray, value: field.value };
      }),
    })),
  };
}

type Decode = (reader: KiwiReader) => unknown;

/**
 * Builds closure decoders for every definition and decodes `rootType` from
 * `bytes`. Unknown message fields abort the decode, like kiwi itself, since
 * the following bytes cannot be interpreted.
 */
export function decodeKiwiMessage(
  schema: KiwiSchema,
  rootType: string,
  bytes: Uint8Array,
): unknown {
  const byName = new Map(schema.definitions.map((definition) => [definition.name, definition]));
  const decoders = new Map<string, Decode>();

  const valueDecoder = (type: string): Decode => {
    switch (type) {
      case "bool":
        return (reader) => reader.readByte() !== 0;
      case "byte":
        return (reader) => reader.readByte();
      case "int":
        return (reader) => reader.readVarInt();
      case "uint":
        return (reader) => reader.readVarUint();
      case "float":
        return (reader) => reader.readVarFloat();
      case "string":
        return (reader) => reader.readString();
      case "int64":
        return (reader) => reader.readVarInt64();
      case "uint64":
        return (reader) => reader.readVarUint64();
      default:
        return (reader) => decoderFor(type)(reader);
    }
  };

  const fieldDecoder = (field: KiwiField): Decode => {
    const type = field.type!;
    if (!field.isArray) return valueDecoder(type);
    if (type === "byte") return (reader) => reader.readByteArray();
    const item = valueDecoder(type);
    return (reader) => {
      const length = reader.readVarUint();
      // Items that read bytes are bounded by the data; empty structs need their own cap.
      const values: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const start = reader.index;
        values.push(item(reader));
        if (reader.index === start && ++reader.emptyItems > MAX_EMPTY_ITEMS) {
          throw new Error("kiwi: too many empty array items");
        }
      }
      return values;
    };
  };

  const decoderFor = (name: string): Decode => {
    const cached = decoders.get(name);
    if (cached) return cached;
    const definition = byName.get(name);
    if (!definition) throw new Error(`kiwi: unknown type ${name}`);
    let decode: Decode;
    if (definition.kind === "ENUM") {
      const names = new Map(definition.fields.map((field) => [field.value, field.name]));
      decode = (reader) => {
        const value = reader.readVarUint();
        return names.get(value) ?? value;
      };
    } else if (definition.kind === "STRUCT") {
      let fields: Array<[string, Decode]> | null = null;
      decode = (reader) => {
        fields ??= definition.fields.map((field) => [field.name, fieldDecoder(field)]);
        const result: Record<string, unknown> = {};
        for (const [fieldName, read] of fields) result[fieldName] = read(reader);
        return result;
      };
    } else {
      let fields: Map<number, [string, Decode]> | null = null;
      decode = (reader) => {
        fields ??= new Map(
          definition.fields.map((field) => [field.value, [field.name, fieldDecoder(field)]]),
        );
        const result: Record<string, unknown> = {};
        for (;;) {
          const tag = reader.readVarUint();
          if (tag === 0) return result;
          const entry = fields.get(tag);
          if (!entry) throw new Error(`kiwi: unknown field ${tag} in ${name}`);
          result[entry[0]] = entry[1](reader);
        }
      };
    }
    decoders.set(name, decode);
    return decode;
  };

  return decoderFor(rootType)(new KiwiReader(bytes));
}
