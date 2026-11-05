import type * as Iceberg from "@distilled.cloud/iceberg";
import * as Data from "effect/Data";
import * as S from "effect/Schema";
import * as AST from "effect/SchemaAST";
import type {
  TableColumn,
  TableColumnType,
  TablePrimitiveType,
  TableSchema,
  TableSchemaInput,
} from "../Table.ts";

/**
 * An Effect Schema (or column) that has no Iceberg representation.
 */
export class BasinTableSchemaUnsupported extends Data.TaggedError(
  "Cloudflare.Basin.TableSchemaUnsupported",
)<{
  message: string;
  path: string;
}> {}

const unsupported = (path: string, what: string) =>
  new BasinTableSchemaUnsupported({
    path,
    message: `Cloudflare.Basin.Table: column '${path || "<root>"}' is ${what}, which has no Iceberg type`,
  });

// ---------------------------------------------------------------------------
// Effect Schema → column descriptor
// ---------------------------------------------------------------------------

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

const hasCheck = (reps: CheckRep[], id: string) => reps.some((r) => r.id === `effect/schema/${id}`);

const numberType = (ast: AST.AST): TablePrimitiveType => {
  const reps = checkReps(ast);
  if (!hasCheck(reps, "isInt")) return "double";
  const fitsInt32 = reps.some((r) => {
    if (r.id !== "effect/schema/isBetween") return false;
    const p = r.payload as { minimum?: number; maximum?: number } | null;
    return (
      typeof p?.minimum === "number" &&
      typeof p?.maximum === "number" &&
      p.minimum >= INT32_MIN &&
      p.maximum <= INT32_MAX
    );
  });
  return fitsInt32 ? "int" : "long";
};

const representationId = (ast: AST.AST): string | undefined =>
  (ast.annotations as { representation?: { id?: string } } | undefined)?.representation?.id;

const descriptionOf = (ast: AST.AST): string | undefined => {
  const own = (ast.annotations as { description?: unknown } | undefined)?.description;
  if (typeof own === "string") return own;
  if (AST.isUnion(ast)) {
    for (const member of ast.types) {
      const d = (member.annotations as { description?: unknown } | undefined)?.description;
      if (typeof d === "string") return d;
    }
  }
  return undefined;
};

const NUMERIC_RANK: Record<string, number> = { int: 0, long: 1, double: 2 };

