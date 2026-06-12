import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { SQLiteConnection } from "./SQLiteConnection.ts";
import type { SQLiteErrorType } from "./SQLiteError.ts";

export class SQLite extends Context.Service<SQLite, SQLiteService>()(
  "SQLite",
) {}

/**
 * SQLite service that provides database connection factory.
 */
export interface SQLiteService {
  /**
   * Open a SQLite database at the given path.
   */
  open(path: string): Effect.Effect<SQLiteConnection, SQLiteErrorType>;
}
