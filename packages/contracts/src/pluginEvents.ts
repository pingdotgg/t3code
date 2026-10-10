/**
 * PluginEvents - The curated event projection delivered to plugins that
 * declare the `events` capability.
 *
 * The server reads its durable event log for each such plugin from a
 * persisted, per-installation cursor and hands the plugin small, ordered
 * pages. A page is acknowledged only when the plugin's handlers return for
 * every event in it; the cursor then moves past the page. Delivery is
 * at-least-once: a crash or failure after a side effect and before the
 * acknowledgement delivers the same events again, so handlers deduplicate by
 * `deliveryId`.
 *
 * The projection carries identifiers, outcomes and the thread title, never
 * message bodies. New event types and new optional fields are additive:
 * handlers must ignore types they do not know.
 *
 * @module PluginEvents
 */
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";
import {
  OrchestrationV2RunFinalizationOperation,
  OrchestrationV2RunFinalizedOutcome,
} from "./orchestrationV2.ts";

/** The manifest capability a plugin declares to receive events. */
export const PLUGIN_EVENTS_CAPABILITY = "events";

/** Most events in one delivered page. */
const PLUGIN_EVENT_PAGE_MAX_EVENTS = 256;

/** Longest thread title in an event, in UTF-16 code units. Longer titles are cut. */
export const PLUGIN_EVENT_THREAD_TITLE_MAX_LENGTH = 200;

/**
 * The thread an event belongs to, as it is when the event is delivered (not
 * when it happened). `null` when the thread has been deleted since.
 */
const PluginEventThread = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String.check(Schema.isMaxLength(PLUGIN_EVENT_THREAD_TITLE_MAX_LENGTH)),
});

const PluginEventBase = Schema.Struct({
  /**
   * Stable identity for deduplication: the environment-local id of the stored
   * event. Redelivery repeats it. `run.finalized` and `run.finalization-failed`
   * for one run share it, since a run records exactly one of them. Combine it
   * with `environmentId` when events from several environments meet.
   */
  deliveryId: EventId,
  /** Position in the environment's event log; increases within and across pages. */
  sequence: NonNegativeInt,
  occurredAt: IsoDateTime,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: RunId,
  thread: Schema.NullOr(PluginEventThread),
});

/**
 * A turn finished: the run ended and its finalization (checkpoint capture and
 * workspace refresh, when the run had them) completed.
 */
export const PluginRunFinalizedEvent = Schema.Struct({
  ...PluginEventBase.fields,
  type: Schema.Literal("run.finalized"),
  outcome: OrchestrationV2RunFinalizedOutcome,
});
export type PluginRunFinalizedEvent = typeof PluginRunFinalizedEvent.Type;

/** A run ended but its finalization was abandoned at `operation`. */
export const PluginRunFinalizationFailedEvent = Schema.Struct({
  ...PluginEventBase.fields,
  type: Schema.Literal("run.finalization-failed"),
  operation: OrchestrationV2RunFinalizationOperation,
});
export type PluginRunFinalizationFailedEvent = typeof PluginRunFinalizationFailedEvent.Type;

export const PluginEvent = Schema.Union([
  PluginRunFinalizedEvent,
  PluginRunFinalizationFailedEvent,
]);
export type PluginEvent = typeof PluginEvent.Type;

export const PLUGIN_EVENT_TYPES = [
  "run.finalized",
  "run.finalization-failed",
] as const satisfies ReadonlyArray<PluginEvent["type"]>;

/** One delivery: events in log order, acknowledged together. */
export const PluginEventPage = Schema.Struct({
  events: Schema.Array(PluginEvent).check(Schema.isMaxLength(PLUGIN_EVENT_PAGE_MAX_EVENTS)),
});
export type PluginEventPage = typeof PluginEventPage.Type;

const PluginEventDeliveryReason = Schema.String.check(Schema.isMaxLength(1000));

/**
 * How delivery to one enabled installation that declares `events` is going.
 * It is separate from the plugin process's state: a running plugin can have
 * quarantined delivery. `plugins.resume` clears both.
 *
 * - `active`: delivering, or waiting for the next event.
 * - `retrying`: a page failed; the same page is tried again at `retryAt`.
 * - `quarantined`: stopped in front of a page after `failures` consecutive
 *   failures, or in front of an event the server cannot read (`failures` 0).
 *   Nothing is delivered until resume, a re-enable, or a server restart.
 */
export const PluginEventDeliveryState = Schema.Union([
  Schema.TaggedStruct("active", {}),
  Schema.TaggedStruct("retrying", {
    failures: NonNegativeInt,
    reason: PluginEventDeliveryReason,
    retryAt: IsoDateTime,
  }),
  Schema.TaggedStruct("quarantined", {
    failures: NonNegativeInt,
    reason: PluginEventDeliveryReason,
  }),
]);
export type PluginEventDeliveryState = typeof PluginEventDeliveryState.Type;
