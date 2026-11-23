import * as Schema from "effect/Schema";

import { RadicleComment } from "./radiclePatchJson.ts";

/** What `rad cob show --type xyz.radicle.issue` prints for one issue. */
export const RadicleIssueCob = Schema.Struct({
  title: Schema.String,
  state: Schema.Struct({
    status: Schema.String,
    reason: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  thread: Schema.Struct({
    comments: Schema.Record(Schema.String, Schema.NullOr(RadicleComment)),
    timeline: Schema.Array(Schema.String),
  }),
});
export type RadicleIssueCob = typeof RadicleIssueCob.Type;

export interface RadicleIssue {
  readonly id: string;
  readonly title: string;
  /** A node ID, as comments name their authors. */
  readonly author: string;
  readonly open: boolean;
  /** `solved` or `other` for a closed issue. */
  readonly closeReason: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly body: string;
  /** Every comment after the description, oldest first. */
  readonly comments: ReadonlyArray<{ readonly id: string; readonly comment: RadicleComment }>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Like a patch, an issue's ID is its first comment's: the description, which is the one key of the
 * thread among those asked for. Null for an issue whose description was redacted.
 */
export function toRadicleIssue(
  cob: RadicleIssueCob,
  requested: ReadonlySet<string>,
): RadicleIssue | null {
  const id = Object.keys(cob.thread.comments).find((key) => requested.has(key));
  const root = id === undefined ? null : cob.thread.comments[id];
  if (id === undefined || !root) return null;
  const comments = cob.thread.timeline.flatMap((key) => {
    const comment = cob.thread.comments[key];
    return key !== id && comment ? [{ id: key, comment }] : [];
  });
  const times = [root, ...comments.map((entry) => entry.comment)].flatMap((comment) =>
    comment.edits.map((edit) => edit.timestamp),
  );
  const createdAt = root.edits[0]?.timestamp ?? 0;
  return {
    id,
    title: cob.title,
    author: root.author,
    open: cob.state.status === "open",
    closeReason: cob.state.status === "open" ? null : (cob.state.reason ?? null),
    labels: cob.labels,
    assignees: cob.assignees,
    body: root.body,
    comments,
    createdAt,
    updatedAt: Math.max(createdAt, ...times),
  };
}
