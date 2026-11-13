import type { StateValue } from "@distilled.cloud/aws/cloudwatch";

export interface AlarmStateChangesOptions {
  /** Only match state changes for these alarm names. Matches all alarms when omitted. */
  alarmNames?: string[];
  /** Only match transitions INTO these states (e.g. `["ALARM"]`). */
  states?: StateValue[];
  /** Only match transitions FROM these states (e.g. `["OK"]`). */
  previousStates?: StateValue[];
}

/**
 * Builds an EventBridge event pattern for CloudWatch alarm state changes,
 * for use with the EventBridge event source / routing helpers.
 *
 * @example Consume alarm state changes with a Lambda handler
 * ```typescript
 * yield* AWS.EventBridge.consumeBusEvents(
 *   bus,
 *   AWS.CloudWatch.alarmStateChanges({ states: ["ALARM"] }),
 *   (events) =>
 *     events.pipe(
 *       Stream.runForEach((event) => Effect.log(event.detail)),
 *     ),
 * );
 * ```
 */
export const alarmStateChanges = ({
  alarmNames,
  states,
  previousStates,
}: AlarmStateChangesOptions = {}) => ({
  source: ["aws.cloudwatch"],
  "detail-type": ["CloudWatch Alarm State Change"],
  detail: {
    ...(alarmNames ? { alarmName: alarmNames } : {}),
    ...(states ? { state: { value: states } } : {}),
    ...(previousStates ? { previousState: { value: previousStates } } : {}),
  },
});
