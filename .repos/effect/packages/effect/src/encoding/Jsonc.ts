/**
 * Parses JSON with JavaScript-style comments without external dependencies.
 *
 * The syntax target is the [JSONC draft specification](https://jsonc.org/)
 * with `jsonc-parser` 3.3.1's default profile: JSON plus line and block comments,
 * with trailing commas disabled. One leading BOM is accepted, matching the
 * TOML and YAML parsers. Decoded values follow `JSON.parse` semantics; invalid
 * documents fail instead of returning a partial result.
 *
 * @stability unstable
 * @since 4.1.2
 */

import * as internal from "../internal/jsonParser.ts"
import * as Result from "../Result.ts"
import { EncodingError } from "./EncodingError.ts"

const fail = (input: string): never => {
  // Native errors differ across engines and may quote the input, so the strict parser
  // locates the error. It accepts exactly what JSON.parse accepts once comments are
  // removed; the final throw only guards against an engine that disagrees.
  internal.parse(input, "JSONC")
  throw internal.syntaxError(input, input.length, "JSONC")
}

const lineEnd = /[\r\n]/g

const parseUnsafe = (input: string): unknown => {
  // Ignore one leading BOM without shifting original-input error positions.
  if (input.charCodeAt(0) === 0xfeff) input = " " + input.slice(1)
  let slash = input.indexOf("/")
  let json = input
  if (slash !== -1) {
    let stripped = ""
    let start = 0
    let quote = input.indexOf("\"")
    while (slash !== -1) {
      if (quote !== -1 && quote < slash) {
        // Skip the string; a quote after an odd run of backslashes is escaped.
        let end = quote
        for (;;) {
          end = input.indexOf("\"", end + 1)
          if (end === -1) break
          let backslash = end - 1
          while (input.charCodeAt(backslash) === 92) backslash--
          if ((end - backslash) % 2 === 1) break
        }
        if (end === -1) break
        quote = input.indexOf("\"", end + 1)
        if (slash < end) slash = input.indexOf("/", end + 1)
        continue
      }
      const next = input.charCodeAt(slash + 1)
      let index: number
      if (next === 47) {
        lineEnd.lastIndex = slash + 2
        index = lineEnd.test(input) ? lineEnd.lastIndex - 1 : input.length
      } else if (next === 42) {
        const end = input.indexOf("*/", slash + 2)
        if (end === -1) fail(input)
        index = end + 2
      } else {
        // Not a comment; JSON.parse rejects it below.
        slash = input.indexOf("/", slash + 1)
        continue
      }
      // A space prevents comments inside invalid tokens from joining those tokens.
      stripped += input.slice(start, slash) + " "
      start = index
      slash = input.indexOf("/", index)
      if (quote !== -1 && quote < index) quote = input.indexOf("\"", index)
    }
    json = stripped + input.slice(start)
  }
  try {
    return JSON.parse(json)
  } catch {
    return fail(input)
  }
}

/**
 * Parses a JSONC document into a JavaScript value.
 *
 * **Details**
 *
 * Returns `Result.succeed` with the parsed value, or `Result.fail` with an
 * `EncodingError` when the input is not valid JSONC. Accepts one leading BOM
 * and line and block comments wherever JSON permits whitespace. All other
 * syntax follows `JSON.parse`, including duplicate keys and `__proto__`
 * handling.
 *
 * **Gotchas**
 *
 * Error messages give a 1-based line and column, counted in UTF-16 code units,
 * but do not include the input text. Trailing commas and JSON5 extensions are
 * not accepted. Unlike `JSON.parse`, this function has no reviver.
 *
 * **Example** (Parsing a JSONC document)
 *
 * ```ts import.meta.vitest
 * import { Result } from "effect"
 * import { Jsonc } from "effect/encoding"
 *
 * Jsonc.parse("{ \"port\": 8080 } // comment") // => Result.succeed({ port: 8080 })
 * Result.isFailure(Jsonc.parse("{ \"port\": 8080, }")) // => true
 * ```
 *
 * @stability unstable
 * @category decoding
 * @since 4.1.2
 */
export const parse = (input: string): Result.Result<unknown, EncodingError> => {
  try {
    return Result.succeed(parseUnsafe(input))
  } catch (e) {
    return Result.fail(
      new EncodingError({
        module: "Jsonc",
        kind: "Decode",
        input,
        message: e instanceof Error ? e.message : "Invalid input"
      })
    )
  }
}