const columnTypeOf = (ast: AST.AST, path: string): { type: TableColumnType; nullable: boolean } => {
  switch (ast._tag) {
    case "Suspend":
      return columnTypeOf(ast.thunk(), path);
    case "Union": {
      const members = ast.types.filter(
        (t) => !(AST.isNull(t) || AST.isUndefined(t) || AST.isVoid(t)),
      );
      const nullable = members.length !== ast.types.length;
      if (members.length === 0) throw unsupported(path, "always null");
      const resolved = members.map((m) => columnTypeOf(m, path));
      const anyNullable = nullable || resolved.some((r) => r.nullable);
      if (resolved.length === 1) return { type: resolved[0]!.type, nullable: anyNullable };
      const types = resolved.map((r) => r.type);
      if (types.every((t) => typeof t === "string" && t in NUMERIC_RANK)) {
        const widest = types.reduce((a, b) =>
          NUMERIC_RANK[a as string]! >= NUMERIC_RANK[b as string]! ? a : b,
        );
        return { type: widest, nullable: anyNullable };
      }
      if (types.every((t) => typeof t === "string" && t === types[0])) {
        return { type: types[0]!, nullable: anyNullable };
      }
      throw unsupported(path, "a union of different types");
    }
    case "Literal": {
      const literal = ast.literal;
      if (typeof literal === "string") return { type: "string", nullable: false };
      if (typeof literal === "boolean") return { type: "boolean", nullable: false };
      if (typeof literal === "bigint") return { type: "long", nullable: false };
      return { type: Number.isInteger(literal) ? "long" : "double", nullable: false };
    }
    case "Enum": {
      const values = ast.enums.map(([, value]) => value);
      if (values.every((v) => typeof v === "string")) return { type: "string", nullable: false };
      if (values.every((v) => typeof v === "number")) return { type: "long", nullable: false };
      throw unsupported(path, "an enum mixing strings and numbers");
    }
    case "TemplateLiteral":
      return { type: "string", nullable: false };
    case "String":
      return {
        type: hasCheck(checkReps(ast), "isUUID") ? "uuid" : "string",
        nullable: false,
      };
    case "Number":
      return { type: numberType(ast), nullable: false };
    case "Boolean":
      return { type: "boolean", nullable: false };
    case "BigInt":
      return { type: "long", nullable: false };
    case "Declaration": {
      const rep = representationId(ast);
      if (rep === "effect/schema/Date" || rep === "effect/schema/DateTimeUtc") {
        return { type: "timestamptz", nullable: false };
      }
      if (rep === "effect/schema/Uint8Array") return { type: "binary", nullable: false };
      if (rep === "effect/schema/ReadonlyMap" && ast.typeParameters.length === 2) {
        return {
          type: mapTypeOf(ast.typeParameters[0]!, ast.typeParameters[1]!, path),
          nullable: false,
        };
      }
      if (rep === "effect/schema/ReadonlySet" && ast.typeParameters.length === 1) {
        return { type: listTypeOf(ast.typeParameters[0]!, path), nullable: false };
      }
      // Schema.Class / TaggedClass: a declaration over the struct of its fields.
      const [inner] = ast.typeParameters;
      if (ast.typeParameters.length === 1 && inner !== undefined && AST.isObjects(inner)) {
        return columnTypeOf(inner, path);
      }
      throw unsupported(path, `a declaration (${rep ?? "unknown"})`);
    }
    case "Objects": {
      if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 1) {
        const index = ast.indexSignatures[0]!;
        return { type: mapTypeOf(index.parameter, index.type, path), nullable: false };
      }
      if (ast.indexSignatures.length > 0) {
        throw unsupported(path, "a struct with an index signature");
      }
      return { type: { type: "struct", fields: structFieldsOf(ast, path) }, nullable: false };
    }
    case "Arrays": {
      if (ast.elements.length === 0 && ast.rest.length === 1) {
        return { type: listTypeOf(ast.rest[0]!, path), nullable: false };
      }
      throw unsupported(path, "a tuple");
    }
    default:
      throw unsupported(path, `of schema type '${ast._tag}'`);
  }
};

const listTypeOf = (element: AST.AST, path: string): TableColumnType => {
  const resolved = columnTypeOf(element, `${path}.element`);
  return { type: "list", element: resolved.type, elementRequired: !resolved.nullable };
};

const mapTypeOf = (key: AST.AST, value: AST.AST, path: string): TableColumnType => {
  const k = columnTypeOf(key, `${path}.key`);
  if (k.nullable) throw unsupported(`${path}.key`, "a nullable map key");
  const v = columnTypeOf(value, `${path}.value`);
  return { type: "map", key: k.type, value: v.type, valueRequired: !v.nullable };
};

const structFieldsOf = (ast: AST.Objects, path: string): TableColumn[] =>
  ast.propertySignatures.map((property) => {
    if (typeof property.name !== "string") {
      throw unsupported(path, "keyed by a symbol");
    }
    const columnPath = path ? `${path}.${property.name}` : property.name;
    const resolved = columnTypeOf(property.type, columnPath);
    const optional = AST.isOptional(property.type);
    const keyDoc = (property.type.context?.annotations as { description?: unknown } | undefined)
      ?.description;
    const doc = typeof keyDoc === "string" ? keyDoc : descriptionOf(property.type);
    return {
      name: property.name,
      type: resolved.type,
      required: !(optional || resolved.nullable),
      ...(doc !== undefined ? { doc } : {}),
    };
  });

/**
 * Convert an Effect Schema struct (or `Schema.Class`) into the plain column
 * descriptor persisted in Table props. Plain descriptors pass through.
 */
