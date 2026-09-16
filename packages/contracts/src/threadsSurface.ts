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
import { Effect, Schema } from "effect";
import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const THREADS_SURFACE_TOOL_NAMES = ["threads_list", "threads_create"] as const;
export type ThreadsSurfaceToolName = (typeof THREADS_SURFACE_TOOL_NAMES)[number];

/**
 * Adapters surface toolkit tools under different names: Codex keeps the bare
 * tool name (`item.tool`), while Claude/OpenCode wrap it as
 * `mcp__<server>__<tool>`. Matches both forms for the `t3-code` server only,
 * using the same server-name aliases as the preview tool matcher.
 */
const THREADS_SURFACE_QUALIFIED_NAME =
  /^(?:(?:mcp__)?t3[-_]?code_{1,2})?(threads_list|threads_create)$/;

export function matchThreadsSurfaceToolName(name: unknown): ThreadsSurfaceToolName | undefined {
  if (typeof name !== "string") {
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

export const ThreadsSurfaceError = Schema.Struct({
  _tag: Schema.Literals(["ThreadsSurfaceError"]),
  detail: Schema.String,
});
export type ThreadsSurfaceError = typeof ThreadsSurfaceError.Type;
