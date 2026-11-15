// The server logs these around pending migrations; the desktop reads them from its output tail,
// which keeps only the last few thousand characters, so each progress line also marks a running upgrade.
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