export const toTableSchema = (schema: TableSchemaInput): TableSchema => {
  if (!S.isSchema(schema)) return schema as TableSchema;
  const root = columnTypeOf(schema.ast, "").type;
  if (typeof root === "string" || root.type !== "struct") {
    throw unsupported("", "not a struct (a table schema must be a Struct or Class)");
  }
  return { fields: root.fields };
};

// ---------------------------------------------------------------------------
// Normalization + comparison
// ---------------------------------------------------------------------------

/** Canonical primitive spelling: lowercase, no whitespace. */
const normalizePrimitive = (t: string): string => t.replaceAll(/\s+/g, "").toLowerCase();

/** Fill defaults so two descriptors compare structurally. */
export const normalizeColumnType = (t: TableColumnType): TableColumnType => {
  if (typeof t === "string") return normalizePrimitive(t) as TablePrimitiveType;
  switch (t.type) {
    case "struct":
      return { type: "struct", fields: normalizeColumns(t.fields) };
    case "list":
      return {
        type: "list",
        element: normalizeColumnType(t.element),
        elementRequired: t.elementRequired ?? false,
      };
    case "map":
      return {
        type: "map",
        key: normalizeColumnType(t.key),
        value: normalizeColumnType(t.value),
        valueRequired: t.valueRequired ?? false,
      };
  }
};

export const normalizeColumns = (fields: readonly TableColumn[]): TableColumn[] =>
  fields.map((f) => ({
    name: f.name,
    type: normalizeColumnType(f.type),
    required: f.required ?? false,
    ...(f.doc ? { doc: f.doc } : {}),
  }));

/** Iceberg wire struct fields → column descriptors. */
export const fromIcebergFields = (fields: readonly Iceberg.StructField[]): TableColumn[] =>
  fields.map((f) => ({
    name: f.name,
    type: fromIcebergType(f.type),
    required: f.required,
    ...(f.doc ? { doc: f.doc } : {}),
  }));

const fromIcebergType = (t: Iceberg.Type): TableColumnType => {
  if (typeof t === "string") return normalizePrimitive(t) as TablePrimitiveType;
  switch (t.type) {
    case "struct":
      return { type: "struct", fields: fromIcebergFields((t as Iceberg.StructType).fields) };
    case "list": {
      const l = t as Iceberg.ListType;
      return {
        type: "list",
        element: fromIcebergType(l.element),
        elementRequired: l.element_required,
      };
    }
    case "map": {
      const m = t as Iceberg.MapType;
      return {
        type: "map",
        key: fromIcebergType(m.key),
        value: fromIcebergType(m.value),
        valueRequired: m.value_required,
      };
    }
    default:
      return normalizePrimitive(t.type) as TablePrimitiveType;
  }
};

const decimalOf = (t: string) => /^decimal\((\d+),(\d+)\)$/.exec(t);

/** Iceberg's legal in-place type promotions. */
const isPromotion = (from: string, to: string): boolean => {
  if (from === to) return true;
  if (from === "int" && to === "long") return true;
  if (from === "float" && to === "double") return true;
  const a = decimalOf(from);
  const b = decimalOf(to);
  return !!a && !!b && a[2] === b[2] && Number(b[1]) >= Number(a[1]);
};

const describe = (t: TableColumnType): string =>
  typeof t === "string" ? t : t.type === "struct" ? "struct" : t.type;

/**
 * Compare an observed (or previously declared) schema with the desired one
 * and list every change Iceberg cannot apply without rewriting or losing
 * data: dropped columns, new required columns, required-ness tightened, and
 * type changes other than Iceberg's promotions (int→long, float→double,
 * decimal precision widening).
 */
export const destructiveChanges = (
  observed: readonly TableColumn[],
  desired: readonly TableColumn[],
): string[] => {
  const reasons: string[] = [];
  compareFields("", normalizeColumns(observed), normalizeColumns(desired), reasons);
  return reasons;
};

