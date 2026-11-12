// The server logs these around pending migrations; the desktop reads them from its output.
// Migrations run synchronously, so a long one blocks the server from writing anything else.
export const DATABASE_MIGRATIONS_STARTED_MESSAGE = "Running database migrations";
export const DATABASE_MIGRATIONS_FINISHED_MESSAGE = "Migrations ran successfully";

export function isRunningDatabaseMigrations(output: string): boolean {
  return (
    output.lastIndexOf(DATABASE_MIGRATIONS_STARTED_MESSAGE) >
    output.lastIndexOf(DATABASE_MIGRATIONS_FINISHED_MESSAGE)
  );
}
