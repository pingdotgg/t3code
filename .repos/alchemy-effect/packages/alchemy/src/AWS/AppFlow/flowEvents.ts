/**
 * The EventBridge `detail-type`s Amazon AppFlow publishes for flow activity.
 * Open union — AWS may add new report types.
 */
export type FlowEventDetailType =
  | "AppFlow Start Flow Run Report"
  | "AppFlow End Flow Run Report"
  | "AppFlow Event Flow Report"
  | (string & {});

export interface FlowEventsOptions {
  /**
   * Only match events for these flow names (the event detail's `flow-name`).
   * Matches all flows when omitted. Use plain flow names (e.g. a constant
   * `flowName` prop) — the pattern is matched again inside the running
   * function, so unresolved `Output` values cannot be used here.
   */
  flowNames?: string[];
  /**
   * Only match these report types (e.g. `["AppFlow End Flow Run Report"]`).
   * Matches every AppFlow event when omitted.
   */
  detailTypes?: FlowEventDetailType[];
  /**
   * Only match runs with these statuses (the event detail's `status`, e.g.
   * `["Execution Successful"]`).
   */
  statuses?: string[];
}

/**
 * Builds an EventBridge event pattern for Amazon AppFlow flow run reports,
 * for use with the EventBridge event source / routing helpers. AppFlow
 * publishes start/end run reports to the default event bus (`source:
 * "aws.appflow"`); the event detail carries `flow-name`, `execution-id`,
 * `status`, timing, and record counts.
 *
 * @example Consume end-of-run reports for a flow with a Lambda handler
 * ```typescript
 * yield* AWS.EventBridge.consumeBusEvents(
 *   AWS.AppFlow.flowEvents({
 *     flowNames: ["my-flow"],
 *     detailTypes: ["AppFlow End Flow Run Report"],
 *   }),
 *   (events) =>
 *     events.pipe(
 *       Stream.runForEach((event) => Effect.log(event.detail)),
 *     ),
 * );
 * ```
 *
 * @example Route failed runs to an SQS queue
 * ```typescript
 * yield* AWS.EventBridge.events(
 *   AWS.AppFlow.flowEvents({ statuses: ["Execution Failed"] }),
 * ).toQueue(alerts);
 * ```
 */
export const flowEvents = ({
  flowNames,
  detailTypes,
  statuses,
}: FlowEventsOptions = {}) => ({
  source: ["aws.appflow"],
  ...(detailTypes ? { "detail-type": detailTypes } : {}),
  ...(flowNames || statuses
    ? {
        detail: {
          ...(flowNames ? { "flow-name": flowNames } : {}),
          ...(statuses ? { status: statuses } : {}),
        },
      }
    : {}),
});
