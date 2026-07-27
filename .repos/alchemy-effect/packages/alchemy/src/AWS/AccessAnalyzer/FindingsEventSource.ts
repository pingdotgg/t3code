import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload IAM Access Analyzer delivers to EventBridge when a
 * finding is generated, updated, or deleted. External-access events carry the
 * `resource`/`isPublic`/`principal` fields; unused-access events carry the
 * `findingType`/`resource` (the IAM entity) fields. Fields not shared by both
 * kinds are optional.
 */
export interface FindingDetail {
  /** Version of the finding event schema. */
  version?: string;
  /** The finding id. */
  id: string;
  /** Finding status: `ACTIVE`, `ARCHIVED`, or `RESOLVED`. */
  status?: string;
  /** ARN of the resource the finding is for. */
  resource?: string;
  /** Type of the resource, e.g. `AWS::S3::Bucket` or `AWS::IAM::Role`. */
  resourceType?: string;
  /** Account that owns the analyzed resource. */
  resourceOwnerAccount?: string;
  /** External-access: whether the policy grants public access. */
  isPublic?: boolean;
  /** External-access: the external principal granted access. */
  principal?: Record<string, string>;
  /** External-access: the actions granted to the external principal. */
  action?: string[];
  /** External-access: condition keys constraining the grant. */
  condition?: Record<string, string>;
  /** Unused-access: the finding type, e.g. `UnusedIAMRole`. */
  findingType?: string;
  /** When the finding was created. */
  createdAt?: string;
  /** When the resource was last analyzed. */
  analyzedAt?: string;
  /** When the finding was last updated. */
  updatedAt?: string;
  /** Additional event fields (the schema grows over time). */
  [key: string]: unknown;
}

/** An Access Analyzer finding EventBridge event delivered to the handler. */
export type FindingEvent = EventRecord<FindingDetail>;

export interface FindingsEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "AccessAnalyzerFindings"
   */
  id?: string;
  /**
   * Which finding events to subscribe to:
   * - `"external"` — external-access findings (`Access Analyzer Finding`)
   * - `"unused"` — unused-access findings (`Unused Access Finding for IAM entities`)
   * - `"all"` — both detail types
   * @default "all"
   */
  kind?: "external" | "unused" | "all";
}

const DETAIL_TYPES = {
  external: ["Access Analyzer Finding"],
  unused: ["Unused Access Finding for IAM entities"],
  all: ["Access Analyzer Finding", "Unused Access Finding for IAM entities"],
} as const;

/**
 * Event source connecting IAM Access Analyzer findings to the hosting
 * compute. Access Analyzer publishes every finding create/update/delete to
 * the account's default EventBridge bus (source `aws.access-analyzer`); this
 * subscribes the host Function to those events so it can alert on or
 * auto-remediate new findings.
 *
 * Analyzers publish to EventBridge automatically — no additional resource is
 * created besides the EventBridge rule targeting the host. Provide the
 * host-specific implementation layer (e.g. `AWS.Lambda.EventSource`) on the
 * Function effect.
 *
 * @section Consuming Finding Events
 * @example Alert on New External-Access Findings
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.AccessAnalyzer.consumeFindings(
 *       { kind: "external" },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.log(
 *             `finding ${event.detail.id} on ${event.detail.resource}`,
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeFindings = <StreamReq = never, Req = never>(
  props: FindingsEventSourceProps,
  process: (
    events: Stream.Stream<FindingEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "AccessAnalyzerFindings",
    {
      source: ["aws.access-analyzer"],
      "detail-type": [...DETAIL_TYPES[props.kind ?? "all"]],
    },
    { description: props.description, state: props.state },
    process,
  );
