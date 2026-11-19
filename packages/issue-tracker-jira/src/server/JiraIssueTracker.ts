/**
 * Jira Cloud as an issue tracker. A scope is a project key (`ENG`) and an issue key its own
 * (`ENG-123`). A status is closed when its category is `done`; moving between statuses goes
 * through the workflow transitions Jira offers for the issue, never a status set directly.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  IssueActor,
  IssueCapabilities,
  IssueComment,
  IssueEvent,
  IssueState,
  IssueViewerPermissions,
  StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueInvolvementFilter,
  type StandaloneIssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

import { JIRA_HOST, parseJiraIssueUrl } from "../shared/issueUrl.ts";
import * as JiraApi from "./JiraApi.ts";
import { adfToMarkdown, hasJiraOnlyContent, markdownToAdf } from "./jiraAdf.ts";

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: JiraApi.KIND,
  displayName: "Jira",
  host: JIRA_HOST,
  scopeNoun: "project",
  credential: {
    label: "Personal API token",
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      { key: "site", label: "Site (example.atlassian.net)", secret: false },
      { key: "email", label: "Email", secret: false },
      { key: "token", label: "API token (without scopes)", secret: true },
    ],
  },
};

/** Reactions and templates have no public Jira Cloud API; linked PRs live in a private one. */
const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: true,
  search: true,
};

/** Everything granted: Jira refuses a write the account may not make, and says why. */
const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

const COMMENTS_PAGE = 50;
const CANDIDATES = 100;
const KEY = /^[A-Za-z][A-Za-z0-9_]*-[1-9]\d*$/;
const PROJECT = /^[A-Za-z][A-Za-z0-9_]*$/;

/** `ENG-123`, or null for anything that is not a Jira key. */
function parseKey(key: string): string | null {
  return KEY.test(key.trim()) ? key.trim().toUpperCase() : null;
}

/** A JQL string literal: Jira reads backslash escapes inside double quotes. */
export function jqlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Jira answers with `+0000` offsets; the contract carries ISO 8601 with a `Z`. */
function isoDate(value: string): string {
  return Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });
}

function toState(status: JiraApi.JiraStatus): IssueState {
  return status.statusCategory.key === "done"
    ? { category: "closed", name: status.name, closeReason: "completed" }
    : { category: "open", name: status.name };
}

/**
 * The login is the display name, which is what people see and filter by: Jira Cloud has no
 * handle. Writes and filters name people by account id, which `requireAccountId` resolves.
 */
function toActor(user: JiraApi.JiraUser): IssueActor {
  return {
    login: user.displayName?.trim() || user.accountId,
    name: user.displayName?.trim() || null,
    avatarUrl: user.avatarUrls?.["48x48"] ?? null,
  };
}

/** Jira Cloud account ids: 24 hex digits, or `<n>:<uuid>`. */
const ACCOUNT_ID = /^(?:[0-9a-z]{24}|\d+:[0-9a-f-]{36})$/i;

const issueUrl = (site: string, key: string) => `https://${site}.atlassian.net/browse/${key}`;

/** A search reports no comment totals cheaply, so a listing shows no comment count. */
function toSummary(site: string, issue: JiraApi.JiraIssue, commentCount = 0): TrackerIssueSummary {
  const fields = issue.fields;
  const author = fields.reporter ?? fields.creator ?? null;
  const closed = fields.status.statusCategory.key === "done";
  return {
    key: issue.key,
    displayKey: issue.key,
    title: fields.summary.trim() || issue.key,
    url: issueUrl(site, issue.key),
    author: author === null ? null : toActor(author),
    state: toState(fields.status),
    createdAt: isoDate(fields.created),
    updatedAt: isoDate(fields.updated),
    closedAt: closed && fields.resolutiondate ? isoDate(fields.resolutiondate) : null,
    assignees: fields.assignee ? [toActor(fields.assignee)] : [],
    labels: (fields.labels ?? []).map((name) => ({ name, color: null })),
    commentCount,
  };
}

function toComment(site: string, key: string, comment: JiraApi.JiraComment): IssueComment {
  return {
    id: comment.id,
    author: comment.author ? toActor(comment.author) : null,
    body: adfToMarkdown(comment.body),
    createdAt: isoDate(comment.created),
    url: `${issueUrl(site, key)}?focusedCommentId=${encodeURIComponent(comment.id)}`,
  };
}

