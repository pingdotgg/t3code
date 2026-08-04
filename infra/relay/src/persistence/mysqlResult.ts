/**
 * drizzle's effect-mysql2 driver yields the mysql2 `ResultSetHeader` for
 * INSERT/UPDATE/DELETE statements, but types the result as a row array.
 * Normalize to the affected-row count; MySQL has no `RETURNING`, so this
 * replaces the Postgres `RETURNING`-based "did this statement match" checks.
 */
export const affectedRows = (result: unknown): number => {
  if (
    typeof result === "object" &&
    result !== null &&
    "affectedRows" in result &&
    typeof (result as { affectedRows: unknown }).affectedRows === "number"
  ) {
    return (result as { affectedRows: number }).affectedRows;
  }
  return 0;
};
