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

export interface DatabaseMigrationProgress {
  /** The migration now running, from 1. Null before the first progress line, as on a new database. */
  readonly step: number | null;
  readonly total: number | null;
}

// Matches logfmt (`progress="3 of 14"`) and the server's pretty console logger (`progress: 3 of 14`).
const PROGRESS_ANNOTATION = /progress(?:=|:\s*)"?(\d+) of (\d+)/;

export function readDatabaseMigrationProgress(output: string): DatabaseMigrationProgress | null {
  if (!isRunningDatabaseMigrations(output)) return null;
  const progressAt = output.lastIndexOf(DATABASE_MIGRATION_PROGRESS_MESSAGE);
  const match =
    progressAt === -1
      ? null
      : PROGRESS_ANNOTATION.exec(
          output.slice(progressAt + DATABASE_MIGRATION_PROGRESS_MESSAGE.length),
        );
  return match === null
    ? { step: null, total: null }
    : { step: Number(match[1]), total: Number(match[2]) };
}
