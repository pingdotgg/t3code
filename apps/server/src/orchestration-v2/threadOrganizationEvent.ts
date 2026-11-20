/**
 * A thread being settled, snoozed, pinned, ordered, archived, or relinked, or a message its user
 * sent. Issue status automation reads the newest one's sequence as the thread's revision, so its
 * decision never overrides one made after it. The partial index on it is only used when the read
 * spells this text the same way.
 */
export const THREAD_ORGANIZATION_EVENT_CONDITION = `application_event_version = 2
  AND aggregate_kind = 'thread'
  AND (
    event_type IN (
      'thread.settled', 'thread.unsettled', 'thread.snoozed', 'thread.unsnoozed',
      'thread.pinned', 'thread.unpinned', 'thread.pin-reordered', 'thread.active-reordered',
      'thread.archived', 'thread.unarchived', 'thread.issue-synced'
    )
    OR (
      event_type = 'message.updated'
      AND json_extract(payload_json, '$.role') = 'user'
      AND json_extract(payload_json, '$.createdBy') = 'user'
    )
  )`;
