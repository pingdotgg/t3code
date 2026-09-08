import type * as rdsdata from "@distilled.cloud/aws/rds-data";

/**
 * JS value → Data API `SqlParameter` marshalling, matching the Postgres
 * wire expectations: integers as `longValue`, floats as `doubleValue`,
 * `Date`s as `TIMESTAMP`-hinted strings, `Uint8Array` as blobs, and
 * anything else JSON-stringified.
 */
export const toSqlParameter = (
  name: string,
  value: unknown,
): rdsdata.SqlParameter => {
  if (value === null || value === undefined) {
    return { name, value: { isNull: true } };
  }
  if (typeof value === "string") {
    return { name, value: { stringValue: value } };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { name, value: { longValue: value } }
      : { name, value: { doubleValue: value } };
  }
  if (typeof value === "bigint") {
    return { name, value: { longValue: Number(value) } };
  }
  if (typeof value === "boolean") {
    return { name, value: { booleanValue: value } };
  }
  if (value instanceof Date) {
    return {
      name,
      typeHint: "TIMESTAMP",
      value: {
        stringValue: value.toISOString().replace("T", " ").replace("Z", ""),
      },
    };
  }
  if (value instanceof Uint8Array) {
    return { name, value: { blobValue: value } as rdsdata.Field };
  }
  return { name, value: { stringValue: JSON.stringify(value) } };
};

const TIMESTAMP_TYPES = new Set([
  "timestamp",
  "timestamptz",
  "date",
  "datetime",
]);

/**
 * Data API `Field` → JS value. Timestamp-typed columns (per the response's
 * `columnMetadata.typeName`) revive as `Date`s — the Data API returns UTC
 * timestamps as `"YYYY-MM-DD HH:MM:SS[.FFF]"` strings.
 */
export const fromField = (
  field: rdsdata.Field,
  typeName: string | undefined,
): unknown => {
  const f = field as {
    stringValue?: string;
    longValue?: number;
    doubleValue?: number;
    booleanValue?: boolean;
    blobValue?: unknown;
    isNull?: boolean;
  };
  if (f.isNull) {
    return null;
  }
  if (f.stringValue !== undefined) {
    if (typeName !== undefined && TIMESTAMP_TYPES.has(typeName.toLowerCase())) {
      const iso = f.stringValue.replace(" ", "T");
      return new Date(/[Z+]/.test(iso.slice(10)) ? iso : `${iso}Z`);
    }
    return f.stringValue;
  }
  if (f.longValue !== undefined) return f.longValue;
  if (f.doubleValue !== undefined) return f.doubleValue;
  if (f.booleanValue !== undefined) return f.booleanValue;
  if (f.blobValue !== undefined) return f.blobValue;
  return null;
};

/**
 * Map an `executeStatement` response (with `includeResultMetadata: true`)
 * to rows keyed by column label.
 */
export const toRows = (response: {
  records?: rdsdata.Field[][];
  columnMetadata?: rdsdata.ColumnMetadata[];
}): Record<string, unknown>[] => {
  const metadata = response.columnMetadata ?? [];
  return (response.records ?? []).map((record) => {
    const row: Record<string, unknown> = {};
    record.forEach((field, index) => {
      const column = metadata[index];
      row[column?.label ?? column?.name ?? `column${index}`] = fromField(
        field,
        column?.typeName ?? undefined,
      );
    });
    return row;
  });
};
