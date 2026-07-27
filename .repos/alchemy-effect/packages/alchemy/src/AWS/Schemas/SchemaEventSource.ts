import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload the EventBridge schema registry delivers when a
 * schema is created or a new version is published. Fields are optional
 * (the schema grows over time).
 */
export interface SchemaEventDetail {
  /** The name of the schema the event is about. */
  SchemaName?: string;
  /** The type of the schema document, e.g. `OpenApi3`. */
  SchemaType?: string;
  /** The registry the schema belongs to, e.g. `discovered-schemas`. */
  RegistryName?: string;
  /** The version that was created. */
  SchemaVersion?: string;
  /** When the schema version was created. */
  CreationDate?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A schema-registry EventBridge event delivered to the handler. */
export type SchemaEvent = EventRecord<SchemaEventDetail>;

/** Which schema-registry notifications to subscribe to. */
export type SchemaEventKind = "schema-created" | "schema-version-created";

const DETAIL_TYPES: Record<SchemaEventKind, string> = {
  "schema-created": "Schema Created",
  "schema-version-created": "Schema Version Created",
};

export interface SchemaEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "SchemasEvents"
   */
  id?: string;
  /**
   * Which notifications to subscribe to: brand-new schemas and/or new
   * versions of existing schemas (a schema's first version emits both).
   * @default ["schema-created", "schema-version-created"]
   */
  kinds?: readonly SchemaEventKind[];
  /**
   * Restrict to events about schemas in specific registries (matched
   * against the event's `detail.RegistryName`, e.g. `discovered-schemas`).
   */
  registryNames?: readonly string[];
  /**
   * Restrict to events about specific schemas (matched against the event's
   * top-level `resources`, which includes the schema's ARN).
   */
  schemaArns?: readonly string[];
}

/**
 * Event source connecting EventBridge schema-registry notifications to the
 * hosting compute. The registry publishes `Schema Created` and
 * `Schema Version Created` events to the account's default bus (source
 * `aws.schemas`) whenever a schema is registered — including schemas the
 * discoverer infers from live traffic — so a function can react to new or
 * drifting event contracts (regenerate types, notify consumers, run
 * compatibility checks).
 *
 * The registry publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Schema Registry Events
 * @example React To New Schema Versions
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default ContractWatcher.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.Schemas.consumeSchemaEvents(
 *       { kinds: ["schema-version-created"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `schema ${event.detail.RegistryName}/${event.detail.SchemaName} ` +
 *               `published version ${event.detail.SchemaVersion}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeSchemaEvents = <StreamReq = never, Req = never>(
  props: SchemaEventSourceProps,
  process: (
    events: Stream.Stream<SchemaEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "SchemasEvents",
    {
      source: ["aws.schemas"],
      "detail-type": (
        props.kinds ?? (["schema-created", "schema-version-created"] as const)
      ).map((kind) => DETAIL_TYPES[kind]),
      ...(props.registryNames !== undefined
        ? { detail: { RegistryName: [...props.registryNames] } }
        : {}),
      ...(props.schemaArns !== undefined
        ? { resources: [...props.schemaArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
