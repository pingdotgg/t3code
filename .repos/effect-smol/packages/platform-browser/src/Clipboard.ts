/**
 * Browser clipboard integration for Effect programs.
 *
 * This module provides a `Clipboard` service backed by `navigator.clipboard`.
 * It keeps copy, paste, clear, and rich clipboard operations inside the Effect
 * environment so browser UI code can require clipboard capability without
 * calling the global API directly. Text helpers cover portable copy and paste
 * flows, while `read`, `write`, and `writeBlob` expose `ClipboardItem` payloads
 * for browsers that support richer MIME types.
 *
 * **Mental model**
 *
 * `Clipboard` is a capability service. Application code depends on the service
 * tag, {@link layer} supplies the live browser implementation, and {@link make}
 * builds custom implementations for tests, unsupported browsers, or constrained
 * capabilities. Browser failures are converted to {@link ClipboardError}.
 *
 * **Common tasks**
 *
 * - Provide {@link layer} near the browser application edge.
 * - Use `writeString` for copy buttons and generated text.
 * - Use `readString` for paste or import workflows.
 * - Use `write` or `writeBlob` for rich clipboard payloads when
 *   `ClipboardItem` is available.
 * - Use `clear` to replace the clipboard with an empty string.
 *
 * **Gotchas**
 *
 * Clipboard access requires a secure context in modern browsers and may also
 * require user activation, permissions, and a focused document. Support differs
 * between reads, writes, text, and custom MIME payloads, so feature detection or
 * graceful fallback is often needed around `ClipboardItem` usage.
 *
 * @since 4.0.0
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const TypeId = "~@effect/platform-browser/Clipboard"
const ErrorTypeId = "~@effect/platform-browser/Clipboard/ClipboardError"

/**
 * Defines the service interface for reading from, writing to, and clearing the browser clipboard.
 *
 * **Details**
 *
 * `read` and `write` work with `ClipboardItem` arrays. `readString` and
 * `writeString` use text, `writeBlob` writes one `Blob`, and `clear` writes an
 * empty string.
 *
 * **Gotchas**
 *
 * Clipboard access generally requires a secure context and may require user
 * activation, permissions, or a focused document. `ClipboardItem` and non-text
 * MIME type support varies by browser. Failed browser operations are surfaced
 * as `ClipboardError`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Clipboard {
  readonly [TypeId]: typeof TypeId
  readonly read: Effect.Effect<ClipboardItems, ClipboardError>
  readonly readString: Effect.Effect<string, ClipboardError>
  readonly write: (items: ClipboardItems) => Effect.Effect<void, ClipboardError>
  readonly writeString: (text: string) => Effect.Effect<void, ClipboardError>
  readonly writeBlob: (blob: Blob) => Effect.Effect<void, ClipboardError>
  readonly clear: Effect.Effect<void, ClipboardError>
}

/**
 * Tagged error raised when a browser clipboard operation fails.
 *
 * @category errors
 * @since 4.0.0
 */
export class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly message: string
  readonly cause: unknown
}> {
  readonly [ErrorTypeId] = ErrorTypeId
}

/**
 * Service tag for browser clipboard capabilities.
 *
 * **When to use**
 *
 * Use when an Effect needs to require or provide clipboard capabilities through
 * the context.
 *
 * @see {@link make} for building a custom clipboard service
 * @see {@link layer} for providing the browser-backed clipboard service
 *
 * @category services
 * @since 4.0.0
 */
export const Clipboard: Context.Service<Clipboard, Clipboard> = Context.Service<Clipboard>(TypeId)

/**
 * Builds a `Clipboard` service from primitive read and write operations, deriving `clear` and `writeBlob` helpers.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  impl: Omit<Clipboard, "clear" | "writeBlob" | typeof TypeId>
): Clipboard =>
  Clipboard.of({
    ...impl,
    [TypeId]: TypeId,
    clear: impl.writeString(""),
    writeBlob: (blob: Blob) => impl.write([new ClipboardItem({ [blob.type]: blob })])
  })

/**
 * Layer that directly interfaces with the browser Clipboard API.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Clipboard> = Layer.succeed(
  Clipboard,
  make({
    read: Effect.tryPromise({
      try: () => navigator.clipboard.read(),
      catch: (cause) =>
        new ClipboardError({
          cause,
          "message": "Unable to read from clipboard"
        })
    }),
    write: (s: Array<ClipboardItem>) =>
      Effect.tryPromise({
        try: () => navigator.clipboard.write(s),
        catch: (cause) =>
          new ClipboardError({
            cause,
            "message": "Unable to write to clipboard"
          })
      }),
    readString: Effect.tryPromise({
      try: () => navigator.clipboard.readText(),
      catch: (cause) =>
        new ClipboardError({
          cause,
          "message": "Unable to read a string from clipboard"
        })
    }),
    writeString: (text: string) =>
      Effect.tryPromise({
        try: () => navigator.clipboard.writeText(text),
        catch: (cause) =>
          new ClipboardError({
            cause,
            "message": "Unable to write a string to clipboard"
          })
      })
  })
)
