import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";

/**
 * Scalar field types accepted by a structured stream schema.
 */
export type StreamFieldType =
  | "int32"
  | "int64"
  | "float32"
  | "float64"
  | "bool"
  | "string"
  | "binary"
  | "json";

/**
 * Timestamp precision of a `timestamp` stream field.
 */
export type StreamTimestampUnit = "second" | "millisecond" | "microsecond" | "nanosecond";

/**
 * The type of a stream field (or list element), without its name.
 */
export type StreamFieldItem =
  | {
      /** Scalar field type. */
      type: StreamFieldType;
      /** Whether the value must be present. */
      required?: boolean;
    }
  | {
      /** Timestamp field type. */
      type: "timestamp";
      /** Whether the value must be present. */
      required?: boolean;
      /**
       * Precision of numeric timestamps.
       * @default "millisecond"
       */
      unit?: StreamTimestampUnit;
    }
  | {
      /** List (array) field type. */
      type: "list";
      /** Whether the value must be present. */
      required?: boolean;
      /** Type of every element of the list. */
      items: StreamFieldItem;
    }
  | {
      /** Nested object field type. */
      type: "struct";
      /** Whether the value must be present. */
      required?: boolean;
      /** Fields of the nested object. */
      fields: StreamField[];
    };

/**
 * A single named field of a structured stream schema. `timestamp` fields
 * additionally accept a `unit`, `list` fields an `items` type and
 * `struct` fields nested `fields`.
 */
export type StreamField = StreamFieldItem & {
  /** Field name as it appears in ingested events. */
  name: string;
  /** Whether the field must be present in every event. */
  required?: boolean;
  /** Name to expose to SQL when it differs from `name`. */
  sqlName?: string;
  /** Metadata key the field is populated from instead of the event body. */
  metadataKey?: string;
};

/**
 * A structured stream schema as an explicit field list.
 */
export interface StreamFieldsSchema {
  /** Fields of the structured schema. */
  fields: StreamField[];
}

/**
 * Annotation key that overrides the stream field type derived from an
 * Effect Schema, e.g. to store a number as `int32` or `float32`:
 *
 * ```typescript
 * Schema.Number.annotate({ [StreamFieldTypeAnnotation]: "float32" })
 * ```
 */
export const StreamFieldTypeAnnotation = "pipelinesFieldType" as const;

/**
 * Raised when an Effect Schema passed as a stream `schema` has no
 * Pipelines representation (e.g. a union of different types).
 */
export class StreamSchemaUnsupported extends Data.TaggedError(
  "Cloudflare.Pipelines.StreamSchemaUnsupported",
)<{
  message: string;
  path: string;
}> {}

const unsupported = (path: string, what: string) =>
  new StreamSchemaUnsupported({
    path,
    message:
      `Cloudflare.Pipelines.Stream: field '${path || "<root>"}' is ${what}, ` +
      "which has no Pipelines stream field type. Use a field list or annotate the field " +
      `with { ${StreamFieldTypeAnnotation}: "json" }.`,
  });

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

interface CheckRep {
  id: string;
  payload: unknown;
}

const checkReps = (ast: AST.AST): CheckRep[] => {
  const out: CheckRep[] = [];
  const visit = (check: unknown) => {
    const c = check as {
      annotations?: { representation?: CheckRep };
      checks?: readonly unknown[];
    };
    if (c.annotations?.representation?.id) out.push(c.annotations.representation);
    c.checks?.forEach(visit);
  };
  ((ast as { checks?: readonly unknown[] }).checks ?? []).forEach(visit);
  return out;
};

const annotationOverride = (ast: AST.AST): StreamFieldType | "timestamp" | undefined => {
  const read = (annotations: unknown) =>
    (annotations as Record<string, unknown> | undefined)?.[StreamFieldTypeAnnotation];
  const candidates = [
    read((ast as { annotations?: unknown }).annotations),
    ...((ast as { checks?: readonly { annotations?: unknown }[] }).checks ?? []).map((c) =>
      read(c.annotations),
    ),
  ];
  const found = candidates.find((v) => typeof v === "string");
  return found as StreamFieldType | "timestamp" | undefined;
};

