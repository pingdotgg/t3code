/**
 * Helpers for escaping and unescaping JSON Pointer path segments. JSON Pointer
 * uses `/` to separate path tokens inside a JSON document, so token text must
 * encode literal `~` and `/` characters. This module provides the two RFC 6901
 * token conversions used by JSON Patch and related path handling.
 *
 * @since 4.0.0
 */

/**
 * Escapes a JSON Pointer reference token according to RFC 6901 by encoding special characters so the token can be safely used as a segment in a JSON Pointer.
 *
 * **When to use**
 *
 * Use when you need to escape a single JSON Pointer path segment.
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
 * Use when you need to decode a single escaped JSON Pointer path segment.
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
