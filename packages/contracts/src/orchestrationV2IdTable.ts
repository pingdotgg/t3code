import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

/**
 * Opt-in wire form: on each record (top-level array element, top-level object, or `item`), values
 * under `id`, `*Id`, and `*Ids` index the response's `ids` table. Both peers must apply this exact
 * rule; changing it needs a new opt-in (`compactIds=2`, or a new `accept*` key over WS).
 */
type JsonObject = { [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isIdKey = (key: string) => key === "id" || key.endsWith("Id");
const isIdListKey = (key: string) => key.endsWith("Ids");

function internRecordIds(container: JsonObject, ids: Array<string | number>): JsonObject {
  const index = new Map<string | number, number>();
  const ref = (value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return value;
    let position = index.get(value);
    if (position === undefined) {
      position = ids.length;
      ids.push(value);
      index.set(value, position);
    }
    return position;
  };
  // Copies each record: unknown members can pass through encoding by reference.
  const internRecord = (record: JsonObject): JsonObject => {
    const out: JsonObject = {};
    for (const key in record) {
      const value = record[key];
      out[key] = isIdKey(key)
        ? ref(value)
        : isIdListKey(key) && Array.isArray(value)
          ? value.map(ref)
          : key === "item" && isObject(value)
            ? internRecord(value)
            : value;
    }
    return out;
  };
  const out: JsonObject = {};
  for (const key in container) {
    const value = container[key];
    out[key] = Array.isArray(value)
      ? value.map((record) => (isObject(record) ? internRecord(record) : record))
      : isObject(value)
        ? internRecord(value)
        : value;
  }
  return out;
}

// Mutates freshly parsed JSON in place; the client owns it and this avoids a copy.
function expandRecordIds(container: JsonObject, ids: ReadonlyArray<unknown>): void {
  const expandRecord = (record: JsonObject) => {
    for (const key in record) {
      const value = record[key];
      if (typeof value === "number") {
        if (isIdKey(key)) record[key] = ids[value];
      } else if (Array.isArray(value)) {
        if (isIdListKey(key)) {
          for (let i = 0; i < value.length; i++) {
            const entry = value[i];
            if (typeof entry === "number") value[i] = ids[entry];
          }
        }
      } else if (key === "item" && isObject(value)) {
        expandRecord(value);
      }
    }
  };
  for (const key in container) {
    const value = container[key];
    if (Array.isArray(value)) {
      for (const record of value) if (isObject(record)) expandRecord(record);
    } else if (isObject(value)) {
      expandRecord(value);
    }
  }
}

// `toCodecJson` turns `Schema.Unknown` into a recursive JSON check of the whole
// tree. The input is parsed JSON and the inner codec validates it anyway.
const ParsedJson = Schema.declare((_: unknown): _ is unknown => true, {
  toCodecJson: () => undefined,
});

/**
 * Adds the optional ID table to a snapshot-shaped schema. `container` returns the
 * key whose value holds the records, `null` when records sit at the top level, or
 * `undefined` when the value has no records (other stream item kinds).
 */
export const withRecordIdTable = <S extends Schema.Top>(
  schema: S,
  container: (value: JsonObject) => string | null | undefined,
) => {
  const codec = Schema.toCodecJson(schema);
  type Encoded = typeof codec.Encoded;
  return ParsedJson.pipe(
    Schema.decodeTo(codec, {
      decode: SchemaGetter.transform((raw: unknown): Encoded => {
        if (!isObject(raw) || !Array.isArray(raw.ids)) return raw as Encoded;
        // Consumed on the parsed object itself, so decoding it again is a no-op.
        const ids: ReadonlyArray<unknown> = raw.ids;
        delete raw.ids;
        const key = container(raw);
        const target = key === null ? raw : key === undefined ? undefined : raw[key];
        if (isObject(target)) expandRecordIds(target, ids);
        return raw as Encoded;
      }),
      encode: SchemaGetter.transform((encoded: Encoded): unknown => {
        if (!isObject(encoded) || encoded.idTable !== true) return encoded;
        const { idTable: _idTable, ...rest } = encoded;
        const key = container(rest);
        const ids: Array<string | number> = [];
        if (key === null) return { ...internRecordIds(rest, ids), ids };
        const target = key === undefined ? undefined : rest[key];
        if (key === undefined || !isObject(target)) return rest;
        return { ...rest, [key]: internRecordIds(target, ids), ids };
      }),
    }),
  );
};