const numberType = (ast: AST.AST): StreamFieldType => {
  const reps = checkReps(ast);
  if (!reps.some((r) => r.id === "effect/schema/isInt")) return "float64";
  const fitsInt32 = reps.some((r) => {
    if (r.id !== "effect/schema/isBetween") return false;
    const p = r.payload as { minimum?: number; maximum?: number } | null;
    return (
      p?.minimum !== undefined &&
      p?.maximum !== undefined &&
      p.minimum >= INT32_MIN &&
      p.maximum <= INT32_MAX
    );
  });
  return fitsInt32 ? "int32" : "int64";
};

const isNullish = (ast: AST.AST) =>
  ast._tag === "Null" || ast._tag === "Undefined" || ast._tag === "Void";

const literalType = (value: unknown): StreamFieldType | undefined =>
  typeof value === "string"
    ? "string"
    : typeof value === "boolean"
      ? "bool"
      : typeof value === "number"
        ? Number.isInteger(value)
          ? "int64"
          : "float64"
        : undefined;

/**
 * Derive the stream field type of one (encoded-side) AST node. Returns the
 * item plus whether the value may be absent (nullable union members).
 */
const toItem = (ast: AST.AST, path: string): { item: StreamFieldItem; nullable: boolean } => {
  const override = annotationOverride(ast);
  if (override) {
    return { item: { type: override } as StreamFieldItem, nullable: false };
  }
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return { item: { type: "string" }, nullable: false };
    case "Number":
      return { item: { type: numberType(ast) }, nullable: false };
    case "Boolean":
      return { item: { type: "bool" }, nullable: false };
    case "Literal": {
      const type = literalType(ast.literal);
      if (!type) throw unsupported(path, `the literal ${String(ast.literal)}`);
      return { item: { type }, nullable: false };
    }
    case "Enum": {
      const types = new Set(
        (ast as unknown as { enums: ReadonlyArray<readonly [string, unknown]> }).enums.map(
          ([, v]) => literalType(v),
        ),
      );
      const [type] = [...types];
      if (types.size !== 1 || !type) throw unsupported(path, "a mixed enum");
      return { item: { type }, nullable: false };
    }
    case "Unknown":
    case "Any":
    case "ObjectKeyword":
      return { item: { type: "json" }, nullable: false };
    case "Declaration": {
      const id = (ast.annotations?.representation as CheckRep | undefined)?.id;
      if (id === "effect/schema/Date") return { item: { type: "timestamp" }, nullable: false };
      if (id === "effect/schema/Uint8Array") return { item: { type: "binary" }, nullable: false };
      if (id === "effect/schema/Json") return { item: { type: "json" }, nullable: false };
      throw unsupported(path, `a ${AST.resolveIdentifier(ast) ?? "declared"} value`);
    }
    case "Arrays": {
      if (ast.elements.length > 0 || ast.rest.length !== 1) {
        throw unsupported(path, "a tuple");
      }
      const element = toItem(ast.rest[0]!, `${path}[]`);
      return {
        item: {
          type: "list",
          items: element.nullable ? { ...element.item, required: false } : element.item,
        },
        nullable: false,
      };
    }
    case "Objects": {
      if (ast.indexSignatures.length > 0 || ast.propertySignatures.length === 0) {
        // Records and empty objects carry arbitrary keys — store as JSON.
        return { item: { type: "json" }, nullable: false };
      }
      return {
        item: { type: "struct", fields: toFields(ast, path) },
        nullable: false,
      };
    }
    case "Union": {
      const members = ast.types.filter((t) => !isNullish(t));
      const nullable = members.length !== ast.types.length;
      if (members.length === 1) {
        return { item: toItem(members[0]!, path).item, nullable };
      }
      // A union of same-typed literals (e.g. `Schema.Literals(["a","b"])`).
      if (members.length > 0 && members.every((m) => m._tag === "Literal")) {
        const types = new Set(members.map((m) => literalType((m as AST.Literal).literal)));
        const [type] = [...types];
        if (types.size === 1 && type) return { item: { type }, nullable };
      }
      throw unsupported(path, "a union of different types");
    }
    case "Suspend":
      throw unsupported(path, "a recursive schema");
    default:
      throw unsupported(path, `of type ${ast._tag}`);
  }
};

