import { Schema } from "effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Thread-context foundation: attach another thread on the same server as
 * reference material for a user message.
 *
 * Only identity travels on the wire (`environmentId` + `threadId` scope the
 * reference; `title`/`label` are display snapshots). The transcript is never
 * injected eagerly: the provider reads history on demand through the
 * `t3_thread_read` tool. Schema-only; runtime helpers live in
 * `@t3tools/shared/threadContext`.
 */

export const THREAD_CONTEXT_VERSION = 1;
export const THREAD_CONTEXT_KIND = "thread";

/** Durable identity of one attached thread. Shared by every chip that points at it. */
export const ThreadContextId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
).pipe(Schema.brand("ThreadContextId"));
export type ThreadContextId = typeof ThreadContextId.Type;

export const THREAD_CONTEXT_LABEL_MAX_CHARS = 200;
const ThreadContextLabel = Schema.String.check(Schema.isMaxLength(THREAD_CONTEXT_LABEL_MAX_CHARS));

/**
 * Another thread on the same server, attached so the agent can read its
 * history through `t3_thread_read`. Only identity travels; the title is a
 * display snapshot.
 */
export const ThreadContextRecord = Schema.Struct({
  version: Schema.Literal(THREAD_CONTEXT_VERSION),
  kind: Schema.Literal(THREAD_CONTEXT_KIND),
  contextId: ThreadContextId,
  label: ThreadContextLabel,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: ThreadContextLabel,
});
export type ThreadContextRecord = typeof ThreadContextRecord.Type;

export const THREAD_CONTEXT_MAX_RECORDS = 32;

/** Structured thread context riding on a user message. */
export const OrchestrationMessageContext = Schema.Struct({
  version: Schema.Literal(THREAD_CONTEXT_VERSION),
  records: Schema.Array(ThreadContextRecord).check(
    Schema.isMaxLength(THREAD_CONTEXT_MAX_RECORDS),
    Schema.makeFilter(
      (records) => new Set(records.map((record) => record.contextId)).size === records.length,
    ),
  ),
});
export type OrchestrationMessageContext = typeof OrchestrationMessageContext.Type;
