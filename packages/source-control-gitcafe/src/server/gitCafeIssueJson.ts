import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type IssueActor,
  type IssueComment,
  type IssueReaction,
  type IssueState,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import type { TrackerIssueSummary } from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as PullJson from "./gitCafePullRequestJson.ts";

export const Cursor = TrimmedNonEmptyString.check(
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);
export const CommentCursor = Schema.Struct({
  version: Schema.Literal(1),
  identity: Schema.String,
  native: Cursor,
  lastId: TrimmedNonEmptyString,
  lastAt: IsoDateTime,
});
const State = Schema.Literals([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);
const Label = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  color: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const AssignmentActor = Schema.Struct({ id: TrimmedNonEmptyString, actor: PullJson.Actor });
export const Issue = Schema.Struct({
  id: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  stateType: State,
  author: PullJson.Actor,
  version: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  closedReason: Schema.NullOr(Schema.String),
});
const IssueSummary = Schema.Struct({
  ...Issue.fields,
  labels: Schema.Array(Label).check(Schema.isMaxLength(100)),
  assignees: Schema.Array(AssignmentActor).check(Schema.isMaxLength(20)),
  milestone: Schema.NullOr(Schema.Struct({ title: Schema.String })),
});
export const Detail = Schema.Struct({
  ...IssueSummary.fields,
  capabilities: Schema.Struct({
    edit: Schema.Boolean,
    comment: Schema.Boolean,
    close: Schema.Boolean,
    reopen: Schema.Boolean,
    manageLabels: Schema.Boolean,
    manageAssignees: Schema.Boolean,
  }),
});
export const Comment = Schema.Struct({
  id: TrimmedNonEmptyString,
  issueId: TrimmedNonEmptyString,
  author: PullJson.Actor,
  body: Schema.String,
  version: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  capabilities: Schema.Struct({ edit: Schema.Boolean, delete: Schema.Boolean }),
});
const Link = Schema.Struct({
  issueId: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  linkType: Schema.Literals(["closes", "references"]),
});
export const Principal = Schema.Struct({
  actorId: TrimmedNonEmptyString,
  handle: TrimmedNonEmptyString,
});
export const Versioned = Schema.Struct({ version: NonNegativeInt });
const page = <S extends Schema.Codec<unknown, unknown, never, never>>(item: S) =>
  Schema.Struct({
    items: Schema.Array(item).check(Schema.isMaxLength(100)),
    next: Schema.NullOr(Cursor),
  });
export const Issues = page(IssueSummary);
export const Comments = page(Comment);
export const Labels = page(Label);
export const Assignees = page(AssignmentActor);
export const Links = page(Link);

function actor(value: typeof PullJson.Actor.Type, host: string): IssueActor | null {
  const converted = PullJson.toActor(value, host);
  return converted === null ? null : { ...converted, id: value.actorId };
}

export function assignee(value: typeof AssignmentActor.Type, host: string) {
  return {
    ...(actor(value.actor, host) ?? { login: value.id, name: null, avatarUrl: null }),
    id: value.id,
  };
}

export function state(value: typeof State.Type, reason?: string | null): IssueState {
  return {
    id: value,
    name: value,
    category: value === "completed" || value === "canceled" ? "closed" : "open",
    ...(value === "triage" ? {} : { workflowCategory: value }),
    ...(reason ? { closeReason: reason } : {}),
  };
}

export function summary(
  value: typeof IssueSummary.Type,
  host: string,
  scope: string,
): TrackerIssueSummary {
  return {
    key: String(value.number),
    displayKey: `#${value.number}`,
    title: value.title,
    url: `https://${host}/${scope}/issues/${value.number}`,
    author: actor(value.author, host),
    state: state(value.stateType, value.closedReason),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    closedAt: value.closedAt,
    labels: value.labels,
    assignees: value.assignees.map((item) => assignee(item, host)),
    milestone: value.milestone?.title ?? null,
    commentCount: null,
  };
}

export function permissions(value: typeof Detail.Type): IssueViewerPermissions {
  const p = value.capabilities;
  return {
    edit: p.edit,
    comment: p.comment,
    labels: p.manageLabels,
    assignees: p.manageAssignees,
    setState:
      p.close || (state(value.stateType).category === "closed" ? p.reopen && p.edit : p.edit),
  };
}

export function comment(value: typeof Comment.Type, host: string): IssueComment {
  return {
    id: value.id,
    author: actor(value.author, host),
    body: value.body,
    createdAt: value.createdAt,
    editedAt: value.updatedAt === value.createdAt ? null : value.updatedAt,
    canEdit: value.capabilities.edit,
    url: null,
  };
}

export function reactionFields(
  values: typeof PullJson.GitCafeReactions.Type | void,
  subjectId: string,
  subjectKind: "issue" | "issue_comment",
  host: string,
  viewer: string | null,
) {
  if (values === undefined) return {};
  const reactions: ReadonlyArray<IssueReaction> = values.items.flatMap((item) => {
    const content =
      item.emoji.kind === "unicode" ? PullJson.reactionContent(item.emoji.value) : undefined;
    if (item.subject.kind !== subjectKind || item.subject.id !== subjectId || content === undefined)
      return [];
    return [
      {
        content,
        count: item.count,
        viewerHasReacted: item.viewerReactionId !== null,
        actors: item.reactors.flatMap((value) => {
          const person = actor(value, host);
          return person === null || person.login === viewer ? [] : [person.login];
        }),
      },
    ];
  });
  return { reactions, reactionsTruncated: values.next !== null };
}
