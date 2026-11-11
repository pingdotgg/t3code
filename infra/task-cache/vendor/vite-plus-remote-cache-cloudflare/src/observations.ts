// @effect-diagnostics globalDate:off - vendored upstream protocol, not an Effect service.
export class Observations {
  request_bytes = 0;
  d1_rows_read = 0;
  d1_rows_written = 0;
  d1_ms = 0;
  d1_queries = 0;
  d1_storage_bytes = 0;
  r2_operations = 0;

  toJSON() {
    return {
      request_bytes: this.request_bytes,
      d1_rows_read: this.d1_rows_read,
      d1_rows_written: this.d1_rows_written,
      d1_ms: this.d1_ms,
      d1_queries: this.d1_queries,
      d1_storage_bytes: this.d1_storage_bytes,
      r2_operations: this.r2_operations,
    };
  }
}

export async function measured<T extends D1Result | D1Result[]>(
  operation: Promise<T>,
  stats?: Observations,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await operation;
    if (stats)
      for (const item of Array.isArray(result) ? result : [result]) {
        stats.d1_rows_read += item.meta.rows_read;
        stats.d1_rows_written += item.meta.rows_written;
        stats.d1_storage_bytes = item.meta.size_after;
        stats.d1_queries++;
      }
    return result;
  } finally {
    if (stats) stats.d1_ms += Date.now() - start;
  }
}
