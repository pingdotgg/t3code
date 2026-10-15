/**
 * Forgejo's issue shapes, beside the pull request ones they share users, labels and comments
 * with. Gitea answers the same API, so a Gitea server reads through this too.
 *
 * @module source-control-forgejo/server/forgejoIssueJson
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { IssueComment, IssueEvent, IssueTemplate } from "@t3tools/contracts";
import type { TrackerIssueSummary } from "@t3tools/issue-tracker-core/server/IssueTracker";

import {
  ForgejoComment,
  ForgejoLabel,
  ForgejoRepository,
  ForgejoUser,
  forgejoActor,
} from "./forgejoPullRequestJson.ts";

export const ForgejoIssue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
  user: Schema.NullOr(ForgejoUser),
  state: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(ForgejoUser))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(ForgejoLabel))),
  comments: Schema.optional(Schema.Int),
  is_locked: Schema.optional(Schema.Boolean),
  /** Present on a row that is really a pull request, which the issue listing also returns. */
  pull_request: Schema.optional(Schema.NullOr(Schema.Struct({ merged: Schema.Boolean }))),
});

export const ForgejoIssueRepository = Schema.Struct({
  ...ForgejoRepository.fields,
  has_issues: Schema.optional(Schema.Boolean),
});

/** One row of `/issues/{index}/timeline`, which is a comment with a type and a subject. */
export const ForgejoTimelineEntry = Schema.Struct({
  id: Schema.Int,
  type: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(ForgejoUser)),
  created_at: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  assignee: Schema.optional(Schema.NullOr(ForgejoUser)),
  removed_assignee: Schema.optional(Schema.Boolean),
  new_title: Schema.optional(Schema.NullOr(Schema.String)),
  label: Schema.optional(Schema.NullOr(ForgejoLabel)),
  ref_issue: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.Int,
        html_url: Schema.String,
        pull_request: Schema.optional(Schema.NullOr(Schema.Struct({ merged: Schema.Boolean }))),
      }),
    ),
  ),
});

export const ForgejoIssueTemplate = Schema.Struct({
  file_name: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  about: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  assignees: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

export const ForgejoIssueConfig = Schema.Struct({
  blank_issues_enabled: Schema.optional(Schema.Boolean),
});

function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });
}

export function forgejoIssue(issue: typeof ForgejoIssue.Type): TrackerIssueSummary {
  return {
    key: String(issue.number),
    displayKey: `#${issue.number}`,
    title: issue.title,
    url: issue.html_url,
    author: forgejoActor(issue.user),
    state:
      issue.state === "closed"
        ? { category: "closed", name: "closed" }
        : { category: "open", name: "open" },
    createdAt: toIsoUtc(issue.created_at),
    updatedAt: toIsoUtc(issue.updated_at),
    closedAt: issue.closed_at ? toIsoUtc(issue.closed_at) : null,
    assignees: (issue.assignees ?? []).flatMap((user) => forgejoActor(user) ?? []),
    labels: (issue.labels ?? []).map((label) => ({ name: label.name, color: label.color ?? null })),
    commentCount: Math.max(0, issue.comments ?? 0),
  };
}

export function forgejoIssueComment(comment: typeof ForgejoComment.Type): IssueComment {
  return {
    id: String(comment.id),
    author: forgejoActor(comment.user),
    body: comment.body,
    createdAt: toIsoUtc(comment.created_at),
    url: comment.html_url || null,
  };
}

/** Null for a timeline entry with no kind in the shared vocabulary, which is dropped. */
export function forgejoIssueEvent(entry: typeof ForgejoTimelineEntry.Type): IssueEvent | null {
  const event = (kind: IssueEvent["kind"], detail: string | null = null): IssueEvent => ({
    id: String(entry.id),
    kind,
    actor: forgejoActor(entry.user),
    createdAt: toIsoUtc(entry.created_at),
    detail,
  });
  switch (entry.type) {
    case "close":
      return event("closed");
    case "reopen":
      return event("reopened");
    case "assignees":
      return event(
        entry.removed_assignee ? "unassigned" : "assigned",
        entry.assignee?.login || null,
      );
    case "change_title":
      return event("renamed", entry.new_title || null);
    case "label":
      // Forgejo writes `1` into the body of a labelling and nothing into a removal.
      return event(entry.body === "1" ? "labeled" : "unlabeled", entry.label?.name || null);
    case "issue_ref":
    case "commit_ref":
    case "comment_ref":
    case "pull_ref":
      return event("referenced", entry.ref_issue ? `#${entry.ref_issue.number}` : null);
    default:
      return null;
  }
}

/** Only markdown templates carry a body; a YAML form is a questionnaire this cannot flatten. */
export function forgejoIssueTemplate(
  template: typeof ForgejoIssueTemplate.Type,
): IssueTemplate | null {
  const key = template.file_name.trim();
  if (key.length === 0 || !/\.md$/i.test(key)) return null;
  return {
    key,
    name: template.name?.trim() || key,
    about: template.about ?? "",
    title: template.title ?? "",
    body: template.content ?? "",
    labels: template.labels ?? [],
    assignees: template.assignees ?? [],
  };
}
