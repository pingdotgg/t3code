import type {
  IssueActor,
  IssueState,
  IssueEvent,
  IssueListState,
  IssueInvolvement,
  IssueWorkflowCategory,
  IssueListSort,
  IssueListOrder,
} from "@t3tools/contracts";
import type { TrackerIssueSummary } from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { jiraRichBody } from "./jiraAdf.ts";
import { jiraIssueUrl } from "./jiraDataCenter.ts";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const BoundedText = Schema.String.check(Schema.isMaxLength(65_536));
const OptionalText = Schema.optional(Schema.String);

export const JiraUser = Schema.Struct({
  accountId: NonEmpty,
  displayName: OptionalText,
  emailAddress: OptionalText,
  avatarUrls: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export const JiraStatus = Schema.Struct({
  id: NonEmpty,
  name: NonEmpty,
  statusCategory: Schema.Struct({ key: Schema.Literals(["new", "indeterminate", "done"]) }),
});
export const JiraComment = Schema.Struct({
  id: NonEmpty,
  body: Schema.Unknown,
  author: Schema.optional(Schema.NullOr(JiraUser)),
  created: NonEmpty,
  updated: NonEmpty,
});

export const JiraHistoryEntry = Schema.Struct({
  id: NonEmpty,
  created: NonEmpty,
  author: Schema.optional(Schema.NullOr(JiraUser)),
  items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).check(Schema.isMaxLength(100)),
});

export const JiraIssue = Schema.Struct({
  id: Schema.optional(NonEmpty),
  key: NonEmpty,
  changelog: Schema.optional(
    Schema.Struct({
      startAt: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      total: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      histories: Schema.Array(JiraHistoryEntry).check(Schema.isMaxLength(100)),
    }),
  ),
  fields: Schema.Struct({
    project: Schema.optional(Schema.Struct({ id: NonEmpty, key: NonEmpty })),
    parent: Schema.optional(Schema.NullOr(Schema.Struct({ key: NonEmpty }))),
    issuetype: Schema.optional(
      Schema.Struct({ id: NonEmpty, name: NonEmpty, subtask: Schema.optional(Schema.Boolean) }),
    ),
    summary: NonEmpty,
    description: Schema.optional(Schema.Unknown),
    created: NonEmpty,
    updated: NonEmpty,
    resolutiondate: Schema.optional(Schema.NullOr(NonEmpty)),
    status: JiraStatus,
    creator: Schema.optional(Schema.NullOr(JiraUser)),
    reporter: Schema.optional(Schema.NullOr(JiraUser)),
    assignee: Schema.optional(Schema.NullOr(JiraUser)),
    labels: Schema.optional(Schema.Array(NonEmpty)),
    fixVersions: Schema.optional(
      Schema.Array(Schema.Struct({ name: NonEmpty })).check(Schema.isMaxLength(100)),
    ),
    comment: Schema.optional(
      Schema.Struct({
        total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        startAt: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        comments: Schema.optional(Schema.Array(JiraComment).check(Schema.isMaxLength(100))),
      }),
    ),
  }),
});

const RecordValue = Schema.Record(Schema.String, Schema.Unknown);
const record = Schema.decodeUnknownSync(RecordValue);
const string = Schema.decodeUnknownSync(Schema.String);
const decodeBoundedText = Schema.decodeSync(BoundedText);
const decodeJiraIssue = Schema.decodeUnknownSync(JiraIssue);

export function adfToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const root = record(value);
  if (root.type !== "doc" || root.version !== 1 || !Array.isArray(root.content)) {
    throw new Error("Invalid Jira document.");
  }
  let nodes = 0;
  let characters = 0;
  const text = (value: unknown) => {
    const result = string(value);
    characters += result.length;
    if (characters > 65_536) throw new Error("Jira document exceeds the text limit.");
    return result;
  };
  const render = (value: unknown, depth: number, parent?: unknown): string => {
    if (++nodes > 10_000 || depth > 32)
      throw new Error("Jira document exceeds the structure limit.");
    const node = record(value);
    const children = () => {
      if (!Array.isArray(node.content)) throw new Error("Invalid Jira document content.");
      return node.content.map((child) => render(child, depth + 1, node.type));
    };
    const attrs = () => record(node.attrs);
    switch (node.type) {
      case "text": {
        let result = text(node.text);
        if (node.marks !== undefined) {
          if (!Array.isArray(node.marks)) throw new Error("Invalid Jira text marks.");
          for (const value of node.marks) {
            const mark = record(value);
            if (mark.type === "link") result += " (" + text(record(mark.attrs).href) + ")";
          }
        }
        return result;
      }
      case "hardBreak":
        return "\n";
      case "mention":
        return text(attrs().text ?? attrs().id);
      case "emoji":
        return text(attrs().text ?? attrs().shortName);
      case "inlineCard":
      case "blockCard":
        return text(attrs().url);
      case "rule":
        return "---";
      case "paragraph":
      case "heading":
      case "codeBlock":
        return node.content === undefined ? "" : children().join("");
      case "blockquote":
      case "panel":
      case "expand":
      case "nestedExpand":
      case "listItem":
      case "tableCell":
      case "tableHeader":
        return children().join("\n\n");
      case "taskList": {
        string(attrs().localId);
        if (
          !Array.isArray(node.content) ||
          node.content.length === 0 ||
          record(node.content[0]).type !== "taskItem" ||
          node.content.some(
            (child) => !["taskItem", "taskList"].includes(string(record(child).type)),
          )
        )
          throw new Error("Invalid Jira task list.");
        return children().join("\n");
      }
      case "taskItem": {
        if (parent !== "taskList") throw new Error("Invalid Jira task parent.");
        const attributes = attrs();
        string(attributes.localId);
        if (attributes.state !== "TODO" && attributes.state !== "DONE")
          throw new Error("Invalid Jira task state.");
        if (
          node.content !== undefined &&
          (!Array.isArray(node.content) ||
            node.content.some(
              (child) =>
                !["text", "hardBreak", "mention", "emoji", "inlineCard", "date", "status"].includes(
                  string(record(child).type),
                ),
            ))
        )
          throw new Error("Invalid Jira task content.");
        return (
          (attributes.state === "DONE" ? "- [x] " : "- [ ] ") +
          (node.content === undefined ? "" : children().join(""))
        );
      }
      case "bulletList":
        return children()
          .map((child) => "- " + child)
          .join("\n");
      case "orderedList": {
        const order = node.attrs === undefined ? undefined : attrs().order;
        const start =
          typeof order === "number" && Number.isInteger(order) && order >= 0 ? order : 1;
        return children()
          .map((child, index) => String(index + start) + ". " + child)
          .join("\n");
      }
      case "tableRow":
        return children().join(" | ");
      case "table":
        return children().join("\n");
      case "media": {
        const attributes = attrs();
        return text(attributes.alt ?? "[Attachment " + string(attributes.id) + "]");
      }
      case "mediaSingle":
      case "mediaGroup":
        return children().join("\n");
      case "date":
        return text(attrs().timestamp);
      case "status":
        return text(attrs().text);
      default:
        throw new Error("Unsupported Jira document node.");
    }
  };
  const result = root.content.map((node) => render(node, 0)).join("\n\n");
  if (result.length > 65_536) throw new Error("Jira document exceeds the text limit.");
  return result;
}

