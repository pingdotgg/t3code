/**
 * @since 4.0.0
 */
import * as Data from "./Data.ts"
import * as Predicate from "./Predicate.ts"
import type { Issue } from "./SchemaIssue.ts"

const TypeId = "~effect/SchemaError/SchemaError"

/**
 * Error thrown (or returned as the error channel value) when schema decoding
 * or encoding fails.
 *
 * **Details**
 *
 * The `issue` field contains a structured {@link Issue} tree describing
 * every validation failure, including the path to the problematic value,
 * expected types, and actual values received. `message` renders the issue tree
 * as a human-readable string.
 *
 * Use {@link isSchemaError} to narrow an unknown value to `SchemaError`.
 *
 * **Example** (Catching a SchemaError)
 *
 * ```ts
 * import { Schema } from "effect"
 *
 * try {
 *   Schema.decodeUnknownSync(Schema.Number)("not a number")
 * } catch (err) {
 *   if (Schema.isSchemaError(err)) {
 *     console.log(err.message)
 *     // Expected number, actual "not a number"
 *   }
 * }
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export class SchemaError extends Data.TaggedError("SchemaError")<{
  readonly issue: Issue
}> {
  readonly [TypeId]: typeof TypeId = TypeId
  constructor(issue: Issue) {
    super({ issue })
  }
  override get message() {
    return this.issue.toString()
  }
  override toString() {
    return `SchemaError(${this.message})`
  }
}

/**
 * Returns `true` if `u` is a {@link SchemaError}.
 *
 * @category guards
 * @since 4.0.0
 */
export function isSchemaError(u: unknown): u is SchemaError {
  return Predicate.hasProperty(u, TypeId) && u[TypeId] === TypeId
}
