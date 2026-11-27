/**
 * Jira Cloud as an issue tracker. A scope is a project key (`ENG`) and an issue key its own
 * (`ENG-123`). A status is closed when its category is Done. An issue moves only along the
 * transitions its workflow offers from where it stands, so those are the states a detail lists.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  type IssueActor,
  type IssueCapabilities,
  type IssueComment,
  type IssueEvent,
  type IssueInvolvement,
  type IssueState,
  type IssueViewerPermissions,
  type StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import type {
  IssueTrackerError,
  StandaloneIssueTrackerApi,
  TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";

import { adfToMarkdown, hasUnwritableContent, markdownToAdf } from "./adf.ts";
import * as JiraApi from "./JiraApi.ts";

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: JiraApi.KIND,
  displayName: "Jira",
  // Every Jira Cloud site; the one this server reads is part of the saved credential.
  host: "atlassian.net",
  scopeNoun: "project",
  credential: {
    label: "API token",
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      { key: "site", label: "Site", placeholder: "yourteam.atlassian.net" },
      { key: "email", label: "Account email", placeholder: "you@example.com" },
    ],
  },
};

/** `https://<site>.atlassian.net/browse/<PROJECT>-<n>`, keeping the site as the workspace. */
export function parseJiraIssueUrl(url: URL) {
  const site = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !site.endsWith(`.${DESCRIPTOR.host}`)) return null;
  const [, resource, key] = url.pathname.split("/");
  if (resource !== "browse" || key === undefined) return null;
  const scope = /^([A-Z][A-Z0-9_]*)-[1-9][0-9]*$/.exec(key)?.[1];
  return scope === undefined ? null : { host: DESCRIPTOR.host, workspace: site, scope, key };
}

/** No reactions or development panel: Jira Cloud's public API serves neither. */
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

const EVERYTHING: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: true,
  assignees: true,
};

const COMMENTS_PAGE = 50;
const CATEGORY_ORDER = ["new", "indeterminate", "done"];

/** Jira writes `+0000` where ISO 8601 has `+00:00`. */
function iso(value: string): string {
  const spelled = value.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2");
  return Option.match(DateTime.make(spelled), {
    onNone: () => value,
    onSome: DateTime.formatIso,
  });
}

const isClosed = (status: JiraApi.JiraStatus) => status.statusCategory?.key === "done";

const toState = (status: JiraApi.JiraStatus): IssueState => ({
  category: isClosed(status) ? "closed" : "open",
  name: status.name,
});

/**
 * The login is the display name, which is all Jira Cloud shows of a person; the account id that
 * filters and writes need is looked up from it inside this adapter.
 */
function toActor(user: JiraApi.JiraUser): IssueActor {
  return {
    ...(user.accountType === "app" ? { isBot: true } : {}),
    login: user.displayName?.trim() || user.accountId,
    name: user.displayName ?? null,
    avatarUrl: user.avatarUrls?.["48x48"] ?? null,
  };
}

const actorOf = (user: JiraApi.JiraUser | null | undefined) =>
  user == null ? null : toActor(user);

function toSummary(
  issue: JiraApi.JiraIssue,
  origin: string,
  commentCount = 0,
): TrackerIssueSummary {
  const { fields } = issue;
  return {
    key: issue.key,
    displayKey: issue.key,
    title: fields.summary,
    url: `${origin}/browse/${issue.key}`,
    author: actorOf(fields.reporter),
    state: toState(fields.status),
    createdAt: iso(fields.created),
    updatedAt: iso(fields.updated),
    closedAt:
      isClosed(fields.status) && fields.resolutiondate != null ? iso(fields.resolutiondate) : null,
    assignees: fields.assignee == null ? [] : [toActor(fields.assignee)],
    labels: (fields.labels ?? []).map((name) => ({ name, color: null })),
    commentCount,
  };
}

/** Where the issue stands and everywhere its workflow lets this account move it, in board order. */
function toStates(issue: JiraApi.JiraIssue): IssueState[] {
  const transitions = issue.transitions ?? [];
  if (transitions.length === 0) return [];
  const byName = new Map(
    [issue.fields.status, ...transitions.map((transition) => transition.to)].map((status) => [
      status.name,
      status,
    ]),
  );
  const rank = (status: JiraApi.JiraStatus) => {
    const index = CATEGORY_ORDER.indexOf(status.statusCategory?.key ?? "");
    return index === -1 ? 1 : index;
  };
  return [...byName.values()].toSorted((a, b) => rank(a) - rank(b)).map(toState);
}

function toComment(comment: JiraApi.JiraComment, issueUrl: string): IssueComment {
  return {
    id: comment.id,
    author: actorOf(comment.author),
    body: adfToMarkdown(comment.body),
    createdAt: iso(comment.created),
    url: `${issueUrl}?focusedCommentId=${comment.id}`,
  };
}