const toFields = (ast: AST.Objects, path: string): StreamField[] =>
  ast.propertySignatures.map((ps) => {
    const name = String(ps.name);
    const fieldPath = path ? `${path}.${name}` : name;
    const { item, nullable } = toItem(ps.type, fieldPath);
    const optional = AST.isOptional(ps.type);
    return {
      ...item,
      name,
      required: !(optional || nullable),
    } as StreamField;
  });

/**
 * Returns true if `value` is an Effect Schema (rather than a field list).
 */
export const isEffectSchema = (value: unknown): value is Schema.Top => Schema.isSchema(value);

/**
 * Convert an Effect Schema (`Schema.Struct` / `Schema.Class`) into the
 * Pipelines stream field list. The schema's **encoded** side is used, so
 * transformations (e.g. `NumberFromString`) map to their wire type, and
 * records are sent with `Schema.toCodecJson(schema)`:
 *
 * - `String` → `string`, `Boolean` → `bool`
 * - `Number` → `float64`, `Int` → `int64` (`int32` when bounded to 32 bits)
 * - `Date` → `timestamp`, `Uint8Array` → `binary`
 * - `Array` → `list`, `Struct` / `Class` → `struct`
 * - `Record` / `Unknown` / `Json` → `json`
 * - optional or nullable fields → `required: false`
 *
 * Unions of different types, tuples and recursive schemas have no stream
 * representation and throw {@link StreamSchemaUnsupported}. Override any
 * field's type with the {@link StreamFieldTypeAnnotation} annotation.
 */
export const streamFieldsFromSchema = (schema: Schema.Top): StreamField[] => {
  const encoded = AST.toEncoded(schema.ast);
  if (encoded._tag !== "Objects" || encoded.propertySignatures.length === 0) {
    throw unsupported("", "not a Struct or Class with fields");
  }
  return toFields(encoded, "");
};

/**
 * Resolve a stream `schema` prop (field list or Effect Schema) to the
 * field-list form persisted in state and sent to Cloudflare.
 */
export const resolveStreamSchema = (
  schema: StreamFieldsSchema | Schema.Top | undefined,
): StreamFieldsSchema | undefined => {
  if (schema === undefined) return undefined;
  if (isEffectSchema(schema)) return { fields: streamFieldsFromSchema(schema) };
  return schema as StreamFieldsSchema;
};

/**
 * Canonical (default-filled, key-ordered) form of a field item, so
 * equivalent spellings compare equal.
 */
const canonicalItem = (item: StreamFieldItem): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    type: item.type,
    required: item.required ?? false,
  };
  if (item.type === "timestamp") base.unit = item.unit ?? "millisecond";
  if (item.type === "list") base.items = canonicalItem(item.items);
  if (item.type === "struct") base.fields = canonicalStreamFields(item.fields);
  return base;
};

/**
 * Canonical form of a field list: defaults filled in (`required: false`,
 * `unit: "millisecond"`), absent optional keys dropped.
 */
export const canonicalStreamFields = (fields: ReadonlyArray<StreamField>): unknown[] =>
  fields.map((f) => {
    const out: Record<string, unknown> = { name: f.name, ...canonicalItem(f) };
    if (f.sqlName !== undefined) out.sqlName = f.sqlName;
    if (f.metadataKey !== undefined) out.metadataKey = f.metadataKey;
    return out;
  });
