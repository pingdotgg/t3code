import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import {
  consumeBusEvents,
  type EventRecord,
  type EventRouteProps,
} from "../EventBridge/EventSource.ts";

/**
 * The `detail` payload Security Hub delivers to EventBridge — a batch of
 * findings in AWS Security Finding Format (ASFF).
 */
export interface FindingEventDetail {
  /** The findings the event carries (ASFF documents, up to 25 per event). */
  findings?: securityhub.AwsSecurityFinding[];
  /** Additional detail fields (the schema grows over time). */
  [key: string]: unknown;
}

/** A Security Hub findings EventBridge event delivered to the handler. */
export type FindingEvent = EventRecord<FindingEventDetail>;

/**
 * The `detail` payload of a `Security Hub Findings - Custom Action` event —
 * the action that was invoked plus the findings it was invoked on.
 */
export interface CustomActionEventDetail extends FindingEventDetail {
  /** Name of the custom action that was invoked. */
  actionName?: string;
  /** Description of the custom action that was invoked. */
  actionDescription?: string;
}

/** A Security Hub custom-action EventBridge event delivered to the handler. */
export type CustomActionEvent = EventRecord<CustomActionEventDetail>;

export interface FindingEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "SecurityHubFindings"
   */
  id?: string;
  /**
   * Restrict to findings with specific severity labels (matched against
   * `detail.findings.Severity.Label`), e.g. `["HIGH", "CRITICAL"]`.
   */
  severityLabels?: readonly string[];
  /**
   * Restrict to findings with specific workflow statuses (matched against
   * `detail.findings.Workflow.Status`), e.g. `["NEW"]`.
   */
  workflowStatuses?: readonly string[];
}

/**
 * Event source connecting Security Hub findings to the hosting compute.
 * Security Hub publishes every new finding and finding update to the
 * account's default EventBridge bus (source `aws.securityhub`, detail-type
 * `Security Hub Findings - Imported`); this subscribes the host Function to
 * those events so it can triage, notify, or auto-remediate.
 *
 * Security Hub publishes to EventBridge automatically — no additional
 * resource is created besides the EventBridge rule targeting the host.
 * Provide the host-specific implementation layer (e.g.
 * `AWS.Lambda.EventSource`) on the Function effect.
 *
 * @section Consuming Findings
 * @example Alert on Critical Findings
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * export default AlertFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* AWS.SecurityHub.consumeFindings(
 *       { severityLabels: ["CRITICAL"] },
 *       (events) =>
 *         Stream.runForEach(events, (event) =>
 *           Effect.forEach(event.detail.findings ?? [], (finding) =>
 *             Effect.logError(`Security Hub: ${finding.Title}`),
 *           ),
 *         ),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(AWS.Lambda.EventSource)),
 * );
 * ```
 */
export const consumeFindings = <StreamReq = never, Req = never>(
  props: FindingEventSourceProps,
  process: (
    events: Stream.Stream<FindingEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "SecurityHubFindings",
    {
      source: ["aws.securityhub"],
      "detail-type": ["Security Hub Findings - Imported"],
      ...(props.severityLabels !== undefined ||
      props.workflowStatuses !== undefined
        ? {
            detail: {
              findings: {
                ...(props.severityLabels !== undefined
                  ? { Severity: { Label: [...props.severityLabels] } }
                  : {}),
                ...(props.workflowStatuses !== undefined
                  ? { Workflow: { Status: [...props.workflowStatuses] } }
                  : {}),
              },
            },
          }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );

export interface CustomActionEventSourceProps extends EventRouteProps {
  /**
   * Logical id for the backing EventBridge rule.
   * @default "SecurityHubCustomActions"
   */
  id?: string;
  /**
   * Restrict to specific custom actions (matched against the event's
   * `resources`, which carry the action target ARN), e.g.
   * `[actionTarget.actionTargetArn]`.
   */
  actionArns?: readonly string[];
}

/**
 * Event source connecting Security Hub custom actions to the hosting
 * compute. Selecting a custom action on findings or insights in the console
 * publishes a `Security Hub Findings - Custom Action` event carrying the
 * selected findings; this subscribes the host Function to those events.
 * Define the action with {@link ActionTarget}.
 *
 * @section Consuming Custom Actions
 * @example Handle an Escalation Action
 * ```typescript
 * yield* AWS.SecurityHub.consumeCustomActions(
 *   { actionArns: [escalate.actionTargetArn] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`${event.detail.actionName}:`, event.detail.findings),
 *     ),
 * );
 * ```
 */
export const consumeCustomActions = <StreamReq = never, Req = never>(
  props: CustomActionEventSourceProps,
  process: (
    events: Stream.Stream<CustomActionEvent, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) =>
  consumeBusEvents(
    props.id ?? "SecurityHubCustomActions",
    {
      source: ["aws.securityhub"],
      "detail-type": ["Security Hub Findings - Custom Action"],
      ...(props.actionArns !== undefined
        ? { resources: [...props.actionArns] }
        : {}),
    },
    { description: props.description, state: props.state },
    process,
  );