const words = (value: string | null | undefined) =>
  (value ?? "").split(/\s+/u).filter((word) => word.length > 0);

/** Jira records a resolution beside the status change that closes or reopens an issue. */
function toEvents(histories: ReadonlyArray<JiraApi.JiraHistory>): IssueEvent[] {
  const events: IssueEvent[] = [];
  for (const entry of histories) {
    const add = (kind: IssueEvent["kind"], detail: string | null, suffix: string) =>
      events.push({
        id: `${entry.id}:${suffix}`,
        kind,
        actor: actorOf(entry.author),
        createdAt: iso(entry.created),
        detail: detail?.trim() || null,
      });
    const resolution = entry.items.find((item) => item.field === "resolution");
    for (const [index, item] of entry.items.entries()) {
      const from = item.fromString ?? null;
      const to = item.toString ?? null;
      switch (item.field) {
        case "status":
          add(
            resolution === undefined
              ? "state-changed"
              : resolution.toString != null
                ? "closed"
                : "reopened",
            to,
            `status${index}`,
          );
          break;
        case "labels": {
          const before = new Set(words(from));
          const after = new Set(words(to));
          for (const label of after)
            if (!before.has(label)) add("labeled", label, `label+${label}`);
          for (const label of before)
            if (!after.has(label)) add("unlabeled", label, `label-${label}`);
          break;
        }
        case "assignee":
          if (from !== null) add("unassigned", from, `unassigned${index}`);
          if (to !== null) add("assigned", to, `assigned${index}`);
          break;
        case "summary":
          if (to !== null) add("renamed", to, `summary${index}`);
          break;
      }
    }
  }
  return events;
}

/** A JQL string literal. */
const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

function involvementClause(involvement: IssueInvolvement): string | null {
  switch (involvement) {
    case "assigned":
      return "assignee = currentUser()";
    case "authored":
      return "reporter = currentUser()";
    // Jira cannot search for mentions of a person; watching is the nearest it keeps.
    case "mentioned":
      return "watcher = currentUser()";
    case "all":
      return null;
  }
}

const sameText = (a: string | null | undefined, b: string) =>
  a != null && a.trim().toLowerCase() === b.trim().toLowerCase();

const matchesUser = (user: JiraApi.JiraUser, named: string) =>
  user.accountId === named ||
  sameText(user.displayName, named) ||
  sameText(user.emailAddress, named);