/** Jira's changelog names fields by their display name; only the common vocabulary is kept. */
function toEvents(histories: ReadonlyArray<JiraApi.JiraHistory>): IssueEvent[] {
  const events: IssueEvent[] = [];
  for (const history of histories) {
    const actor = history.author ? toActor(history.author) : null;
    const createdAt = isoDate(history.created);
    history.items.forEach((item, index) => {
      const add = (kind: IssueEvent["kind"], detail: string | null | undefined, suffix = "") =>
        events.push({
          id: `${history.id}:${index}${suffix}`,
          kind,
          actor,
          createdAt,
          detail: detail?.trim() || null,
        });
      switch (item.field) {
        case "status":
          add("state-changed", item.toString);
          break;
        case "resolution":
          add(item.toString ? "closed" : "reopened", item.toString);
          break;
        case "summary":
          add("renamed", item.toString);
          break;
        case "assignee":
          if (item.fromString) add("unassigned", item.fromString, "-");
          if (item.toString) add("assigned", item.toString, "+");
          break;
        case "labels": {
          // Labels arrive as the whole space-separated set before and after.
          const before = new Set((item.fromString ?? "").split(" ").filter(Boolean));
          const after = new Set((item.toString ?? "").split(" ").filter(Boolean));
          for (const label of after) if (!before.has(label)) add("labeled", label, `+${label}`);
          for (const label of before) if (!after.has(label)) add("unlabeled", label, `-${label}`);
          break;
        }
      }
    });
  }
  return events;
}

/** JQL names the signed-in account itself, so the viewer's display name is never matched on. */
function involvementClause(input: IssueInvolvementFilter): string | null {
  switch (input.involvement) {
    case "assigned":
      return "assignee = currentUser()";
    case "authored":
      return "reporter = currentUser()";
    case "mentioned":
      return "watcher = currentUser()";
    case "all":
      return null;
  }
}

/**
 * A comment cursor is the offset of the next older page, counted from the newest comment, so a
 * comment added meanwhile shifts it by one at most and only repeats a comment the client drops.
 */
function parseCursor(cursor: string): number | null {
  return /^[1-9]\d{0,8}$/.test(cursor) ? Number(cursor) : null;
}

const notFound = (operation: string) =>
  new IssueTrackerError({
    tracker: JiraApi.KIND,
    operation,
    reason: "not-found",
    detail: "Jira has no issue by that key, or this account cannot see it.",
  });

const failed = (operation: string, detail: string) =>
  new IssueTrackerError({ tracker: JiraApi.KIND, operation, reason: "failed", detail });

