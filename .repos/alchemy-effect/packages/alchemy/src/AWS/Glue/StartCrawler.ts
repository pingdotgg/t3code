import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Crawler } from "./Crawler.ts";

/**
 * Runtime binding for `glue:StartCrawler`.
 *
 * Starts a crawl of the bound {@link Crawler} on demand — the standard way
 * to refresh the Data Catalog right after new data lands. Fails with the
 * typed `CrawlerRunningException` if a crawl is already in progress. The
 * crawler name is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.StartCrawlerHttp)`.
 * @binding
 * @section Running Crawlers
 * @example Kick Off a Crawl
 * ```typescript
 * // init
 * const startCrawler = yield* AWS.Glue.StartCrawler(crawler);
 *
 * // runtime — tolerate an already-running crawl
 * yield* startCrawler().pipe(
 *   Effect.catchTag("CrawlerRunningException", () => Effect.void),
 * );
 * ```
 */
export interface StartCrawler extends Binding.Service<
  StartCrawler,
  "AWS.Glue.StartCrawler",
  (
    crawler: Crawler,
  ) => Effect.Effect<
    () => Effect.Effect<glue.StartCrawlerResponse, glue.StartCrawlerError>
  >
> {}

export const StartCrawler = Binding.Service<StartCrawler>(
  "AWS.Glue.StartCrawler",
);
