import * as Schema from "effect/Schema";

import { patchNumberFromId } from "../shared/definition.ts";

/** What `rad cob show` prints for one object: one compact JSON document per line. */
const Edit = Schema.Struct({
  author: Schema.String,
  timestamp: Schema.Number,
  body: Schema.String,
});
const Author = Schema.Struct({ id: Schema.String });

export const RadicleComment = Schema.Struct({
  author: Schema.String,
  body: Schema.String,
  edits: Schema.Array(Edit),
  replyTo: Schema.optional(Schema.NullOr(Schema.String)),
  resolved: Schema.optional(Schema.Boolean),
});
export type RadicleComment = typeof RadicleComment.Type;

const Thread = Schema.Struct({
  comments: Schema.Record(Schema.String, Schema.NullOr(RadicleComment)),
  timeline: Schema.Array(Schema.String),
});

const Review = Schema.Struct({
  id: Schema.String,
  author: Author,
  verdict: Schema.optional(Schema.NullOr(Schema.Literals(["accept", "reject"]))),
  summary: Schema.optional(Schema.NullOr(Schema.Array(Edit))),
  timestamp: Schema.Number,
});

const Revision = Schema.Struct({
  id: Schema.String,
  author: Author,
  description: Schema.Array(Edit),
  base: Schema.String,
  oid: Schema.String,
  discussion: Thread,
  reviews: Schema.Record(Schema.String, Schema.NullOr(Review)),
  timestamp: Schema.Number,
});

const Merge = Schema.Struct({
  revision: Schema.String,
  commit: Schema.String,
  timestamp: Schema.Number,
});

export const RadiclePatchCob = Schema.Struct({
  title: Schema.String,
  author: Author,
  state: Schema.Struct({ status: Schema.String }),
  labels: Schema.Array(Schema.String),
  merges: Schema.Record(Schema.String, Merge),
  revisions: Schema.Record(Schema.String, Schema.NullOr(Revision)),
  timeline: Schema.Array(Schema.String),
});
export type RadiclePatchCob = typeof RadiclePatchCob.Type;

export type RadicleRevision = typeof Revision.Type;
export type RadicleReview = typeof Review.Type;

export type RadiclePatchStatus = "draft" | "open" | "archived" | "merged";

export interface RadiclePatch {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  /** A `did:key:` DID. */
  readonly author: string;
  readonly status: RadiclePatchStatus;
  readonly labels: ReadonlyArray<string>;
  /** Oldest first; the first is the patch's own root revision. */
  readonly revisions: ReadonlyArray<RadicleRevision>;
  readonly merges: ReadonlyArray<typeof Merge.Type>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const STATUSES: ReadonlySet<string> = new Set(["draft", "open", "archived", "merged"]);
const isStatus = (status: string): status is RadiclePatchStatus => STATUSES.has(status);

/** The body as last edited; Radicle keeps every edit and the newest is last. */
export const latestBody = (edits: ReadonlyArray<{ readonly body: string }> | null | undefined) =>
  edits?.at(-1)?.body ?? "";

export function latestRevision(patch: RadiclePatch): RadicleRevision {
  // A patch always has its root revision, which `toRadiclePatch` requires.
  return patch.revisions.at(-1)!;
}

/**
 * The COB carries no ID of its own: a patch's ID is its root revision's, which is the one key of
 * `revisions` among those asked for. Null for a patch whose root revision was redacted.
 */
export function toRadiclePatch(
  cob: RadiclePatchCob,
  requested: ReadonlySet<string>,
): RadiclePatch | null {
  const id = Object.keys(cob.revisions).find((key) => requested.has(key));
  const root = id === undefined ? null : cob.revisions[id];
  if (id === undefined || !root) return null;
  const revisions = Object.values(cob.revisions)
    .flatMap((revision) => (revision ? [revision] : []))
    .toSorted((left, right) =>
      left.id === id ? -1 : right.id === id ? 1 : left.timestamp - right.timestamp,
    );
  const merges = Object.values(cob.merges);
  const times = [
    ...revisions.flatMap((revision) => [
      revision.timestamp,
      ...revision.description.map((edit) => edit.timestamp),
      ...Object.values(revision.discussion.comments).flatMap(
        (comment) => comment?.edits.map((edit) => edit.timestamp) ?? [],
      ),
      ...Object.values(revision.reviews).flatMap((review) => (review ? [review.timestamp] : [])),
    ]),
    ...merges.map((merge) => merge.timestamp),
  ];
  return {
    id,
    number: patchNumberFromId(id),
    title: cob.title,
    author: cob.author.id,
    status: isStatus(cob.state.status) ? cob.state.status : "open",
    labels: cob.labels,
    revisions,
    merges,
    createdAt: root.timestamp,
    updatedAt: Math.max(root.timestamp, ...times),
  };
}
