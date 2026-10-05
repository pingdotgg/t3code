import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { EventFilter } from "./Trigger.ts";

/**
 * A CloudEvent delivered by Eventarc (binary content mode: attributes
 * arrive as `ce-*` headers, `data` as the body).
 */
export interface CloudEvent {
  /** Event id, unique per source. */
  id: string;
  /** CloudEvents `type`, e.g. `google.cloud.storage.object.v1.finalized`. */
  type: string;
  /** Event source, e.g. `//storage.googleapis.com/projects/_/buckets/b`. */
  source: string;
  /** Subject within the source, e.g. `objects/photo.jpg`. */
  subject: string | undefined;
  /** RFC3339 event time. */
  time: string | undefined;
  /** Every `ce-*` attribute, without the prefix (includes extensions). */
  attributes: Record<string, string>;
  /**
   * The payload: parsed JSON for JSON content types, a string for
   * `text/*`, and the raw bytes (`Uint8Array`) otherwise — e.g. Firestore
   * events, which are `application/protobuf`.
   */
  data: unknown;
}

export interface EventarcEventSourceProps {
  /**
   * CloudEvents attribute filters; a `type` filter is required. Every
   * event must match all filters, e.g.
   * `[{ attribute: "type", value: "google.cloud.storage.object.v1.finalized" },
   *   { attribute: "bucket", value: bucket.bucketName }]` — values may be
   * deploy-time Outputs.
   */
  eventFilters: Input<EventFilter>[];
  /**
   * Eventarc location. Must match the event source's region (the bucket
   * region for Storage, `global` for Audit Log events of global services).
   * @default the host's region
   */
  location?: string;
  /**
   * Payload encoding for events that support more than one, e.g.
   * `application/json` or `application/protobuf` for Firestore events.
   * @default `application/protobuf` for Firestore events, otherwise the
   * event type's default
   */
  eventDataContentType?: string;
  /** Delivery path on the host. Defaults to `/__alchemy/eventarc/{id}`. */
  path?: string;
}

export type EventarcEventSourceService = <Req = never>(
  id: string,
  props: EventarcEventSourceProps,
  process: (event: CloudEvent) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source routing Eventarc events — Cloud Storage, Audit Log
 * (`google.cloud.audit.log.v1.written`, i.e. any Google API call),
 * Firestore, Pub/Sub, and partner channels — to the hosting compute.
 *
 * The HTTP implementation is `GCP.Run.EventarcEventSource` for
 * `GCP.Run.Service` / `GCP.Function` and `GCP.CloudFunctions.Function`:
 * it creates an Eventarc trigger delivering to the host with the host's
 * runtime service account as the trigger identity, grants that account
 * `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on
 * the host, and verifies the OIDC token on every delivery. The deploy
 * blocks until Eventarc reports the trigger healthy.
 *
 * Consume it through {@link consumeEvents}.
 *
 * ### Consuming Eventarc events
 * **Example:** Storage finalize events
 * ```typescript
 * yield* GCP.Eventarc.consumeEvents(
 *   "Uploads",
 *   {
 *     eventFilters: [
 *       { attribute: "type", value: "google.cloud.storage.object.v1.finalized" },
 *       { attribute: "bucket", value: bucket.bucketName },
 *     ],
 *   },
 *   (event) => Effect.log(`${event.type} ${event.subject}`),
 * );
 * // …provided with Effect.provide(GCP.Run.EventarcEventSource)
 * ```
 *
 * @binding
 * @category Eventarc
 */
export interface EventarcEventSource extends Binding.Service<
  EventarcEventSource,
  "GCP.Eventarc.EventSource",
  EventarcEventSourceService
> {}

export const EventarcEventSource = Binding.Service<EventarcEventSource>(
  "GCP.Eventarc.EventSource",
);

/**
 * Subscribe an Effect handler to Eventarc events matching `eventFilters`.
 * See {@link EventarcEventSource} for the host implementations.
 */
export const consumeEvents = <Req = never>(
  id: string,
  props: EventarcEventSourceProps,
  process: (event: CloudEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, EventarcEventSource> =>
  EventarcEventSource.use((source) => source(id, props, process));
