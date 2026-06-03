import * as Effect from "effect/Effect";
import type { SQLiteErrorType } from "./SQLiteError.ts";

/**
 * A prepared SQL statement that can be executed multiple times.
 */
export interface SQLiteStatement<R = unknown> {
  /**
   * Execute the statement and return all matching rows.
   */
  all<T = R>(...params: unknown[]): Effect.Effect<T[], SQLiteErrorType>;

  /**
   * Execute the statement and return the first matching row.
   */
  get<T = R>(
    ...params: unknown[]
  ): Effect.Effect<T | undefined, SQLiteErrorType>;

  /**
   * Execute the statement for its side effects (INSERT, UPDATE, DELETE).
   */
  run(...params: unknown[]): Effect.Effect<void, SQLiteErrorType>;
}