export const make: Effect.Effect<StandaloneIssueTrackerApi, never, JiraApi.JiraApi> = Effect.gen(
  function* () {
    const jira = yield* JiraApi.JiraApi;

    const requireKey = (operation: string, key: string) => {
      const parsed = parseKey(key);
      return parsed === null ? Effect.fail(notFound(operation)) : Effect.succeed(parsed);
    };

    const requireProject = (operation: string, scope: string) => {
      const project = scope.trim().toUpperCase();
      return PROJECT.test(project)
        ? Effect.succeed(project)
        : Effect.fail(failed(operation, `"${scope}" is not a Jira project key.`));
    };

    /**
     * The issue a write names, refused unless it sits in the bound project: a key from another
     * project, or an issue moved away, still resolves in Jira.
     */
    const requireProjectIssue = Effect.fn("JiraIssueTracker.requireProjectIssue")(function* (
      operation: string,
      input: { readonly scope: string; readonly key: string },
    ) {
      const key = yield* requireKey(operation, input.key);
      const project = yield* requireProject(operation, input.scope);
      const issue = yield* jira.getIssue(key);
      if (issue === null) return yield* notFound(operation);
      if (issue.fields.project.key.toUpperCase() !== project) {
        return yield* failed(
          operation,
          `${issue.key} belongs to Jira project ${issue.fields.project.key}, not ${project}.`,
        );
      }
      return issue;
    });

    /** The comments page that ends `offset` comments back from the newest, oldest first. */
    const commentsPage = Effect.fn("JiraIssueTracker.commentsPage")(function* (
      key: string,
      offset: number,
    ) {
      const [site, page] = yield* Effect.all([
        jira.site,
        jira.getComments({ key, startAt: offset, limit: COMMENTS_PAGE }),
      ]);
      const next = offset + page.comments.length;
      return {
        total: page.total,
        page: {
          comments: page.comments.map((comment) => toComment(site, key, comment)).toReversed(),
          nextCursor: page.comments.length > 0 && next < page.total ? String(next) : null,
        },
      };
    });

    /** Names as Jira stores them: one word each, since Jira splits labels on whitespace. */
    const requireLabels = (operation: string, labels: ReadonlyArray<string>) => {
      const bad = labels.find((label) => /\s/.test(label.trim()) || label.trim() === "");
      return bad === undefined
        ? Effect.succeed(labels.map((label) => label.trim()))
        : Effect.fail(failed(operation, `Jira labels cannot contain spaces: "${bad}".`));
    };

    /** An account id as given, else the project's one assignable person by that display name. */
    const requireAccountId = Effect.fn("JiraIssueTracker.requireAccountId")(function* (
      operation: string,
      project: string,
      person: string,
    ) {
      const name = person.trim();
      if (ACCOUNT_ID.test(name)) return name;
      const users = yield* jira.assignableUsers({ project, query: name, limit: CANDIDATES });
      const matches = users.filter(
        (user) => user.displayName?.trim().toLowerCase() === name.toLowerCase(),
      );
      if (matches.length === 1) return matches[0]!.accountId;
      return yield* failed(
        operation,
        matches.length === 0
          ? `"${name}" cannot be assigned issues in Jira project ${project}.`
          : `More than one person in Jira project ${project} is named "${name}".`,
      );
    });

    /** One assignee at most: a Jira issue has a single assignee. */
    const requireAssignee = Effect.fn("JiraIssueTracker.requireAssignee")(function* (
      operation: string,
      project: string,
      assignees: ReadonlyArray<string>,
    ) {
      const [first, ...rest] = assignees;
      if (first === undefined) return null;
      if (rest.length > 0)
        return yield* failed(operation, "A Jira issue has one assignee at most.");
      return { accountId: yield* requireAccountId(operation, project, first) };
    });

    const api: StandaloneIssueTrackerApi = {
      kind: JiraApi.KIND,
      capabilities: CAPABILITIES,
      standalone: DESCRIPTOR,
      parseIssueUrl: parseJiraIssueUrl,

      probeCredential: (credential) =>
        jira.probe(credential).pipe(
          Effect.map((probe) => ({
            account:
              probe.user.displayName?.trim() || probe.user.emailAddress || probe.user.accountId,
            workspace: probe.site,
            scopes: probe.projects,
          })),
        ),

      getViewer: () => jira.myself.pipe(Effect.map((user) => toActor(user).login)),

      listIssues: Effect.fn("JiraIssueTracker.listIssues")(function* (input) {
        const project = yield* requireProject("listIssues", input.scope);
        const text = input.query?.trim() ?? "";
        const reference = /^(?:[A-Za-z][A-Za-z0-9_]*-|#)?(\d+)$/.exec(text);
        const involvement = involvementClause(input);
        const clauses = [
          `project = ${jqlString(project)}`,
          ...(input.state === "all"
            ? []
            : [`statusCategory ${input.state === "closed" ? "=" : "!="} Done`]),
          ...(involvement === null ? [] : [involvement]),
          ...(input.assignee === undefined
            ? []
            : [
                `assignee = ${jqlString(yield* requireAccountId("listIssues", project, input.assignee))}`,
              ]),
          ...(input.labels ?? []).map((label) => `labels = ${jqlString(label)}`),
          ...(text === ""
            ? []
            : [
                reference === null
                  ? `text ~ ${jqlString(text)}`
                  : `(text ~ ${jqlString(text)} OR key = ${jqlString(`${project}-${reference[1]}`)})`,
              ]),
        ];
        const order = input.sort === "created" ? "created" : "updated";
        const [site, page] = yield* Effect.all([
          jira.site,
          jira.search({
            jql: `${clauses.join(" AND ")} ORDER BY ${order} DESC`,
            limit: input.limit,
            cursor: input.cursor,
          }),
        ]);
        return {
          items: page.issues.map((issue) => toSummary(site, issue)),
          nextCursor: page.nextCursor,
        };
      }),

      getIssue: Effect.fn("JiraIssueTracker.getIssue")(function* (input) {
        const key = yield* requireKey("getIssue", input.key);
        const [site, issue, viewer] = yield* Effect.all([
          jira.site,
          jira.getIssue(key),
          jira.myself.pipe(
            Effect.map((user) => toActor(user).login),
            Effect.orElseSucceed(() => null),
          ),
        ]);
        if (issue === null) return yield* notFound("getIssue");
        const comments = yield* commentsPage(key, 0);
        // A transition's target is a state the issue can move to; the current one is listed too.
        const states = [issue.fields.status, ...(issue.transitions ?? []).map((t) => t.to)];
        const seen = new Set<string>();
        return {
          ...toSummary(site, issue, comments.total),
          body: adfToMarkdown(issue.fields.description),
          viewer,
          viewerPermissions: VIEWER_PERMISSIONS,
          states: states
            .filter((status) => !seen.has(status.name) && seen.add(status.name) !== undefined)
            .map(toState),
          comments: comments.page.comments,
          commentsCursor: comments.page.nextCursor,
          events: toEvents(issue.changelog?.histories ?? []),
          linkedPullRequests: [],
        };
      }),

      getComments: Effect.fn("JiraIssueTracker.getComments")(function* (input) {
        const key = yield* requireKey("getComments", input.key);
        const offset = parseCursor(input.cursor);
        if (offset === null)
          return yield* failed("getComments", "The cursor was not one Jira handed out.");
        return (yield* commentsPage(key, offset)).page;
      }),

      create: Effect.fn("JiraIssueTracker.create")(function* (input) {
        const project = yield* requireProject("create", input.scope);
        const labels = yield* requireLabels("create", input.labels);
        const assignee = yield* requireAssignee("create", project, input.assignees);
        const types = yield* jira.issueTypes(project);
        // The project's first standard type, as Jira's own create dialog picks by default.
        const type = types.find((candidate) => candidate.subtask !== true);
        if (type === undefined)
          return yield* failed(
            "create",
            `Jira project ${project} has no issue type to file under.`,
          );
        const key = yield* jira.createIssue({
          project: { key: project },
          issuetype: { id: type.id },
          summary: input.title,
          ...(input.body.trim() === "" ? {} : { description: markdownToAdf(input.body) }),
          ...(labels.length === 0 ? {} : { labels }),
          ...(assignee === null ? {} : { assignee }),
        });
        const site = yield* jira.site;
        return { key, displayKey: key, url: issueUrl(site, key) };
      }),

      comment: Effect.fn("JiraIssueTracker.comment")(function* (input) {
        const issue = yield* requireProjectIssue("comment", input);
        yield* jira.addComment(issue.key, markdownToAdf(input.body));
      }),

      update: Effect.fn("JiraIssueTracker.update")(function* (input) {
        const issue = yield* requireProjectIssue("update", input);
        // The Markdown a client edited lost these nodes on read; writing it back would delete them.
        if (input.body !== undefined && hasJiraOnlyContent(issue.fields.description)) {
          return yield* failed(
            "update",
            "This description has attachments or other content only Jira can edit. Edit it in Jira.",
          );
        }
        yield* jira.updateIssue(issue.key, {
          ...(input.title === undefined ? {} : { summary: input.title }),
          ...(input.body === undefined
            ? {}
            : { description: input.body.trim() === "" ? null : markdownToAdf(input.body) }),
          ...(input.labels === undefined
            ? {}
            : { labels: yield* requireLabels("update", input.labels) }),
          ...(input.assignees === undefined
            ? {}
            : {
                assignee: yield* requireAssignee(
                  "update",
                  issue.fields.project.key,
                  input.assignees,
                ),
              }),
        });
      }),

      setState: Effect.fn("JiraIssueTracker.setState")(function* (input) {
        const issue = yield* requireProjectIssue("setState", input);
        if (issue.fields.status.name === input.state) return;
        const transition = (issue.transitions ?? []).find((t) => t.to.name === input.state);
        if (transition === undefined) {
          return yield* failed(
            "setState",
            `Jira's workflow offers no move from "${issue.fields.status.name}" to "${input.state}".`,
          );
        }
        yield* jira.transition(issue.key, transition.id);
      }),

      listCandidates: Effect.fn("JiraIssueTracker.listCandidates")(function* (input) {
        const project = yield* requireProject("listCandidates", input.scope);
        const [labels, users] = yield* Effect.all([
          jira.labels(CANDIDATES),
          jira.assignableUsers({ project, limit: CANDIDATES }),
        ]);
        return {
          labels: labels.values.map((name) => ({ name, color: null, description: null })),
          assignees: users.map((user) => ({ ...toActor(user), id: user.accountId })),
          truncated: labels.truncated || users.length >= CANDIDATES,
        };
      }),
    };
    return api;
  },
);