export function jiraBodyText(value: unknown): string {
  if (typeof value === "string") return decodeBoundedText(value);
  try {
    return adfToText(value);
  } catch (error) {
    if (jiraRichBody(value) !== undefined) return "[Rich Jira content]";
    throw error;
  }
}

export function jiraBodyEditable(value: unknown): boolean {
  if (typeof value === "string") {
    decodeBoundedText(value);
    return false;
  }
  if (jiraRichBody(value) !== undefined) {
    try {
      return isEditableAdf(value);
    } catch {
      return false;
    }
  }
  return isEditableAdf(value);
}

export function isEditableAdf(value: unknown): boolean {
  adfToText(value);
  if (value === null) return true;
  if (value === undefined) return false;
  const root = record(value);
  return (
    Object.keys(root).every((key) => ["type", "version", "content"].includes(key)) &&
    Array.isArray(root.content) &&
    root.content.every((value) => {
      const paragraph = record(value);
      return (
        paragraph.type === "paragraph" &&
        Object.keys(paragraph).every((key) => ["type", "content"].includes(key)) &&
        (paragraph.content === undefined ||
          (Array.isArray(paragraph.content) &&
            paragraph.content.every((value) => {
              const node = record(value);
              return node.type === "text"
                ? Object.keys(node).every((key) => ["type", "text"].includes(key))
                : node.type === "hardBreak" && Object.keys(node).every((key) => key === "type");
            })))
      );
    })
  );
}

export function textToAdf(value: string) {
  const text = decodeBoundedText(value);
  const document = {
    type: "doc",
    version: 1,
    content: text.split("\n\n").map((paragraph) => ({
      type: "paragraph",
      content:
        paragraph === ""
          ? []
          : paragraph
              .split("\n")
              .flatMap((line, index) => [
                ...(index === 0 ? [] : [{ type: "hardBreak" }]),
                ...(line === "" ? [] : [{ type: "text", text: line }]),
              ]),
    })),
  };
  adfToText(document);
  return document;
}