const compareFields = (
  prefix: string,
  observed: TableColumn[],
  desired: TableColumn[],
  reasons: string[],
) => {
  for (const o of observed) {
    const path = `${prefix}${o.name}`;
    const d = desired.find((f) => f.name === o.name);
    if (!d) {
      reasons.push(`drops column '${path}'`);
      continue;
    }
    if (!o.required && d.required) reasons.push(`makes optional column '${path}' required`);
    compareTypes(path, o.type, d.type, reasons);
  }
  for (const d of desired) {
    if (d.required && !observed.some((f) => f.name === d.name)) {
      reasons.push(
        `adds required column '${prefix}${d.name}' (new columns must be optional so existing rows stay valid)`,
      );
    }
  }
};

const compareTypes = (path: string, o: TableColumnType, d: TableColumnType, reasons: string[]) => {
  if (typeof o === "string" || typeof d === "string") {
    if (typeof o === "string" && typeof d === "string" && isPromotion(o, d)) return;
    reasons.push(`changes the type of '${path}' from ${describe(o)} to ${describe(d)}`);
    return;
  }
  if (o.type !== d.type) {
    reasons.push(`changes the type of '${path}' from ${describe(o)} to ${describe(d)}`);
    return;
  }
  if (o.type === "struct" && d.type === "struct") {
    compareFields(`${path}.`, o.fields, d.fields, reasons);
  } else if (o.type === "list" && d.type === "list") {
    if (!o.elementRequired && d.elementRequired) {
      reasons.push(`makes the elements of '${path}' required`);
    }
    compareTypes(`${path}.element`, o.element, d.element, reasons);
  } else if (o.type === "map" && d.type === "map") {
    if (JSON.stringify(o.key) !== JSON.stringify(d.key)) {
      reasons.push(`changes the key type of map '${path}'`);
    }
    if (!o.valueRequired && d.valueRequired) {
      reasons.push(`makes the values of '${path}' required`);
    }
    compareTypes(`${path}.value`, o.value, d.value, reasons);
  }
};

// ---------------------------------------------------------------------------
// Field ids
// ---------------------------------------------------------------------------

/**
 * Build the Iceberg wire schema for `desired`, reusing the field ids of
 * columns that already exist in `observed` (matched by name at the same
 * nesting) and assigning fresh ids from `nextId` to new columns. Ids at one
 * struct level are assigned before descending, like Iceberg's own clients.
 */
export const assignFieldIds = (
  desired: readonly TableColumn[],
  observed: readonly Iceberg.StructField[] | undefined,
  nextId: () => number,
): Iceberg.StructField[] => {
  const normalized = normalizeColumns(desired);
  const matches = normalized.map((f) => observed?.find((o) => o.name === f.name));
  const ids = matches.map((m) => m?.id ?? nextId());
  return normalized.map((f, i) => ({
    id: ids[i]!,
    name: f.name,
    required: f.required ?? false,
    type: buildType(f.type, matches[i]?.type, nextId),
    ...(f.doc ? { doc: f.doc } : {}),
  }));
};

const buildType = (
  t: TableColumnType,
  observed: Iceberg.Type | undefined,
  nextId: () => number,
): Iceberg.Type => {
  if (typeof t === "string") return t;
  const obs = typeof observed === "object" ? observed : undefined;
  switch (t.type) {
    case "struct":
      return {
        type: "struct",
        fields: assignFieldIds(
          t.fields,
          obs?.type === "struct" ? (obs as Iceberg.StructType).fields : undefined,
          nextId,
        ),
      };
    case "list": {
      const ol = obs?.type === "list" ? (obs as Iceberg.ListType) : undefined;
      const elementId = ol?.element_id ?? nextId();
      return {
        type: "list",
        element_id: elementId,
        element: buildType(t.element, ol?.element, nextId),
        element_required: t.elementRequired ?? false,
      };
    }
    case "map": {
      const om = obs?.type === "map" ? (obs as Iceberg.MapType) : undefined;
      const keyId = om?.key_id ?? nextId();
      const valueId = om?.value_id ?? nextId();
      return {
        type: "map",
        key_id: keyId,
        key: buildType(t.key, om?.key, nextId),
        value_id: valueId,
        value: buildType(t.value, om?.value, nextId),
        value_required: t.valueRequired ?? false,
      };
    }
  }
};

