import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Crawler } from "./Crawler.ts";

/**
 * Runtime binding for `glue:StopCrawler`.
 *
 * Stops an in-progress crawl of the bound {@link Crawler}. Fails with the
 * typed `CrawlerNotRunningException` when idle and
 * `CrawlerStoppingException` when a stop is already underway. The crawler
 * name is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.StopCrawlerHttp)`.
 * @binding
 * @section Running Crawlers
 * @example Stop a Crawl
 * ```typescript
 * // init
 * const stopCrawler = yield* AWS.Glue.StopCrawler(crawler);
 *
 * // runtime — tolerate an idle or already-stopping crawler
 * yield* stopCrawler().pipe(
 *   Effect.catchTag(
 *     ["CrawlerNotRunningException", "CrawlerStoppingException"],
 *     () => Effect.void,
 *   ),
 * );
 * ```
 */
export interface StopCrawler extends Binding.Service<
  StopCrawler,
  "AWS.Glue.StopCrawler",
  (
    crawler: Crawler,
  ) => Effect.Effect<
    () => Effect.Effect<glue.StopCrawlerResponse, glue.StopCrawlerError>
  >
> {}

export const StopCrawler = Binding.Service<StopCrawler>("AWS.Glue.StopCrawler");
