/** The parent a thread's lineage names; a malformed payload names none. */
export const LINEAGE_PARENT_THREAD_ID = `CASE WHEN json_valid(payload_json)
  THEN json_extract(payload_json, '$.lineage.parentThreadId') END`;

/**
 * A subagent thread that is not deleted, archived or not. The partial index on it is only used
 * when the read spells this text the same way.
 */
export const LIVE_SUBAGENT_THREAD_CONDITION = `deleted_at IS NULL AND CASE WHEN json_valid(payload_json)
  THEN json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent' ELSE 0 END`;
