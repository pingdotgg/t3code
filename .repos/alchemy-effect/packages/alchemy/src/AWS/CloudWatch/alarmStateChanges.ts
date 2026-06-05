import type { StateValue } from "@distilled.cloud/aws/cloudwatch";

export interface AlarmStateChangesOptions {
  alarmNames?: string[];
  states?: StateValue[];
  previousStates?: StateValue[];
}

/**
 * Builds an EventBridge event pattern for CloudWatch alarm state changes.
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