/** Highest field id anywhere in a wire schema. */
export const maxFieldId = (fields: readonly Iceberg.StructField[]): number => {
  let max = 0;
  const visitType = (t: Iceberg.Type) => {
    if (typeof t === "string") return;
    if (t.type === "struct") visitFields((t as Iceberg.StructType).fields);
    else if (t.type === "list") {
      const l = t as Iceberg.ListType;
      max = Math.max(max, l.element_id);
      visitType(l.element);
    } else if (t.type === "map") {
      const m = t as Iceberg.MapType;
      max = Math.max(max, m.key_id, m.value_id);
      visitType(m.key);
      visitType(m.value);
    }
  };
  const visitFields = (fs: readonly Iceberg.StructField[]) => {
    for (const f of fs) {
      max = Math.max(max, f.id);
      visitType(f.type);
    }
  };
  visitFields(fields);
  return max;
};

/** Dotted column path → field id, for partition source resolution. */
export const fieldIdsByPath = (fields: readonly Iceberg.StructField[]): Map<string, number> => {
  const out = new Map<string, number>();
  const visit = (prefix: string, fs: readonly Iceberg.StructField[]) => {
    for (const f of fs) {
      const path = `${prefix}${f.name}`;
      out.set(path, f.id);
      if (typeof f.type === "object" && f.type.type === "struct") {
        visit(`${path}.`, (f.type as Iceberg.StructType).fields);
      }
    }
  };
  visit("", fields);
  return out;
};

// ---------------------------------------------------------------------------
// Partition specs
// ---------------------------------------------------------------------------

export interface PartitionTerm {
  /** Dotted source column path. */
  column: string;
  /** Iceberg transform, e.g. `identity`, `day`, `bucket[16]`. */
  transform: string;
}

const UNARY: Record<string, string> = {
  identity: "identity",
  year: "year",
  years: "year",
  month: "month",
  months: "month",
  day: "day",
  days: "day",
  date: "day",
  hour: "hour",
  hours: "hour",
  void: "void",
};

const COLUMN = "([A-Za-z_][\\w]*(?:\\.[A-Za-z_][\\w]*)*)";
const UNARY_RE = new RegExp(`^(\\w+)\\(${COLUMN}\\)$`);
const BRACKET_RE = new RegExp(`^(bucket|truncate)\\[(\\d+)\\]\\(${COLUMN}\\)$`);
const ARG_RE = new RegExp(`^(bucket|truncate)\\((\\d+),${COLUMN}\\)$`);
const BARE_RE = new RegExp(`^${COLUMN}$`);

/**
 * Parse a `partitionBy` term: `col`, `identity(col)`, `year|month|day|hour(col)`,
 * `bucket[N](col)` / `bucket(N, col)`, `truncate[N](col)` / `truncate(N, col)`.
 */
export const parsePartitionTerm = (term: string): PartitionTerm => {
  const t = term.replaceAll(/\s+/g, "");
  let m = BRACKET_RE.exec(t) ?? ARG_RE.exec(t);
  if (m) return { column: m[3]!, transform: `${m[1]}[${m[2]}]` };
  m = UNARY_RE.exec(t);
  if (m && UNARY[m[1]!.toLowerCase()]) {
    return { column: m[2]!, transform: UNARY[m[1]!.toLowerCase()]! };
  }
  m = BARE_RE.exec(t);
  if (m) return { column: m[1]!, transform: "identity" };
  throw new BasinTableSchemaUnsupported({
    path: term,
    message: `Cloudflare.Basin.Table: cannot parse partition term '${term}' (expected e.g. 'day(at)', 'bucket[16](id)', 'region')`,
  });
};

export const partitionFieldName = ({ column, transform }: PartitionTerm): string => {
  const base = column.replaceAll(".", "_");
  if (transform === "identity") return base;
  if (transform.startsWith("bucket")) return `${base}_bucket`;
  if (transform.startsWith("truncate")) return `${base}_trunc`;
  return `${base}_${transform}`;
};

export const samePartitionTerms = (a: readonly PartitionTerm[], b: readonly PartitionTerm[]) =>
  a.length === b.length &&
  a.every((t, i) => t.column === b[i]!.column && t.transform === b[i]!.transform);
