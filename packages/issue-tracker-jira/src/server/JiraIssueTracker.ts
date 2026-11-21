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
  automationContainer: "board",
};

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
/** Keys per status search, which keeps each JQL query and its answer to one page. */
const STATUS_READ_BATCH = 50;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/u;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/iu;
/** A rule on a project rather than a board: a Service Management project has no board. */
const PROJECT_CONTAINER = "project:";

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

/** A board, named with its project's key when it lives in one, since board names repeat. */
function boardOption(board: JiraApi.JiraBoard) {
  const project = board.location?.projectKey?.trim();
  return { id: String(board.id), name: project ? `${board.name} (${project})` : board.name };
}

/** `https://<site>/browse/<KEY>`, the workspace being the site. */
function parseIssueUrl(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const key = /^\/browse\/([A-Z][A-Z0-9_]*-[1-9]\d*)\/?$/iu.exec(url.pathname)?.[1]?.toUpperCase();
  if (key === undefined) return null;
  return {
    host: DESCRIPTOR.host,
    workspace: url.host.toLowerCase(),
    scope: key.slice(0, key.lastIndexOf("-")),
    key,
  };
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
      const { users, truncated } = yield* jira.assignable(projectKey(scope));
      const found =
        users.find((user) => matchesUser(user, first)) ??
        (truncated
          ? (yield* jira.findUsers(first)).find((user) => matchesUser(user, first))
          : undefined);
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

    const site = jira.origin.pipe(Effect.map((origin) => new URL(origin).host.toLowerCase()));

    /** Board ids are only unique on one site, so a rule saved on another is refused. */
    const requireSite = Effect.fn("JiraIssueTracker.requireSite")(function* (workspace: string) {
      if ((yield* site) !== workspace.toLowerCase())
        return yield* JiraApi.fail(
          "automation",
          "failed",
          "The connected Jira site is not the one this rule was made on.",
        );
    });

    const whenFound = <A>(effect: Effect.Effect<A, IssueTrackerError>) =>
      effect.pipe(
        Effect.map((value): A | null => value),
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeed(null),
        ),
      );

    /** A project key's boards, or the project itself when it has none. */
    const projectContainers = Effect.fn("JiraIssueTracker.projectContainers")(function* (
      key: string,
    ) {
      const project = yield* whenFound(jira.project(key));
      if (project === null) return [];
      const { boards } = yield* jira.boards({ projectKey: key, startAt: 0 });
      return boards.length > 0
        ? boards.map(boardOption)
        : [{ id: `${PROJECT_CONTAINER}${key}`, name: `${project.name} (${key})` }];
    });

    /** The status id of each key, read in batches; a key Jira says does not exist is left out. */
    const readKeyStatuses = Effect.fn("JiraIssueTracker.readKeyStatuses")(function* (
      keys: ReadonlyArray<string>,
    ) {
      const statuses: Array<{ readonly key: string; readonly stateId: string }> = [];
      for (let start = 0; start < keys.length; start += STATUS_READ_BATCH) {
        let batch = keys.slice(start, start + STATUS_READ_BATCH);
        while (batch.length > 0) {
          const read = yield* jira
            .issueStatuses({ jql: `key in (${batch.map(quoted).join(", ")})`, limit: batch.length })
            .pipe(Effect.result);
          if (read._tag === "Success") {
            statuses.push(...read.success.map((row) => ({ key: row.key, stateId: row.statusId })));
            break;
          }
          // JQL refuses the whole query over one key it cannot find, naming that key.
          const missing = batch.filter((key) => read.failure.detail.includes(`'${key}'`));
          if (read.failure.reason !== "failed" || missing.length === 0) return yield* read.failure;
          batch = batch.filter((key) => !missing.includes(key));
        }
      }
      return statuses;
    });

    const api: StandaloneIssueTrackerApi = {
      kind: JiraApi.KIND,
      capabilities: CAPABILITIES,
      standalone: DESCRIPTOR,
      parseIssueUrl,

      automation: {
        listContainers: Effect.fn("JiraIssueTracker.listContainers")(function* (input) {
          const startAt = input.cursor === undefined ? 0 : Number(input.cursor);
          if (!Number.isSafeInteger(startAt) || startAt < 0)
            return yield* JiraApi.fail("listContainers", "failed", "Invalid Jira board page.");
          const query = input.query?.trim() || undefined;
          const [workspace, page, byKey] = yield* Effect.all(
            [
              site,
              jira.boards({ name: query, startAt }),
              // A project key also finds the project's boards, whatever they are named.
              startAt === 0 && query !== undefined && PROJECT_KEY.test(query)
                ? projectContainers(query.toUpperCase())
                : Effect.succeed([]),
            ],
            { concurrency: "unbounded" },
          );
          const containers = [
            ...new Map(
              [...byKey, ...page.boards.map(boardOption)]
                .filter((option) => option.name.trim().length > 0)
                .map((option) => [option.id, option]),
            ).values(),
          ];
          return {
            workspace,
            containers,
            nextCursor:
              page.isLast || page.boards.length === 0 ? null : String(startAt + page.boards.length),
          };
        }),
        getContainer: Effect.fn("JiraIssueTracker.getContainer")(function* (containerId) {
          const workspace = yield* site;
          if (containerId.startsWith(PROJECT_CONTAINER)) {
            const key = containerId.slice(PROJECT_CONTAINER.length).toUpperCase();
            const project = PROJECT_KEY.test(key) ? yield* whenFound(jira.project(key)) : null;
            return {
              workspace,
              container:
                project === null
                  ? null
                  : { id: `${PROJECT_CONTAINER}${key}`, name: `${project.name} (${key})` },
            };
          }
          const board = /^[1-9]\d*$/u.test(containerId)
            ? yield* whenFound(jira.board(containerId))
            : null;
          return { workspace, container: board === null ? null : boardOption(board) };
        }),
        listStates: Effect.fn("JiraIssueTracker.listStates")(function* (input) {
          yield* requireSite(input.workspace);
          if (input.containerId.startsWith(PROJECT_CONTAINER)) {
            // Service Management workflows are set per issue type; each lists its own statuses.
            const types = yield* jira.projectStatuses(
              input.containerId.slice(PROJECT_CONTAINER.length),
            );
            return [...new Map(types.flat().map((status) => [status.id, status])).values()].map(
              ({ id, name }) => ({ id, name }),
            );
          }
          const ids = yield* jira.boardStatusIds(input.containerId);
          return yield* Effect.forEach(ids, jira.status, { concurrency: 4 }).pipe(
            Effect.map((statuses) => statuses.map(({ id, name }) => ({ id, name }))),
          );
        }),
        readStatuses: Effect.fn("JiraIssueTracker.readStatuses")(function* (input) {
          yield* requireSite(input.workspace);
          const projects = new Set(
            input.containerId.startsWith(PROJECT_CONTAINER)
              ? [input.containerId.slice(PROJECT_CONTAINER.length).toUpperCase()]
              : (yield* jira.boardProjects(input.containerId)).map((key) => key.toUpperCase()),
          );
          // Only the board's projects' issues are on it; any other key is left out unread.
          const keys = [
            ...new Set(
              input.keys
                .map((key) => key.trim().toUpperCase())
                .filter(
                  (key) => ISSUE_KEY.test(key) && projects.has(key.slice(0, key.lastIndexOf("-"))),
                ),
            ),
          ];
          return yield* readKeyStatuses(keys);
        }),
      },

      probeCredential: (credential) =>
        Effect.all([jira.myself(credential), jira.projects(credential)], {
          concurrency: 2,
        }).pipe(
          Effect.map(([me, projects]) => ({
            account: me.displayName?.trim() || me.emailAddress?.trim() || me.accountId,
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
              "This description holds attachments, mentions or panels that would be lost. Edit it in Jira.",
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
        const wanted = (issue.transitions ?? []).find(
          (transition) => transition.to.name === input.state,
        );
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
