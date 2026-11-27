/**
 * A user message that marks its run as a monitor update or a delegated-completion wake: what
 * `delegatedTaskProgress` and `delegatedTaskRuns` read. The partial index on it is only used when
 * the read spells this text the same way.
 */
export const DELEGATED_TASK_MESSAGE_CONDITION = `role = 'user' AND json_valid(payload_json) AND (
  json_extract(payload_json, '$.notification.source.kind') = 'monitor'
  OR json_extract(payload_json, '$.delegatedCompletion') IS NOT NULL
)`;
