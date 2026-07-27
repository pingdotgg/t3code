import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Crawler } from "./Crawler.ts";

/**
 * Runtime binding for `glue:GetCrawler`.
 *
 * Reads the bound {@link Crawler}'s metadata — most usefully its `State`
 * (`READY`, `RUNNING`, `STOPPING`) and `LastCrawl` outcome — so runtime code
 * can poll a crawl started with `StartCrawler` to completion. The crawler
 * name is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.GetCrawlerHttp)`.
 * @binding
 * @section Running Crawlers
 * @example Poll a Crawl to Completion
 * ```typescript
 * // init
 * const startCrawler = yield* AWS.Glue.StartCrawler(crawler);
 * const getCrawler = yield* AWS.Glue.GetCrawler(crawler);
 *
 * // runtime
 * yield* startCrawler();
 * const done = yield* getCrawler().pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("10 seconds"),
 *     until: (r) => r.Crawler?.State === "READY",
 *     times: 8,
 *   }),
 * );
 * ```
 */
export interface GetCrawler extends Binding.Service<
  GetCrawler,
  "AWS.Glue.GetCrawler",
  (
    crawler: Crawler,
  ) => Effect.Effect<
    () => Effect.Effect<glue.GetCrawlerResponse, glue.GetCrawlerError>
  >
> {}

export const GetCrawler = Binding.Service<GetCrawler>("AWS.Glue.GetCrawler");