export function jiraActor(user: typeof JiraUser.Type): IssueActor {
  return {
    id: user.accountId,
    login: user.displayName?.trim() || user.accountId,
    name: user.displayName ?? null,
    avatarUrl: user.avatarUrls?.["48x48"] ?? null,
  };
}

export function jiraDate(value: string): string {
  return DateTime.formatIso(DateTime.makeUnsafe(value));
}

export function jiraState(status: typeof JiraStatus.Type): IssueState {
  return {
    id: status.id,
    name: status.name,
    category: status.statusCategory.key === "done" ? "closed" : "open",
    workflowCategory:
      status.statusCategory.key === "done"
        ? "completed"
        : status.statusCategory.key === "indeterminate"
          ? "started"
          : "unstarted",
  };
}

export function normalizeJiraIssue(value: unknown, host: string): TrackerIssueSummary {
  const raw = decodeJiraIssue(value);
  const fields = raw.fields;
  return {
    key: raw.key,
    displayKey: raw.key,
    title: fields.summary,
    url: jiraIssueUrl(host, raw.key),
    state: jiraState(fields.status),
    author: fields.creator ? jiraActor(fields.creator) : null,
    createdAt: jiraDate(fields.created),
    updatedAt: jiraDate(fields.updated),
    closedAt: fields.resolutiondate ? jiraDate(fields.resolutiondate) : null,
    assignees: fields.assignee ? [jiraActor(fields.assignee)] : [],
    labels: (fields.labels ?? []).map((name) => ({ name, color: null })),
    milestone: fields.fixVersions?.map((version) => version.name).join(", ") || null,
    commentCount: fields.comment?.total ?? 0,
  };
}

export const quoteJiraJql = (value: string) =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

export function buildJql(input: {
  readonly scope: string;
  readonly state: IssueListState;
  readonly involvement: IssueInvolvement;
  readonly query?: string | undefined;
  readonly stateCategories?: ReadonlyArray<IssueWorkflowCategory> | undefined;
  readonly sort?: IssueListSort | undefined;
  readonly order?: IssueListOrder | undefined;
}): string | null {
  const clauses = ["project = " + quoteJiraJql(input.scope)];
  if (input.stateCategories !== undefined) {
    const categories = [
      ...new Set(
        input.stateCategories.flatMap((category) =>
          category === "completed"
            ? ["done"]
            : category === "started"
              ? ["indeterminate"]
              : category === "unstarted"
                ? ["new"]
                : [],
        ),
      ),
    ];
    if (categories.length === 0) return null;
    clauses.push("statusCategory IN (" + categories.map(quoteJiraJql).join(", ") + ")");
  } else if (input.state !== "all")
    clauses.push(input.state === "closed" ? 'statusCategory = "done"' : 'statusCategory != "done"');
  if (input.involvement === "assigned") clauses.push("assignee = currentUser()");
  if (input.involvement === "authored") clauses.push("creator = currentUser()");
  if (input.involvement === "mentioned")
    throw new Error("Jira does not support mention filtering.");
  if (input.query !== undefined) clauses.push("text ~ " + quoteJiraJql(input.query));
  if (input.sort === "comments") throw new Error("Jira does not support sorting by comment count.");
  return (
    clauses.join(" AND ") +
    " ORDER BY " +
    (input.sort === "created" ? "created" : "updated") +
    " " +
    (input.order === "asc" ? "ASC" : "DESC")
  );
}

export function jiraEvents(
  entries: ReadonlyArray<{
    readonly id: string;
    readonly created: string;
    readonly author?: typeof JiraUser.Type | null | undefined;
    readonly items: ReadonlyArray<Record<string, unknown>>;
  }>,
): IssueEvent[] {
  const events: IssueEvent[] = [];
  for (const entry of entries) {
    for (const [index, item] of entry.items.entries()) {
      const field = item.field;
      const read = (key: string) => (Object.hasOwn(item, key) ? item[key] : undefined);
      const to = read("toString");
      const from = read("fromString");
      const detail = typeof to === "string" && to.trim() ? to : null;
      const kind =
        field === "status"
          ? "state-changed"
          : field === "summary"
            ? "renamed"
            : field === "assignee"
              ? detail === null
                ? "unassigned"
                : "assigned"
              : "updated";
      if (typeof field !== "string" || field.trim() === "")
        throw new Error("Invalid Jira history field.");
      const subject = detail ?? (typeof from === "string" && from.trim() ? from : null);
      events.push({
        id: entry.id + ":" + index,
        kind,
        detail:
          kind === "updated"
            ? field +
              ": " +
              (typeof from === "string" ? from : "none") +
              " → " +
              (typeof to === "string" ? to : "none")
            : subject,
        actor: entry.author ? jiraActor(entry.author) : null,
        createdAt: jiraDate(entry.created),
      });
    }
  }
  return events;
}
