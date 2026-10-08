import type * as bigquery from "@distilled.cloud/gcp/bigquery_v2";

/**
 * Codec between BigQuery REST row payloads and plain JavaScript rows.
 * NOT exported from `index.ts`.
 *
 * Decoding (driven by the table / result schema, with
 * `formatOptions.useInt64Timestamp` requested): `INTEGER` → `number`
 * (`bigint` beyond the safe range), `FLOAT` → `number`, `BOOLEAN` →
 * `boolean`, `TIMESTAMP` → `Date`, `BYTES` → `Uint8Array`, `JSON` → parsed
 * value, `RECORD` → object, `REPEATED` → array, `NULL` → `null`. `NUMERIC`,
 * `BIGNUMERIC`, `DATE`, `TIME`, `DATETIME`, `GEOGRAPHY`, and everything else
 * stay strings.
 */

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const toInteger = (value: string): number | bigint => {
  const big = BigInt(value);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) &&
    big <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(big)
    : big;
};

const isCell = (value: unknown): value is { v?: unknown } =>
  typeof value === "object" && value !== null && "v" in value;

const decodeScalar = (
  field: bigquery.TableFieldSchema,
  value: unknown,
): unknown => {
  if (value === null || value === undefined) return null;
  switch ((field.type ?? "STRING").toUpperCase()) {
    case "RECORD":
    case "STRUCT":
      return decodeRow(
        field.fields ?? [],
        (value as { f?: bigquery.TableCell[] }).f,
      );
  }
  if (typeof value !== "string") return value;
  switch ((field.type ?? "STRING").toUpperCase()) {
    case "INTEGER":
    case "INT64":
      return toInteger(value);
    case "FLOAT":
    case "FLOAT64":
      return Number(value);
    case "BOOLEAN":
    case "BOOL":
      return value === "true";
    case "TIMESTAMP":
      // Int64 microseconds since the epoch (useInt64Timestamp); fall back
      // to the float-seconds wire format.
      return /^-?\d+$/.test(value)
        ? new Date(Number(BigInt(value) / BigInt(1000)))
        : new Date(Number(value) * 1000);
    case "BYTES":
      return fromBase64(value);
    case "JSON":
      return JSON.parse(value);
    default:
      return value;
  }
};

const decodeCell = (field: bigquery.TableFieldSchema, value: unknown) =>
  (field.mode ?? "").toUpperCase() === "REPEATED"
    ? (Array.isArray(value) ? value : []).map((item) =>
        decodeScalar(field, isCell(item) ? item.v : item),
      )
    : decodeScalar(field, value);

export const decodeRow = (
  fields: ReadonlyArray<bigquery.TableFieldSchema>,
  cells: ReadonlyArray<bigquery.TableCell> | undefined,
): Record<string, unknown> => {
  const row: Record<string, unknown> = {};
  fields.forEach((field, index) => {
    row[field.name ?? `f${index}`] = decodeCell(field, cells?.[index]?.v);
  });
  return row;
};

export const decodeRows = (
  schema: bigquery.TableSchema | undefined,
  rows: ReadonlyArray<bigquery.TableRow> | undefined,
): Record<string, unknown>[] =>
  (rows ?? []).map((row) => decodeRow(schema?.fields ?? [], row.f));

/** Encode a plain JS value for `tabledata.insertAll` JSON rows. */
export const encodeJson = (value: unknown): unknown => {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return toBase64(value);
  if (Array.isArray(value)) return value.map(encodeJson);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = encodeJson(item);
    }
    return out;
  }
  return value;
};

/** Encode one row for `tabledata.insertAll`; `undefined` keys are dropped. */
export const encodeRow = (
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = encodeJson(value);
  }
  return out;
};

/** Named query parameter for a scalar JS value. */
export const queryParameter = (
  name: string,
  value: string | number | boolean,
): bigquery.QueryParameter => ({
  name,
  parameterType: {
    type:
      typeof value === "boolean"
        ? "BOOL"
        : typeof value === "number"
          ? Number.isSafeInteger(value)
            ? "INT64"
            : "FLOAT64"
          : "STRING",
  },
  parameterValue: { value: String(value) },
});
