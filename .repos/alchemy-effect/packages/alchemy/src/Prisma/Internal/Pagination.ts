import * as Data from "effect/Data";

/**
 * A cursor-paginated listing answered `hasMore: true` without a next cursor.
 *
 * The hand-rolled client raised this as a protocol error; distilled returns
 * the page as the server sent it, so every walk raises it inline instead of
 * reading the malformed page as the end of the list — a truncated listing
 * would make the adoption and uniqueness guards mint duplicates or miss live
 * resources.
 */
export class PrismaPaginationError extends Data.TaggedError(
  "PrismaPaginationError",
)<{
  message: string;
}> {}
