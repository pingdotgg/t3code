/**
 * Parses JSON5 configuration files without external dependencies.
 *
 * The compatibility target is [JSON5 1.0.0](https://spec.json5.org/) and the
 * value-parsing behavior of `json5` 2.2.3, without its optional reviver.
 * Identifier names use the runtime's Unicode property tables.
 *
 * @stability unstable
 * @since 4.1.2
 */

import * as internal from "../internal/jsonParser.ts"
import * as Result from "../Result.ts"
import { EncodingError } from "./EncodingError.ts"

/**
 * Parses a JSON5 document into a JavaScript value.
 *
 * **Details**
 *
 * Returns `Result.succeed` with the parsed value, or `Result.fail` with an
 * `EncodingError` when the input is not valid JSON5. Accepts comments,
 * trailing commas, unquoted identifier keys, single-quoted strings,
 * hexadecimal numbers, `Infinity`, and `NaN`. Duplicate keys use the last
 * value; `__proto__` is preserved as an own data property.
 *
 * **Gotchas**
 *
 * Error messages give a line and column but do not include the input text.
 * Unlike `JSON.parse`, this function has no reviver.
 *
 * **Example** (Parsing a JSON5 document)
 *
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { Json5 } from "effect/encoding"
 *
 * Json5.parse("{ port: 8080, }") // => Result.succeed({ port: 8080 })
 * Result.isFailure(Json5.parse("{ port: }")) // => true
 * ```
 *
 * @stability unstable
 * @category decoding
 * @since 4.1.2
 */
export const parse = (input: string): Result.Result<unknown, EncodingError> => {
  try {
    return Result.succeed(internal.parse(input, "JSON5"))
  } catch (e) {
    return Result.fail(
      new EncodingError({
        module: "Json5",
        kind: "Decode",
        input,
        message: e instanceof Error ? e.message : "Invalid input"
      })
    )
  }
}
