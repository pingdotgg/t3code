/**
 * ThreadsSurface - Schemas for the agent-facing threads toolkit.
 *
 * Tools in this surface let a running agent list and create threads in the
 * current environment. The payloads are deliberately small: thread items carry
 * ids and titles only, never message content, so thread data stays out of the
 * model. Clients resolve rendering (and navigation) locally from these ids.
 *
 * @module ThreadsSurface
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export type ThreadsSurfaceToolName = "threads_list" | "threads_create";

/**
 * Adapters surface toolkit tools under different names: Codex keeps the bare
 * tool name (`item.tool`), while Claude/OpenCode wrap it as
 * `mcp__<server>__<tool>`. Matches both forms for the `t3-code` server only,
 * using the same server-name aliases as the preview tool matcher.
 */
const THREADS_SURFACE_QUALIFIED_NAME =
  /^(?:(?:mcp__)?t3[-_]?code_{1,2})?(threads_list|threads_create)$/;
const THREADS_SURFACE_SERVER_NAME = /^t3[-_]?code$/;

export function matchThreadsSurfaceToolName(
  name: unknown,
  server?: unknown,
): ThreadsSurfaceToolName | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  // Adapters that split server and tool into separate fields (Codex
  // `item.server` + `item.tool`) carry bare tool names; an explicit foreign
  // server must not match, while a missing server stays permissive for
  // adapters that only report the tool name.
  if (typeof server === "string" && !THREADS_SURFACE_SERVER_NAME.test(server)) {
    return undefined;
  }
  return THREADS_SURFACE_QUALIFIED_NAME.exec(name)?.[1] as ThreadsSurfaceToolName | undefined;
}

export const THREADS_SURFACE_LIST_DEFAULT_LIMIT = 8;
export const THREADS_SURFACE_LIST_MAX_LIMIT = 25;

export const ThreadsSurfaceListFilter = Schema.Literals(["recent", "settled", "active"]);
export type ThreadsSurfaceListFilter = typeof ThreadsSurfaceListFilter.Type;

export const ThreadsListInput = Schema.Struct({
  filter: ThreadsSurfaceListFilter.pipe(
    Schema.withDecodingDefault(Effect.succeed("recent" as const)),
  ),
  projectId: Schema.optional(ProjectId),
  limit: Schema.optional(PositiveInt),
});
export type ThreadsListInput = typeof ThreadsListInput.Type;

export const ThreadsListItem = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  settled: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ThreadsListItem = typeof ThreadsListItem.Type;

export const ThreadsListResult = Schema.Struct({
  threads: Schema.Array(ThreadsListItem).check(Schema.isMaxLength(THREADS_SURFACE_LIST_MAX_LIMIT)),
});
export type ThreadsListResult = typeof ThreadsListResult.Type;

export const ThreadsCreateInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
});
export type ThreadsCreateInput = typeof ThreadsCreateInput.Type;

export const ThreadsCreateResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
});
export type ThreadsCreateResult = typeof ThreadsCreateResult.Type;

export class ThreadsSurfaceError extends Schema.TaggedError<ThreadsSurfaceError>()(
  "ThreadsSurfaceError",
  {
    operation: Schema.Literals(["threads_list", "threads_create"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
