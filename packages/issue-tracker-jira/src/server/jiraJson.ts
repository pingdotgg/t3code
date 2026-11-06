import type { IssueActor, IssueComment, IssueCommentVisibility } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { TrackerIssueSummary } from "@t3tools/issue-tracker-core/server/IssueTracker";

/** Jira answered with something this build cannot read. */
class JiraResponseError extends Schema.TaggedError<JiraResponseError>()("JiraResponseError", {
  operation: Schema.String,
  status: Schema.optional(Schema.Int),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.status === undefined
      ? `Jira returned an unreadable response to ${this.operation}.`
      : `Jira answered ${this.operation} with HTTP ${this.status}.`;
  }
}

interface AdfNode {
  readonly type: string;
  readonly text?: string | undefined;
  readonly attrs?: Schema.JsonObject | undefined;
  readonly marks?:
    | ReadonlyArray<{
        readonly type: string;
        readonly attrs?: Schema.JsonObject | undefined;
      }>
    | undefined;
  readonly content?: ReadonlyArray<AdfNode> | undefined;
}

const adfNode = (depth: number): Schema.Codec<AdfNode> =>
  Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
    attrs: Schema.optional(Schema.JsonObject),
    marks: Schema.optional(
      Schema.Array(
        Schema.Struct({ type: Schema.String, attrs: Schema.optional(Schema.JsonObject) }),
      ),
    ),
    content: Schema.optional(
      Schema.Array(depth >= 32 ? Schema.Never : Schema.suspend(() => adfNode(depth + 1))),
    ),
  });
const AdfDocument = Schema.Struct({
  type: Schema.Literal("doc"),
  version: Schema.optional(Schema.Int),
  content: Schema.Array(adfNode(0)),
});
const JiraBody = Schema.Union([
  Schema.String.check(Schema.isMaxLength(262_144)),
  Schema.Null,
  AdfDocument,
]);
type JiraBody = typeof JiraBody.Type;

