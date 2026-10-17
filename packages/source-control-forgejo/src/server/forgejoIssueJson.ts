/**
 * Forgejo's issue shapes, beside the pull request ones they share users, labels and comments
 * with. Gitea answers the same API, so a Gitea server reads through this too.
 *
 * @module source-control-forgejo/server/forgejoIssueJson
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  TrimmedNonEmptyString,
  type IssueComment,
  type IssueEvent,
  type IssueTemplate,
  type IssueTemplateField,
} from "@t3tools/contracts";
import type { TrackerIssueSummary } from "@t3tools/issue-tracker-core/server/IssueTracker";

import {
  ForgejoComment,
  ForgejoLabel,
  ForgejoRepository,
  ForgejoUser,
  forgejoActor,
} from "./forgejoPullRequestJson.ts";

export const ForgejoConversationCursor = Schema.Struct({
  version: Schema.Literal(1),
  identity: Schema.String,
  native: Schema.String.check(
    Schema.isPattern(
      /^(?:[1-9]\d{0,6}|offset:[1-9]\d{0,6}:[1-9]\d{0,8}|page:[1-9]\d{0,6}:[1-9]\d*)$/,
    ),
  ),
  lastId: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  lastAt: Schema.optional(Schema.String),
  total: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

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
  milestone: Schema.optional(Schema.NullOr(Schema.Struct({ title: Schema.String }))),
  comments: Schema.optional(Schema.Int),
  is_locked: Schema.optional(Schema.Boolean),
  /** Present on a row that is really a pull request, which the issue listing also returns. */
  pull_request: Schema.optional(Schema.NullOr(Schema.Struct({ merged: Schema.Boolean }))),
});

export const ForgejoIssueRepository = Schema.Struct({
  ...ForgejoRepository.fields,
  has_issues: Schema.optional(Schema.Boolean),
  has_pull_requests: Schema.optional(Schema.Boolean),
  internal_tracker: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        enable_issue_dependencies: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});

/** One row of `/issues/{index}/timeline`, which is a comment with a type and a subject. */
export const ForgejoTimelineEntry = Schema.Struct({
  id: Schema.Int,
  type: Schema.String,
  ref_action: Schema.optional(Schema.String),
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
        title: Schema.optional(Schema.String),
        pull_request: Schema.optional(Schema.NullOr(Schema.Struct({ merged: Schema.Boolean }))),
      }),
    ),
  ),
});

export const ForgejoIssueTemplate = Schema.Struct({
  body: Schema.optional(Schema.Unknown),
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
  contact_links: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          name: TrimmedNonEmptyString,
          about: Schema.String,
          url: TrimmedNonEmptyString,
        }),
      ).check(Schema.isMaxLength(100)),
    ),
  ),
});

function toIsoUtc(value: string): string {
  return Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });
}

