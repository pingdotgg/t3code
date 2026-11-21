// The server logs these around pending migrations; the desktop reads them from its output tail,
// which keeps only the last few thousand characters, so each progress line also marks a running upgrade.
import type { DatabaseMigrationProgress } from "@t3tools/contracts";

export const DATABASE_MIGRATIONS_STARTED_MESSAGE = "Running database migrations";
export const DATABASE_MIGRATION_PROGRESS_MESSAGE = "Upgrading database";
export const DATABASE_MIGRATIONS_FINISHED_MESSAGE = "Migrations ran successfully";

export function isRunningDatabaseMigrations(output: string): boolean {
  return (
    Math.max(
      output.lastIndexOf(DATABASE_MIGRATIONS_STARTED_MESSAGE),
      output.lastIndexOf(DATABASE_MIGRATION_PROGRESS_MESSAGE),
    ) > output.lastIndexOf(DATABASE_MIGRATIONS_FINISHED_MESSAGE)
  );
}

export function databaseMigrationProgress(
  output: string,
  previous: DatabaseMigrationProgress | null = null,
): DatabaseMigrationProgress | null {
  if (!isRunningDatabaseMigrations(output)) {
    return output.includes(DATABASE_MIGRATIONS_FINISHED_MESSAGE) ? null : previous;
  }
  const start = output.lastIndexOf(DATABASE_MIGRATIONS_STARTED_MESSAGE);
  const line = output.slice(
    Math.max(start, output.lastIndexOf(DATABASE_MIGRATION_PROGRESS_MESSAGE)),
  );
  const match =
    /^Upgrading database \((\d+) of (\d+)\)/.exec(line) ??
    /(?:progress=|"progress"\s*:\s*)"(\d+) of (\d+)"/.exec(line);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  return Number.isSafeInteger(current) &&
    Number.isSafeInteger(total) &&
    current > 0 &&
    current <= total
    ? { current, total }
    : null;
}