const escapeText = (value: string) =>
  value
    .replace(/([\\`*_[\]~#!|])/g, "\\$1")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const codeFence = (text: string, minimum: number) => {
  let length = minimum;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return "`".repeat(length);
};

/** ADF is display data only; unsupported nodes retain their text and never emit HTML. */
const renderBody = (body: JiraBody): string => {
  if (body === null) return "";
  if (typeof body === "string") return escapeText(body);
  let nodes = 0;
  let characters = 0;
  const visit = (node: AdfNode, depth: number, plain = false): string => {
    nodes++;
    characters += node.text?.length ?? 0;
    if (depth > 32 || nodes > 10_000 || characters > 262_144) {
      throw new Error("Jira document exceeds display limits");
    }
    const content = (raw = plain) =>
      (node.content ?? []).map((child) => visit(child, depth + 1, raw)).join("");
    if (plain) {
      if (node.type === "hardBreak") return "\n";
      if (node.type === "paragraph") return `${content()}\n`;
      return node.text ?? content();
    }
    switch (node.type) {
      case "text": {
        if (node.marks?.some((mark) => mark.type === "code")) {
          const raw = node.text ?? "";
          const fence = codeFence(raw, 1);
          return `${fence} ${raw} ${fence}`;
        }
        let text = escapeText(node.text ?? "");
        for (const mark of node.marks ?? []) {
          switch (mark.type) {
            case "strong":
              text = `**${text}**`;
              break;
            case "em":
              text = `*${text}*`;
              break;
            case "strike":
              text = `~~${text}~~`;
              break;
            case "link": {
              const href = mark.attrs?.href;
              if (typeof href === "string" && /^https?:\/\//i.test(href)) {
                text = `[${text}](${href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
              }
              break;
            }
          }
        }
        return text;
      }
      case "hardBreak":
        return "\n";
      case "paragraph":
        return `${content()}\n\n`;
      case "heading": {
        const level = node.attrs?.level;
        return `${"#".repeat(typeof level === "number" ? Math.min(6, Math.max(1, level)) : 2)} ${content()}\n\n`;
      }
      case "bulletList":
        return `${content()}\n`;
      case "orderedList":
        // Items render as bullets, so each one is renumbered from the list's own start.
        return `${(node.content ?? [])
          .map((child, index) => {
            const start = node.attrs?.order;
            const number = (typeof start === "number" ? start : 1) + index;
            return visit(child, depth + 1).replace(/^- /, `${number}. `);
          })
          .join("")}\n`;
      case "listItem":
        return `- ${content().trim().replaceAll("\n", "\n  ")}\n`;
      case "blockquote":
        return `${content()
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`;
      case "codeBlock": {
        const raw = content(true);
        const fence = codeFence(raw, 3);
        return `${fence}\n${raw}\n${fence}\n\n`;
      }
      case "rule":
        return "\n---\n\n";
      case "mention":
      case "emoji": {
        const text = node.attrs?.text ?? node.attrs?.shortName;
        return typeof text === "string" ? escapeText(text) : content();
      }
      case "inlineCard": {
        const url = node.attrs?.url;
        return typeof url === "string" ? escapeText(url) : content();
      }
      case "tableRow":
        return `${content()}\n`;
      case "tableCell":
      case "tableHeader":
        return `${content().trim()} | `;
      default:
        return content();
    }
  };
  return body.content
    .map((node) => visit(node, 0))
    .join("")
    .trim();
};

/** Jira document fields are display data only, so a document past the limits fails the read. */
const decodeJiraBody = Schema.decodeUnknownEffect(JiraBody);

export const renderJiraBody = (operation: string, body: unknown) =>
  decodeJiraBody(body ?? null).pipe(
    Effect.flatMap((decoded) =>
      Effect.try({
        try: () => renderBody(decoded),
        catch: (cause) => new JiraResponseError({ operation, cause }),
      }),
    ),
    Effect.catchTags({
      SchemaError: (cause) => Effect.fail(new JiraResponseError({ operation, cause })),
    }),
  );

const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  operation: string,
  text: string,
) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError((cause) => new JiraResponseError({ operation, cause })),
  );

const JiraUser = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  avatarUrls: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type JiraUser = typeof JiraUser.Type;

const JiraStatus = Schema.Struct({
  name: Schema.String,
  statusCategory: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.String }))),
});

export const JiraIssueFields = Schema.Struct({
  summary: Schema.String,
  status: Schema.optional(Schema.NullOr(JiraStatus)),
  reporter: Schema.optional(Schema.NullOr(JiraUser)),
  assignee: Schema.optional(Schema.NullOr(JiraUser)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  fixVersions: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String })))),
  created: Schema.String,
  updated: Schema.String,
  resolutiondate: Schema.optional(Schema.NullOr(Schema.String)),
  comment: Schema.optional(Schema.NullOr(Schema.Struct({ total: Schema.optional(Schema.Int) }))),
  description: Schema.optional(Schema.Unknown),
});

const JiraIssue = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  fields: JiraIssueFields,
});
type JiraIssue = typeof JiraIssue.Type;

/** The fields a listing asks for; Jira returns hundreds otherwise. */
export const JIRA_LIST_FIELDS =
  "summary,status,reporter,assignee,labels,fixVersions,created,updated,resolutiondate";

/** Jira writes offsets without a colon (`+0000`), which not every date parser accepts. */
function jiraTimestamp(value: string): string {
  const parsed = DateTime.make(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : value;
}

/** Jira's fixed category keys; status names themselves vary per workflow. */
function jiraIssueState(category: string | null | undefined): "open" | "closed" {
  return category === "done" ? "closed" : "open";
}

/**
 * Jira account IDs are opaque hashes and the issue views show an actor's login, so the display
 * name stands in for it. The viewer is read the same way, which keeps "assigned to you" working.
 */
function jiraActor(user: JiraUser | null | undefined): IssueActor | null {
  if (!user) return null;
  const name = user.displayName?.trim() || null;
  const login = name ?? user.accountId;
  if (!login) return null;
  return { login, name, avatarUrl: user.avatarUrls?.["48x48"] ?? null };
}

export function toJiraSummary(issue: JiraIssue, host: string): TrackerIssueSummary {
  const { fields } = issue;
  const category = jiraIssueState(fields.status?.statusCategory?.key);
  const assignee = jiraActor(fields.assignee);
  return {
    key: issue.key,
    displayKey: issue.key,
    title: fields.summary,
    url: `https://${host}/browse/${issue.key}`,
    author: jiraActor(fields.reporter),
    state: { category, name: fields.status?.name ?? category },
    createdAt: jiraTimestamp(fields.created),
    updatedAt: jiraTimestamp(fields.updated),
    closedAt: category === "closed" ? jiraTimestamp(fields.resolutiondate ?? fields.updated) : null,
    assignees: assignee ? [assignee] : [],
    labels: (fields.labels ?? []).map((name) => ({ name, color: null })),
    commentCount: fields.comment?.total ?? 0,
  };
}

const JiraComment = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(JiraUser)),
  created: Schema.String,
  body: Schema.Unknown,
  jsdPublic: Schema.optional(Schema.Boolean),
  visibility: Schema.optional(
    Schema.NullOr(Schema.Struct({ type: Schema.String, value: Schema.String })),
  ),
});

const JiraCommentsPage = Schema.Struct({
  data: Schema.Array(JiraComment),
  pageInfo: Schema.Struct({
    hasNextPage: Schema.Boolean,
    nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  total: Schema.optional(Schema.Int),
  meta: Schema.optional(
    Schema.Struct({ pagination: Schema.optional(Schema.Struct({ total: Schema.Int })) }),
  ),
});

/**
 * A role or group restriction is its own audience. Otherwise Jira Service Management marks
 * customer-visible replies `jsdPublic`, and a Jira Software comment carries no flag at all.
 */
function commentVisibility(comment: typeof JiraComment.Type): IssueCommentVisibility | undefined {
  if (comment.visibility) return "restricted";
  if (comment.jsdPublic === false) return "internal";
  if (comment.jsdPublic === true) return "public";
  return undefined;
}

const toComment = (comment: typeof JiraComment.Type, issueUrl: string) =>
  renderJiraBody("comments", comment.body).pipe(
    Effect.map((body): IssueComment => {
      const visibility = commentVisibility(comment);
      return {
        id: comment.id,
        author: jiraActor(comment.author),
        body,
        createdAt: jiraTimestamp(comment.created),
        url: `${issueUrl}?focusedCommentId=${encodeURIComponent(comment.id)}`,
        ...(visibility === undefined ? {} : { visibility }),
      };
    }),
  );

export const decodeJiraCommentsPage = (text: string, issueUrl: string) =>
  decodeJson(JiraCommentsPage, "comments", text).pipe(
    Effect.flatMap((page) =>
      Effect.forEach(page.data, (comment) => toComment(comment, issueUrl)).pipe(
        Effect.map((comments) => ({
          comments,
          nextCursor: page.pageInfo.hasNextPage ? (page.pageInfo.nextCursor ?? null) : null,
          total: page.total ?? page.meta?.pagination?.total ?? comments.length,
        })),
      ),
    ),
  );

export const decodeJiraViewer = (text: string) =>
  decodeJson(
    Schema.Struct({
      data: Schema.Struct({
        accountId: Schema.String,
        name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    }),
    "getViewer",
    text,
  ).pipe(Effect.map((whoami) => whoami.data.name?.trim() || whoami.data.accountId));

/** `twg jira space list`, which reports the site it answered for alongside the projects. */
export const decodeJiraProjects = (text: string) =>
  decodeJson(
    Schema.Struct({
      request: Schema.Struct({ site: Schema.String }),
      data: Schema.Struct({
        startAt: Schema.optional(Schema.Int),
        total: Schema.optional(Schema.Int),
        isLast: Schema.optional(Schema.Boolean),
        projects: Schema.Array(
          Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String }),
        ),
      }),
    }),
    "status",
    text,
  ).pipe(
    Effect.map(({ request, data }) => ({
      site: request.site,
      projects: data.projects,
      nextStart:
        data.projects.length > 0 &&
        (data.isLast === false ||
          (data.total !== undefined && (data.startAt ?? 0) + data.projects.length < data.total))
          ? (data.startAt ?? 0) + data.projects.length
          : null,
    })),
  );