export const make: Effect.Effect<StandaloneIssueTrackerApi, never, JiraApi.JiraApi> = Effect.gen(
  function* () {
    const jira = yield* JiraApi.JiraApi;

    const notFound = (operation: string) =>
      JiraApi.fail(
        operation,
        "not-found",
        "Jira has no issue by that key, or this account cannot see it.",
      );

    const projectKey = (scope: string) => scope.trim().toUpperCase();

    const requireKey = (operation: string, key: string) => {
      const trimmed = key.trim().toUpperCase();
      return /^[A-Z][A-Z0-9_]*-[1-9]\d*$/u.test(trimmed)
        ? Effect.succeed(trimmed)
        : Effect.fail(notFound(operation));
    };

    /** The key a write names, refused unless it is one of the bound project's. */
    const requireProjectKey = Effect.fn("JiraIssueTracker.requireProjectKey")(function* (
      operation: string,
      input: { readonly scope: string; readonly key: string },
    ) {
      const key = yield* requireKey(operation, input.key);
      const project = projectKey(input.scope);
      if (!key.startsWith(`${project}-`)) {
        return yield* JiraApi.fail(
          operation,
          "failed",
          `${key} does not belong to Jira project ${project}.`,
        );
      }
      return key;
    });

    /** The account a client named by display name, email or id, among those the project assigns. */
    const accountId = Effect.fn("JiraIssueTracker.accountId")(function* (
      operation: string,
      scope: string,
      assignees: ReadonlyArray<string>,
    ): Effect.fn.Return<string | null, IssueTrackerError> {
      const [first, ...rest] = assignees;
      if (first === undefined) return null;
      if (rest.length > 0) {
        return yield* JiraApi.fail(operation, "failed", "A Jira issue has one assignee at most.");
      }
      const { users } = yield* jira.assignable(projectKey(scope));
      // Jira hides users after paging, so the pages read never prove someone is missing.
      const found =
        users.find((user) => matchesUser(user, first)) ??
        (yield* jira.findUsers(first)).find((user) => matchesUser(user, first));
      if (found === undefined) {
        return yield* JiraApi.fail(
          operation,
          "failed",
          `"${first}" cannot be assigned issues in this Jira project.`,
        );
      }
      return found.accountId;
    });

    const labelNames = (operation: string, labels: ReadonlyArray<string>) =>
      Effect.forEach(labels, (label) =>
        /\s/u.test(label.trim())
          ? Effect.fail(
              JiraApi.fail(operation, "failed", `A Jira label has no spaces: "${label}".`),
            )
          : Effect.succeed(label.trim()),
      );

    const api: StandaloneIssueTrackerApi = {
      kind: JiraApi.KIND,
      capabilities: CAPABILITIES,
      standalone: DESCRIPTOR,
      parseIssueUrl: parseJiraIssueUrl,

      probeCredential: (credential) =>
        Effect.all([jira.myself(credential), jira.projects(credential)], {
          concurrency: 2,
        }).pipe(
          Effect.map(([me, projects]) => ({
            account: me.displayName?.trim() || me.emailAddress?.trim() || me.accountId,
            workspace: URL.parse(JiraApi.siteOrigin(credential.fields["site"] ?? "") ?? "")
              ?.hostname,
            scopes: projects.flatMap((project) =>
              project.key.trim() && project.name.trim()
                ? [{ key: project.key, name: project.name }]
                : [],
            ),
          })),
        ),

      getViewer: () => jira.myself().pipe(Effect.map((me) => toActor(me).login)),

      listIssues: Effect.fn("JiraIssueTracker.listIssues")(function* (input) {
        const project = projectKey(input.scope);
        const origin = yield* jira.origin;
        // The filter names a person as issues do; JQL is only exact about an account id.
        const assignee =
          input.assignee === undefined
            ? null
            : ((yield* jira.findUsers(input.assignee)).find((user) =>
                sameText(user.displayName, input.assignee!),
              )?.accountId ?? input.assignee);
        // `ENG-12`, `#12` or `12` also asks for that one issue of this project.
        const reference =
          input.query === undefined
            ? null
            : new RegExp(`^(?:${project}-|#)?([1-9]\\d*)$`, "iu").exec(input.query.trim());
        const jql = (withReference: boolean) =>
          [
            `project = ${quoted(project)}`,
            ...(input.state === "all"
              ? []
              : [`statusCategory ${input.state === "closed" ? "=" : "!="} Done`]),
            ...[involvementClause(input.involvement)].filter((clause) => clause !== null),
            ...(assignee === null ? [] : [`assignee = ${quoted(assignee)}`]),
            ...(input.labels ?? []).map((label) => `labels = ${quoted(label)}`),
            ...(input.query === undefined
              ? []
              : [
                  reference !== null && withReference
                    ? `(text ~ ${quoted(input.query)} OR key = ${quoted(`${project}-${reference[1]}`)})`
                    : `text ~ ${quoted(input.query)}`,
                ]),
          ].join(" AND ") + ` ORDER BY ${input.sort === "created" ? "created" : "updated"} DESC`;
        const run = (withReference: boolean) =>
          jira.search({ jql: jql(withReference), limit: input.limit, pageToken: input.cursor });
        const page = yield* run(true).pipe(
          // Jira refuses the whole query over a key that names no issue.
          Effect.catchIf(
            (error) => reference !== null && error.reason === "failed",
            () => run(false),
          ),
        );
        return {
          items: page.issues.map((issue) => toSummary(issue, origin)),
          nextCursor: page.nextPageToken,
        };
      }),

      getIssue: Effect.fn("JiraIssueTracker.getIssue")(function* (input) {
        const key = yield* requireKey("getIssue", input.key);
        const [origin, issue, page, allowed, me] = yield* Effect.all(
          [
            jira.origin,
            jira.getIssue(key),
            jira.getComments({ key, startAt: 0, limit: COMMENTS_PAGE }),
            jira
              .permissions(key, [
                "TRANSITION_ISSUES",
                "ADD_COMMENTS",
                "EDIT_ISSUES",
                "ASSIGN_ISSUES",
              ])
              .pipe(Effect.orElseSucceed(() => null)),
            jira.myself().pipe(Effect.orElseSucceed(() => null)),
          ],
          { concurrency: 5 },
        );
        const summary = toSummary(issue, origin, page.total);
        return {
          ...summary,
          body: adfToMarkdown(issue.fields.description),
          viewer: me === null ? null : toActor(me).login,
          viewerPermissions:
            allowed === null
              ? EVERYTHING
              : {
                  setState: allowed["TRANSITION_ISSUES"] === true,
                  comment: allowed["ADD_COMMENTS"] === true,
                  edit: allowed["EDIT_ISSUES"] === true,
                  labels: allowed["EDIT_ISSUES"] === true,
                  assignees: allowed["ASSIGN_ISSUES"] === true,
                },
          states: toStates(issue),
          comments: page.comments.map((comment) => toComment(comment, summary.url)),
          commentsCursor: page.total > page.comments.length ? String(page.comments.length) : null,
          events: toEvents(issue.changelog?.histories ?? []),
          linkedPullRequests: [],
        };
      }),

      getComments: Effect.fn("JiraIssueTracker.getComments")(function* (input) {
        const key = yield* requireKey("getComments", input.key);
        const startAt = /^\d+$/u.test(input.cursor) ? Number(input.cursor) : 0;
        const [origin, page] = yield* Effect.all([
          jira.origin,
          jira.getComments({ key, startAt, limit: COMMENTS_PAGE }),
        ]);
        const read = startAt + page.comments.length;
        return {
          comments: page.comments.map((comment) => toComment(comment, `${origin}/browse/${key}`)),
          nextCursor: page.comments.length > 0 && read < page.total ? String(read) : null,
        };
      }),

      create: Effect.fn("JiraIssueTracker.create")(function* (input) {
        const project = projectKey(input.scope);
        const [origin, types, labels, assignee] = yield* Effect.all([
          jira.origin,
          jira.issueTypes(project),
          labelNames("create", input.labels),
          accountId("create", input.scope, input.assignees),
        ]);
        // Jira files nothing without a type; a Task is the one nearly every project has.
        const type =
          types.find((candidate) => candidate.name === "Task") ??
          types.find((candidate) => !candidate.subtask);
        if (type === undefined) {
          return yield* JiraApi.fail(
            "create",
            "failed",
            `Jira project ${project} has no issue type this account can create.`,
          );
        }
        const created = yield* jira.createIssue({
          project: { key: project },
          issuetype: { id: type.id },
          summary: input.title,
          ...(input.body.trim().length === 0 ? {} : { description: markdownToAdf(input.body) }),
          ...(labels.length === 0 ? {} : { labels }),
          ...(assignee === null ? {} : { assignee: { accountId: assignee } }),
        });
        return {
          key: created.key,
          displayKey: created.key,
          url: `${origin}/browse/${created.key}`,
        };
      }),

      comment: Effect.fn("JiraIssueTracker.comment")(function* (input) {
        const key = yield* requireProjectKey("comment", input);
        yield* jira.addComment(key, markdownToAdf(input.body));
      }),

      update: Effect.fn("JiraIssueTracker.update")(function* (input) {
        const key = yield* requireProjectKey("update", input);
        if (input.body !== undefined) {
          const current = yield* jira.getIssue(key);
          if (hasUnwritableContent(current.fields.description)) {
            return yield* JiraApi.fail(
              "update",
              "failed",
              "This description holds formatting Markdown cannot keep, such as attachments, mentions, panels or colored text. Edit it in Jira.",
            );
          }
        }
        yield* jira.updateIssue(key, {
          ...(input.title === undefined ? {} : { summary: input.title }),
          ...(input.body === undefined ? {} : { description: markdownToAdf(input.body) }),
          ...(input.labels === undefined
            ? {}
            : { labels: yield* labelNames("update", input.labels) }),
          ...(input.assignees === undefined
            ? {}
            : yield* accountId("update", input.scope, input.assignees).pipe(
                Effect.map((id) => ({ assignee: id === null ? null : { accountId: id } })),
              )),
        });
      }),

      setState: Effect.fn("JiraIssueTracker.setState")(function* (input) {
        const key = yield* requireProjectKey("setState", input);
        const issue = yield* jira.getIssue(key);
        if (issue.fields.status.name === input.state) return;
        const transitions = issue.transitions ?? [];
        // A move's own name picks one of several that reach the same status (Resolve, Cancel).
        const named = transitions.find((transition) => transition.name === input.state);
        const reaching = transitions.filter((transition) => transition.to.name === input.state);
        if (named === undefined && reaching.length > 1) {
          return yield* JiraApi.fail(
            "setState",
            "failed",
            `Several moves reach "${input.state}": ${reaching.map((transition) => `"${transition.name}"`).join(", ")}. Name the move to make.`,
          );
        }
        const wanted = named ?? reaching[0];
        if (wanted === undefined) {
          return yield* JiraApi.fail(
            "setState",
            "failed",
            `This issue's workflow has no move to "${input.state}" from "${issue.fields.status.name}".`,
          );
        }
        yield* jira.transition(key, wanted.id);
      }),

      listCandidates: (input) =>
        Effect.all([jira.labels, jira.assignable(projectKey(input.scope))], {
          concurrency: 2,
        }).pipe(
          Effect.map(([labels, people]) => ({
            labels: labels.names.flatMap((name) =>
              name.trim() ? [{ name, color: null, description: null }] : [],
            ),
            assignees: people.users.map((user) => ({ ...toActor(user), id: user.accountId })),
            truncated: labels.truncated || people.truncated,
          })),
        ),
    };
    return api;
  },
);
