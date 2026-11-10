export const MAX_BYTES = 10 * 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UploadInput {
  filename: string;
  contentType: string;
  size: number;
}

export interface UploadRow {
  id: string;
  filename: string;
  object_key: string;
  content_type: string;
  expected_bytes: number | string;
  actual_bytes: number | string | null;
  status: "awaiting_upload" | "ready" | "rejected";
  created_at: string;
}

// Effect Postgres decodes int8 as bigint and timestamps as epoch milliseconds.
export interface UploadRecord extends Omit<
  UploadRow,
  "expected_bytes" | "actual_bytes" | "created_at"
> {
  expected_bytes: bigint;
  actual_bytes: bigint | null;
  created_at: number;
}

export function serializeUploadRow(row: UploadRecord): UploadRow {
  return {
    ...row,
    expected_bytes: row.expected_bytes.toString(),
    actual_bytes: row.actual_bytes?.toString() ?? null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export function parseUpload(value: unknown): UploadInput | undefined {
  if (typeof value !== "object" || value === null) return;
  const { filename, contentType, size } = value as Record<string, unknown>;
  if (
    typeof filename !== "string" ||
    !filename.trim() ||
    filename.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(filename)
  )
    return;
  if (typeof contentType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) return;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES)
    return;
  return { filename, contentType, size };
}

export function objectKey(owner: string, id: string) {
  return `incoming/${encodeURIComponent(owner)}/${id}`;
}

export function corsHeaders(
  origin: string | null,
  allowed: string | undefined,
): Record<string, string> | undefined {
  if (origin && allowed !== "*") {
    if (!allowed) return;
    try {
      if (origin !== new URL(allowed).origin) return;
    } catch {
      return;
    }
  }
  return {
    ...(origin ? { "access-control-allow-origin": allowed === "*" ? "*" : origin } : {}),
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "cache-control": "no-store",
    vary: "Origin",
  };
}