export function forgejoIssue(
  issue: typeof ForgejoIssue.Type,
): TrackerIssueSummary & { readonly milestone: string | null } {
  return {
    key: String(issue.number),
    displayKey: `#${issue.number}`,
    title: issue.title,
    url: issue.html_url,
    author: forgejoActor(issue.user),
    state:
      issue.state === "closed"
        ? { category: "closed", name: "closed", workflowCategory: "completed" }
        : { category: "open", name: "open", workflowCategory: "unstarted" },
    createdAt: toIsoUtc(issue.created_at),
    updatedAt: toIsoUtc(issue.updated_at),
    closedAt: issue.closed_at ? toIsoUtc(issue.closed_at) : null,
    assignees: (issue.assignees ?? []).flatMap((user) => forgejoActor(user) ?? []),
    labels: (issue.labels ?? []).map((label) => ({
      id: `forgejo-label:${label.id}`,
      name: label.name,
      color: label.color ?? null,
    })),
    milestone: issue.milestone?.title ?? null,
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

const isReferenceTitle = Schema.is(TrimmedNonEmptyString.check(Schema.isMaxLength(4096)));

export function forgejoIssueEventLinks(entry: typeof ForgejoTimelineEntry.Type) {
  const safeUrl = (value: string | null | undefined) => {
    if (!value || value.length > 8192) return undefined;
    try {
      const url = new URL(value);
      return (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  };
  const url = safeUrl(entry.html_url);
  const referenceUrl = safeUrl(entry.ref_issue?.html_url);
  const title = entry.ref_issue?.title;
  return {
    ...(url === undefined ? {} : { url }),
    ...(referenceUrl === undefined
      ? {}
      : {
          reference: {
            url: referenceUrl,
            identifier: `#${entry.ref_issue!.number}`,
            ...(isReferenceTitle(title) ? { title } : {}),
          },
        }),
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
    ...forgejoIssueEventLinks(entry),
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

const TemplateVisibility = Schema.Array(Schema.Literals(["form", "content"]));
const TemplateField = Schema.Struct({
  type: Schema.Literals(["markdown", "input", "textarea", "dropdown", "checkboxes"]),
  id: Schema.optional(Schema.String),
  visible: Schema.optional(TemplateVisibility),
  attributes: Schema.Struct({
    label: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    placeholder: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
    render: Schema.optional(Schema.String),
    multiple: Schema.optional(Schema.Boolean),
    options: Schema.optional(
      Schema.Array(
        Schema.Union([
          Schema.String,
          Schema.Struct({
            label: Schema.String,
            required: Schema.optional(Schema.Boolean),
            visible: Schema.optional(TemplateVisibility),
          }),
        ]),
      ),
    ),
  }),
  validations: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        required: Schema.optional(Schema.Boolean),
        is_number: Schema.optional(Schema.Literal(false)),
        regex: Schema.optional(Schema.Literal("")),
      }),
    ),
  ),
});
const decodeFormFields = Schema.decodeUnknownOption(Schema.Array(TemplateField), {
  onExcessProperty: "error",
});
export function forgejoIssueTemplate(
  template: typeof ForgejoIssueTemplate.Type,
): IssueTemplate | null {
  const base = {
    key: template.file_name,
    name: template.name?.trim() || template.file_name,
    about: template.about ?? "",
    title: template.title ?? "",
    body: template.content ?? "",
    labels: template.labels ?? [],
    assignees: template.assignees ?? [],
  };
  if (/\.md$/i.test(template.file_name)) return base;
  if (!/\.ya?ml$/i.test(template.file_name)) return null;
  const parsed = Option.getOrUndefined(decodeFormFields(template.body ?? []));
  if (!parsed || !parsed.length) return null;
  if (
    parsed.some(
      (field) =>
        (field.visible !== undefined &&
          field.visible.length > 0 &&
          (!field.visible.includes("form") ||
            field.visible.includes("content") === (field.type === "markdown"))) ||
        (field.attributes.options ?? []).some(
          (option) =>
            typeof option !== "string" &&
            option.visible !== undefined &&
            option.visible.length > 0 &&
            (!option.visible.includes("form") || !option.visible.includes("content")),
        ),
    )
  )
    return null;
  const fields = parsed.map((field, index): IssueTemplateField => {
    const attributes = field.attributes;
    if (field.type === "markdown") return { kind: "markdown", value: attributes.value ?? "" };
    const common = {
      id: field.id ?? `field-${index}`,
      label: attributes.label ?? "",
      description: attributes.description ?? null,
      required: field.validations?.required ?? false,
    };
    if (field.type === "input")
      return {
        ...common,
        kind: "input",
        placeholder: attributes.placeholder ?? null,
        value: attributes.value ?? null,
      };
    if (field.type === "textarea")
      return {
        ...common,
        kind: "textarea",
        placeholder: attributes.placeholder ?? null,
        value: attributes.value ?? null,
        render: attributes.render ?? null,
      };
    if (field.type === "dropdown")
      return {
        ...common,
        kind: "dropdown",
        multiple: attributes.multiple ?? false,
        options: (attributes.options ?? []).map((option) =>
          typeof option === "string" ? option : option.label,
        ),
      };
    return {
      ...common,
      kind: "checkboxes",
      options: (attributes.options ?? []).map((option) =>
        typeof option === "string"
          ? { label: option, required: false }
          : { label: option.label, required: option.required ?? false },
      ),
    };
  });
  return { ...base, body: "", fields };
}
