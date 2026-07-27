function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** Uses arguments immediately and result counts only when output is already available. */
export function mariaDbPreview(
  toolName: string | null,
  input: unknown,
  output: unknown,
  failed: boolean,
) {
  const parts = toolName?.toLowerCase().split(/[./]|__/u);
  if (!parts?.includes("mariadb")) return undefined;
  const tool = parts.at(-1);
  const args = record(input);
  const payload = record(output);
  let result = record(payload?.structuredContent);
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  for (const block of blocks) {
    if (result) break;
    const value = text(record(block)?.text);
    if (!value) continue;
    try {
      result = record(JSON.parse(value));
    } catch {
      /* Non-JSON text is still useful for errors. */
    }
  }
  const count = (value: number, name: string) =>
    `${value.toLocaleString()} ${name}${value === 1 ? "" : "s"}`;
  const join = (...values: (string | undefined)[]) =>
    values.filter(Boolean).join(" · ") || undefined;
  const arrayCount = (value: unknown, name: string) =>
    Array.isArray(value) ? count(value.length, name) : undefined;
  const database = text(result?.database) ?? text(args?.database);
  switch (tool) {
    case "list_connections":
      return join(
        arrayCount(result?.connections, "connection"),
        text(result?.active) ? `${text(result?.active)} active` : undefined,
      );
    case "open_connection":
      return join(
        text(result?.opened) ?? text(args?.server),
        database,
        typeof result?.readOnly === "boolean"
          ? result.readOnly
            ? "read-only"
            : "read-write"
          : undefined,
      );
    case "close_connection":
      return text(result?.closed);
    case "list_databases":
      return arrayCount(result?.databases, "database");
    case "list_tables":
      return join(database, arrayCount(result?.tables, "table"));
    case "describe_table": {
      const table = text(result?.table) ?? text(args?.table);
      return join(
        table ? (database ? `${database}.${table}` : table) : database,
        arrayCount(result?.columns, "column"),
      );
    }
    case "execute_sql": {
      const sql = text(args?.sql)?.replace(/\s+/gu, " ").slice(0, 72);
      if (failed) {
        const error = blocks.map((block) => text(record(block)?.text)).find(Boolean);
        return error?.replace(/\s+/gu, " ").slice(0, 140) ?? sql;
      }
      return join(
        sql,
        arrayCount(result?.rows, "row") ??
          (typeof result?.affectedRows === "number"
            ? `${count(result.affectedRows, "row")} affected`
            : undefined),
      );
    }
    default:
      return undefined;
  }
}
