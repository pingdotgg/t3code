import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** How many path segments a chat file link shows: 1 is the file name alone. */
export const FileLinkPathDepth = Schema.Literals([1, 2, 3, 4, 5]);
export type FileLinkPathDepth = typeof FileLinkPathDepth.Type;

/** The stored field: a bad value decodes to 1, so it can never fail the client settings. */
export const StoredFileLinkPathDepth = FileLinkPathDepth.pipe(
  Schema.catchDecoding(() => Effect.succeedSome(1 as const)),
  Schema.withDecodingDefault(Effect.succeed(1 as const)),
);
