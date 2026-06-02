/**
 * Utilities for escaping and unescaping JSON Pointer reference tokens according to RFC 6901.
 *
 * JSON Pointer (RFC 6901) defines a string syntax for identifying a specific value within a JSON document.
 * A JSON Pointer is a sequence of reference tokens separated by forward slashes (`/`). Each reference token
 * must be escaped when it contains special characters (`~` or `/`).
 *
 * ## Mental model
 *
 * - **Reference token**: A single segment of a JSON Pointer path (e.g., `"foo"`, `"bar/baz"`, `"key~with~tilde"`)
 * - **Escaping**: Encoding special characters in a token so it can be safely used in a JSON Pointer (`~` → `~0`, `/` → `~1`)
 * - **Unescaping**: Decoding escaped characters back to their original form (`~0` → `~`, `~1` → `/`)
 * - **RFC 6901 compliance**: These functions implement the standard escaping rules for JSON Pointer reference tokens
 * - **Pure functions**: Both operations are pure, immutable, and have no side effects
 *
 * ## Common tasks
 *
 * - Building JSON Pointers from path segments → {@link escapeToken}
 * - Parsing JSON Pointers to extract original token values → {@link unescapeToken}
 * - Escaping object keys or path segments before constructing JSON Pointers → {@link escapeToken}
 * - Extracting unescaped identifiers from JSON Pointer strings → {@link unescapeToken}
 *
 * ## Gotchas
 *
 * - These functions operate on **reference tokens**, not full JSON Pointers. A full JSON Pointer like `/foo/bar` must be split into tokens (`["foo", "bar"]`) before escaping/unescaping
 * - The order of replacement operations matters: `escapeToken` replaces `~` before `/` to avoid double-escaping
 * - Empty strings are valid tokens and are returned unchanged
 * - These functions do not validate JSON Pointer syntax; they only handle token-level escaping
 *
 * ## Quickstart
 *
 * **Example** (Building and parsing a JSON Pointer)
 *
 * ```ts
 * import { JsonPointer } from "effect"
 *
 * // Build a JSON Pointer from path segments
 * const segments = ["users", "name/alias", "value"]
 * const pointer = "/" + segments.map(JsonPointer.escapeToken).join("/")
 * // "/users/name~1alias/value"
 *
 * // Parse a JSON Pointer back to segments
 * const tokens = pointer.split("/").slice(1).map(JsonPointer.unescapeToken)
 * // ["users", "name/alias", "value"]
 * ```
 *
 * ## See also
 *
 * - {@link JsonPatch} - Uses these utilities for JSON Patch operations
 * - {@link JsonSchema} - Uses these utilities for schema reference resolution
 *
 * @since 4.0.0
 */

/**
 * Escapes a JSON Pointer reference token according to RFC 6901 by encoding special characters so the token can be safely used as a segment in a JSON Pointer.
 *
 * **When to use**
 *
 * Use to build JSON Pointers from object keys or path segments that may contain special characters
 * - Escaping tokens before joining them with `/` to form a complete JSON Pointer
 * - Preparing reference tokens for use in JSON Patch operations or schema references
 *
 * **Details**
 *
 * - Returns a new escaped string
 * - Replaces `~` (tilde) with `~0` and `/` (forward slash) with `~1`
 * - Returns the input unchanged if it contains no special characters
 * - Empty strings are valid and returned unchanged
 *
 * **Gotchas**
 *
 * The replacement order matters: `~` is replaced before `/` to prevent double-escaping.
 *
 * **Example** (Escaping special characters)
 *
 * ```ts
 * import { JsonPointer } from "effect"
 *
 * JsonPointer.escapeToken("a/b") // "a~1b"
 * JsonPointer.escapeToken("c~d") // "c~0d"
 * JsonPointer.escapeToken("path/to~key") // "path~1to~0key"
 * ```
 *
 * @see {@link unescapeToken} The inverse operation for decoding escaped tokens
 * @category encoding
 * @since 4.0.0
 */
export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1")
}

/**
 * Decodes a JSON Pointer reference token according to RFC 6901 escaping rules.
 *
 * **When to use**
 *
 * Use to parse JSON Pointers to extract the original token values from escaped segments
 * - Converting escaped tokens back to their original form for use as object keys or identifiers
 * - Resolving schema references or JSON Patch paths that use escaped tokens
 *
 * **Details**
 *
 * - Returns a new unescaped string
 * - Replaces `~1` with `/` (forward slash) and `~0` with `~` (tilde)
 * - Returns the input unchanged if it contains no escaped sequences
 * - Empty strings are valid and returned unchanged
 *
 * **Gotchas**
 *
 * The replacement order matters: `~1` is replaced before `~0` to prevent incorrect decoding.
 *
 * **Example** (Unescaping special characters)
 *
 * ```ts
 * import { JsonPointer } from "effect"
 *
 * JsonPointer.unescapeToken("a~1b") // "a/b"
 * JsonPointer.unescapeToken("c~0d") // "c~d"
 * JsonPointer.unescapeToken("path~1to~0key") // "path/to~key"
 * ```
 *
 * @see {@link escapeToken} The inverse operation for encoding tokens
 * @category decoding
 * @since 4.0.0
 */
export function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~")
}
