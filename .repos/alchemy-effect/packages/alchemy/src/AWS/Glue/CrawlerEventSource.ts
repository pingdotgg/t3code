import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload of a `Glue Crawler State Change` EventBridge event.
 * Emitted on the account's default bus (source `aws.glue`) when a crawl
 * starts, succeeds, or fails.
 */
export interface CrawlerEventDetail {
  /** The name of the crawler. */
  crawlerName?: string;
  /** The state the crawl transitioned to. */
  state?: "Started" | "Succeeded" | "Failed" | (string & {});
  /** A human-readable message (e.g. tables created/updated counts). */
  message?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Glue crawler state-change EventBridge event delivered to the handler. */
export type CrawlerEvent = EventRecord<CrawlerEventDetail>;

export interface CrawlerEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "GlueCrawlerEvents"
   */
  id?: string;
  /**
   * Restrict to specific crawlers (matched against `detail.crawlerName`).
   * Omit to receive events for every crawler in the account.
   */
  crawlerNames?: readonly string[];
  /**
   * Restrict to specific states (matched against `detail.state`).
   * @default all states
   */
  states?: readonly ("Started" | "Succeeded" | "Failed")[];
}

/**
 * Event source connecting Glue crawler state changes to the hosting
 * compute. Glue publishes `Glue Crawler State Change` events to the
 * account's default EventBridge bus (source `aws.glue`) when a crawl
 * starts, succeeds, or fails; this subscribes the host Function to those
 * events so it can kick off downstream processing once the Data Catalog is
 * refreshed.
 *
 * Glue publishes to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Crawler Events
 * @example Run Downstream Work After a Crawl
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default PipelineFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Glue.consumeCrawlerEvents(
 *       { states: ["Succeeded"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(`catalog refreshed by ${event.detail.crawlerName}`),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeCrawlerEvents = <StreamReq = never, Req = never>(
  props: CrawlerEventSourceProps,
  process: (
    events: Stream.Stream<CrawlerEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "GlueCrawlerEvents",
    {
      source: ["aws.glue"],
      "detail-type": ["Glue Crawler State Change"],
      ...(props.crawlerNames !== undefined || props.states !== undefined
        ? {
            detail: {
              ...(props.crawlerNames !== undefined
                ? { crawlerName: [...props.crawlerNames] }
                : {}),
              ...(props.states !== undefined
                ? { state: [...props.states] }
                : {}),
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
