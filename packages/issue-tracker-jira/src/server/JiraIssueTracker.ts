import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  IssueCapabilities,
  IssueViewerPermissions,
  StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import type {
  IssueTarget,
  IssueScopeTarget,
  StandaloneIssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as JiraApi from "./JiraApi.ts";
import {
  JiraIssue,
  JiraUser,
  JiraStatus,
  JiraComment,
  JiraHistoryEntry,
  adfToText,
  isEditableAdf,
  textToAdf,
  normalizeJiraIssue,
  buildJql,
  jiraActor,
  jiraDate,
  jiraEvents,
  quoteJiraJql,
} from "./jiraJson.ts";

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: JiraApi.KIND,
  displayName: "Jira",
  host: null,
  scopeNoun: "project",
  credential: {
    label: "API token",
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      { key: "site", label: "Jira Cloud site", secret: false },
      { key: "email", label: "Account email", secret: false },
      { key: "token", label: "API token", secret: true },
    ],
  },
};

const CAPABILITIES: IssueCapabilities = {
  create: true,
  createIssueTypes: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  maxAssignees: 1,
  involvements: ["all", "assigned", "authored"],
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: true,
  search: true,
  states: [
    { name: "open", category: "open" },
    { name: "closed", category: "closed" },
  ],
  closeReasons: [],
};

const Text = Schema.String.check(Schema.isMinLength(1));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const bounded = <S extends Schema.Top>(schema: S, maximum = 100) =>
  Schema.Array(schema).check(Schema.isMaxLength(maximum));
const Search = Schema.Struct({
  issues: bounded(JiraIssue, 200),
  nextPageToken: Schema.optional(Text.check(Schema.isMaxLength(4096))),
  isLast: Schema.optional(Schema.Boolean),
});
const Permissions = Schema.Struct({
  permissions: Schema.Record(Schema.String, Schema.Struct({ havePermission: Schema.Boolean })),
});
const Transitions = Schema.Struct({
  transitions: bounded(
    Schema.Struct({
      id: Text,
      to: JiraStatus,
      fields: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ required: Schema.optional(Schema.Boolean) })),
      ),
    }),
  ),
});
const Types = Schema.Struct({
  startAt: Count,
  total: Count,
  issueTypes: bounded(
    Schema.Struct({ id: Text, name: Text, subtask: Schema.optional(Schema.Boolean) }),
  ),
});
const Fields = Schema.Struct({
  startAt: Count,
  total: Count,
  fields: bounded(
    Schema.Struct({
      fieldId: Text,
      required: Schema.Boolean,
      hasDefaultValue: Schema.optional(Schema.Boolean),
    }),
  ),
});
const CommentPage = Schema.Struct({
  startAt: Count,
  total: Count,
  comments: bounded(JiraComment, 50),
});
const History = Schema.Struct({
  startAt: Schema.optional(Count),
  total: Schema.optional(Count),
  isLast: Schema.optional(Schema.Boolean),
  values: bounded(JiraHistoryEntry, 50),
});
const ScopeIssue = Schema.Struct({
  key: Text,
  fields: Schema.Struct({
    project: Schema.Struct({ id: Text, key: Text }),
    status: JiraStatus,
    description: Schema.optional(Schema.Unknown),
  }),
});
const issueFields = [
  "project",
  "summary",
  "description",
  "status",
  "creator",
  "assignee",
  "labels",
  "created",
  "updated",
  "resolutiondate",
  "comment",
];
const permissionNames = "CREATE_ISSUES,EDIT_ISSUES,ADD_COMMENTS,ASSIGN_ISSUES,TRANSITION_ISSUES";
const commentOffset = (cursor: string) => {
  if (!/^(0|[1-9][0-9]{0,8})$/.test(cursor)) throw new Error("Invalid Jira comment cursor.");
  return Number(cursor);
};
const matchesState = (
  transition: (typeof Transitions.Type)["transitions"][number],
  state: string,
) => (transition.to.statusCategory.key === "done") === (state === "closed");
const usable = (transition: (typeof Transitions.Type)["transitions"][number]) =>
  !Object.values(transition.fields ?? {}).some((field) => field.required);

export const make = Effect.gen(function* () {
  const jira = yield* JiraApi.JiraApi;
  const requireIssue = (input: IssueTarget) =>
    Effect.gen(function* () {
      const issue = yield* jira.request({
        host: input.host,
        operation: "getIssue",
        method: "GET",
        path:
          "/issue/" +
          encodeURIComponent(input.key) +
          "?fields=" +
          issueFields.join(",") +
          "&expand=changelog",
        schema: JiraIssue,
      });
      if (
        !issue.fields.project ||
        (issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope)
      )
        return yield* JiraApi.failed(
          "getIssue",
          "This issue is outside the selected Jira project.",
          "not-found",
        );
      return issue;
    });
  const requireScopeIssue = (input: IssueTarget, operation: string, description = false) =>
    Effect.gen(function* () {
      const issue = yield* jira.request({
        host: input.host,
        operation,
        method: "GET",
        path:
          "/issue/" +
          encodeURIComponent(input.key) +
          "?fields=project,status" +
          (description ? ",description" : ""),
        schema: ScopeIssue,
      });
      if (issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope)
        return yield* JiraApi.failed(
          operation,
          "This issue is outside the selected Jira project.",
          "not-found",
        );
      return issue;
    });
  const permissions = (input: IssueScopeTarget & { readonly key?: string }, operation: string) =>
    jira.request({
      host: input.host,
      operation,
      method: "GET",
      path:
        "/mypermissions?" +
        (input.key
          ? "issueKey=" + encodeURIComponent(input.key)
          : (/^[0-9]+$/.test(input.scope) ? "projectId=" : "projectKey=") +
            encodeURIComponent(input.scope)) +
        "&permissions=" +
        permissionNames,
      schema: Permissions,
    });
  const transitions = (input: IssueTarget) =>
    jira.request({
      host: input.host,
      operation: "transitions",
      method: "GET",
      path: "/issue/" + encodeURIComponent(input.key) + "/transitions?expand=transitions.fields",
      schema: Transitions,
    });
  const viewer = (host: string) =>
    jira
      .request({ host, operation: "getViewer", method: "GET", path: "/myself", schema: JiraUser })
      .pipe(Effect.map((user) => user.accountId));
  const allowed = (raw: typeof Permissions.Type, key: string) =>
    raw.permissions[key]?.havePermission === true;
  const toPermissions = (raw: typeof Permissions.Type): IssueViewerPermissions => ({
    edit: allowed(raw, "EDIT_ISSUES"),
    labels: allowed(raw, "EDIT_ISSUES"),
    assignees: allowed(raw, "ASSIGN_ISSUES"),
    comment: allowed(raw, "ADD_COMMENTS"),
    setState: allowed(raw, "TRANSITION_ISSUES"),
  });
  const commentResult = (
    input: IssueTarget,
    page: {
      readonly startAt: number;
      readonly total: number;
      readonly comments: ReadonlyArray<typeof JiraComment.Type>;
    },
  ) =>
    JiraApi.attempt("getComments", () => {
      if (page.comments.length === 0 && page.startAt < page.total)
        throw new Error("Incomplete Jira comment page.");
      return {
        comments: page.comments.map((comment) => ({
          id: comment.id,
          author: comment.author ? jiraActor(comment.author) : null,
          body: adfToText(comment.body),
          createdAt: jiraDate(comment.created),
          url:
            "https://" +
            JiraApi.normalizeJiraHost(input.host) +
            "/browse/" +
            encodeURIComponent(input.key) +
            "?focusedCommentId=" +
            encodeURIComponent(comment.id),
        })),
        nextCursor:
          page.startAt + page.comments.length < page.total
            ? String(page.startAt + page.comments.length)
            : null,
      };
    });
  const comments = (input: IssueTarget, startAt: number) =>
    Effect.gen(function* () {
      const page = yield* jira.request({
        host: input.host,
        operation: "getComments",
        method: "GET",
        path:
          "/issue/" +
          encodeURIComponent(input.key) +
          "/comment?orderBy=-created&startAt=" +
          startAt +
          "&maxResults=50",
        schema: CommentPage,
      });
      if (page.startAt !== startAt || (page.comments.length === 0 && startAt < page.total))
        return yield* JiraApi.failed("getComments", "Jira returned an inconsistent comment page.");
      return yield* commentResult(input, { ...page, comments: page.comments.toReversed() });
    });
  const issueTypes = (input: IssueScopeTarget) =>
    Effect.gen(function* () {
      const page = yield* jira.request({
        host: input.host,
        operation: "issueTypes",
        method: "GET",
        path:
          "/issue/createmeta/" +
          encodeURIComponent(input.scope) +
          "/issuetypes?startAt=0&maxResults=100",
        schema: Types,
      });
      if (page.startAt !== 0 || page.total > page.issueTypes.length)
        return yield* JiraApi.failed(
          "issueTypes",
          "This project has more Jira issue types than can be loaded in one page.",
        );
      return page.issueTypes.filter((type) => type.subtask !== true);
    });
  const api: StandaloneIssueTrackerApi = {
    kind: JiraApi.KIND,
    standalone: DESCRIPTOR,
    capabilities: CAPABILITIES,
    probeCredential: jira.probeCredential,
    getScope: jira.getScope,
    getViewer: (input) => viewer(input.host),
    listIssues: (input) =>
      Effect.gen(function* () {
        if (
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 200 ||
          (input.cursor !== undefined && (!input.cursor || input.cursor.length > 4096))
        )
          return yield* JiraApi.failed("listIssues", "Invalid Jira issue page.");
        const jql = yield* Effect.try({
          try: () => buildJql(input),
          catch: () => JiraApi.failed("listIssues", "Jira does not support mention filtering."),
        });
        const page = yield* jira.request({
          host: input.host,
          operation: "listIssues",
          method: "POST",
          path: "/search/jql",
          schema: Search,
          body: {
            jql,
            maxResults: input.limit,
            fields: issueFields.filter((field) => field !== "description"),
            ...(input.cursor === undefined ? {} : { nextPageToken: input.cursor }),
          },
        });
        if (
          page.issues.length > input.limit ||
          (page.isLast === false && !page.nextPageToken) ||
          (input.cursor !== undefined && page.nextPageToken === input.cursor) ||
          page.issues.some(
            (issue) =>
              !issue.fields.project ||
              (issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope),
          )
        )
          return yield* JiraApi.failed("listIssues", "Jira returned an inconsistent issue page.");
        return {
          items: yield* JiraApi.attempt("listIssues", () =>
            page.issues.map((issue) =>
              normalizeJiraIssue(issue, JiraApi.normalizeJiraHost(input.host)),
            ),
          ),
          nextCursor: page.isLast === true ? null : (page.nextPageToken ?? null),
        };
      }),
    getIssue: (input) =>
      Effect.gen(function* () {
        const issue = yield* requireIssue(input);
        const [who, rawPermissions] = yield* Effect.all(
          [viewer(input.host), permissions(input, "getIssue")],
          { concurrency: 2 },
        );
        const embedded = issue.fields.comment;
        const page =
          embedded?.comments === undefined && embedded?.total !== 0
            ? yield* comments(input, 0)
            : yield* commentResult(input, {
                startAt: 0,
                total: embedded?.total ?? 0,
                comments: embedded?.comments ?? [],
              });
        const history = issue.changelog
          ? { ...issue.changelog, values: issue.changelog.histories, isLast: undefined }
          : yield* jira.request({
              host: input.host,
              operation: "getIssue",
              method: "GET",
              path:
                "/issue/" + encodeURIComponent(input.key) + "/changelog?startAt=0&maxResults=50",
              schema: History,
            });
        return {
          ...(yield* JiraApi.attempt("getIssue", () =>
            normalizeJiraIssue(issue, JiraApi.normalizeJiraHost(input.host)),
          )),
          body: yield* JiraApi.attempt("getIssue", () => adfToText(issue.fields.description)),
          bodyEditable: yield* JiraApi.attempt("getIssue", () =>
            isEditableAdf(issue.fields.description),
          ),
          viewer: who,
          viewerPermissions: toPermissions(rawPermissions),
          comments: page.comments,
          commentsCursor: page.nextCursor,
          events: yield* JiraApi.attempt("getIssue", () => jiraEvents(history.values)),
          historyTruncated:
            (history.startAt ?? 0) > 0 ||
            history.values.length < (history.total ?? history.values.length) ||
            history.isLast === false,
          linkedPullRequests: [],
        };
      }),
    getComments: (input) =>
      Effect.gen(function* () {
        yield* requireScopeIssue(input, "getComments");
        const startAt = yield* JiraApi.attempt("getComments", () => commentOffset(input.cursor));
        return yield* comments(input, startAt);
      }),
    getViewerPermissions: (input) =>
      permissions(input, "getViewerPermissions").pipe(Effect.map(toPermissions)),
    create: (input) =>
      Effect.gen(function* () {
        if (input.assignees.length > 1)
          return yield* JiraApi.failed("create", "A Jira issue can have only one assignee.");
        const types = yield* issueTypes(input);
        const selected =
          input.issueType === undefined
            ? types.length === 1
              ? types[0]
              : undefined
            : types.find((type) => type.id === input.issueType);
        if (!selected) return yield* JiraApi.failed("create", "Select a Jira issue type first.");
        const page = yield* jira.request({
          host: input.host,
          operation: "create",
          method: "GET",
          path:
            "/issue/createmeta/" +
            encodeURIComponent(input.scope) +
            "/issuetypes/" +
            encodeURIComponent(selected.id) +
            "?startAt=0&maxResults=100",
          schema: Fields,
        });
        const supported = new Set([
          "project",
          "issuetype",
          "summary",
          "description",
          "labels",
          "assignee",
        ]);
        if (
          page.startAt !== 0 ||
          page.total > page.fields.length ||
          page.fields.some(
            (field) => field.required && !field.hasDefaultValue && !supported.has(field.fieldId),
          )
        )
          return yield* JiraApi.failed(
            "create",
            "This Jira issue type needs extra required fields. Create it in Jira.",
          );
        const fields = new Set(page.fields.map((field) => field.fieldId));
        if (
          (input.body !== "" && !fields.has("description")) ||
          (input.labels.length > 0 && !fields.has("labels")) ||
          (input.assignees.length > 0 && !fields.has("assignee"))
        )
          return yield* JiraApi.failed(
            "create",
            "This Jira issue type does not allow the selected description, labels or assignee on creation.",
          );
        const body = yield* JiraApi.attempt("create", () => textToAdf(input.body));
        const created = yield* jira.request({
          host: input.host,
          operation: "create",
          method: "POST",
          path: "/issue",
          schema: Schema.Struct({ key: Text }),
          body: {
            fields: {
              project: /^[0-9]+$/.test(input.scope) ? { id: input.scope } : { key: input.scope },
              issuetype: { id: selected.id },
              summary: input.title,
              ...(fields.has("description") ? { description: body } : {}),
              ...(fields.has("labels") ? { labels: input.labels } : {}),
              ...(input.assignees[0] === undefined
                ? {}
                : { assignee: { accountId: input.assignees[0] } }),
            },
          },
        });
        return {
          key: created.key,
          displayKey: created.key,
          url:
            "https://" +
            JiraApi.normalizeJiraHost(input.host) +
            "/browse/" +
            encodeURIComponent(created.key),
        };
      }),
    comment: (input) =>
      Effect.gen(function* () {
        yield* requireScopeIssue(input, "comment");
        const body = yield* JiraApi.attempt("comment", () => textToAdf(input.body));
        yield* jira.request({
          host: input.host,
          operation: "comment",
          method: "POST",
          path: "/issue/" + encodeURIComponent(input.key) + "/comment",
          schema: JiraComment,
          body: { body },
        });
      }),
    update: (input) =>
      Effect.gen(function* () {
        if (input.assignees !== undefined && input.assignees.length > 1)
          return yield* JiraApi.failed("update", "A Jira issue can have only one assignee.");
        const issue = yield* requireScopeIssue(input, "update", input.body !== undefined);
        if (
          input.body !== undefined &&
          !(yield* JiraApi.attempt("update", () => isEditableAdf(issue.fields.description)))
        )
          return yield* JiraApi.failed(
            "update",
            "This description has rich content. Edit it in Jira to preserve its formatting and attachments.",
          );
        const text = input.body;
        const body =
          text === undefined ? undefined : yield* JiraApi.attempt("update", () => textToAdf(text));
        const fields = {
          ...(input.title === undefined ? {} : { summary: input.title }),
          ...(body === undefined ? {} : { description: body }),
          ...(input.labels === undefined ? {} : { labels: input.labels }),
          ...(input.assignees === undefined
            ? {}
            : {
                assignee:
                  input.assignees[0] === undefined ? null : { accountId: input.assignees[0] },
              }),
        };
        if (Object.keys(fields).length === 0) return;
        const assigneeOnly = input.assignees !== undefined && Object.keys(fields).length === 1;
        yield* jira.request({
          host: input.host,
          operation: "update",
          method: "PUT",
          path: "/issue/" + encodeURIComponent(input.key) + (assigneeOnly ? "/assignee" : ""),
          schema: Schema.Undefined,
          body: assigneeOnly ? { accountId: input.assignees?.[0] ?? null } : { fields },
        });
      }),
    setState: (input) =>
      Effect.gen(function* () {
        if (
          !CAPABILITIES.states.some((state) => state.name === input.state) ||
          input.closeReason !== undefined
        )
          return yield* JiraApi.failed(
            "setState",
            "Choose a Jira workflow transition without a close reason.",
          );
        const issue = yield* requireScopeIssue(input, "setState");
        if ((issue.fields.status.statusCategory.key === "done") === (input.state === "closed"))
          return;
        const available = yield* transitions(input);
        const candidates = available.transitions.filter((transition) =>
          matchesState(transition, input.state),
        );
        const transition = candidates.length === 1 ? candidates[0] : undefined;
        if (!transition || !usable(transition))
          return yield* JiraApi.failed(
            "setState",
            "This workflow has no single matching transition without extra required fields. Complete it in Jira.",
          );
        yield* jira.request({
          host: input.host,
          operation: "setState",
          method: "POST",
          path: "/issue/" + encodeURIComponent(input.key) + "/transitions",
          schema: Schema.Undefined,
          body: { transition: { id: transition.id } },
        });
      }),
    listCandidates: (input) =>
      Effect.gen(function* () {
        const raw = yield* permissions(input, "listCandidates");
        const sample = yield* jira.request({
          host: input.host,
          operation: "listCandidates",
          method: "POST",
          path: "/search/jql",
          schema: Schema.Struct({
            issues: bounded(
              Schema.Struct({
                fields: Schema.Struct({
                  project: Schema.Struct({ id: Text, key: Text }),
                  labels: Schema.Array(Text),
                }),
              }),
            ),
          }),
          body: {
            jql: "project = " + quoteJiraJql(input.scope) + " ORDER BY updated DESC",
            maxResults: 100,
            fields: ["project", "labels"],
          },
        });
        if (
          sample.issues.some(
            (issue) =>
              issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope,
          )
        )
          return yield* JiraApi.failed(
            "listCandidates",
            "Jira returned labels outside this project.",
          );
        const users = allowed(raw, "ASSIGN_ISSUES")
          ? yield* jira.request({
              host: input.host,
              operation: "listCandidates",
              method: "GET",
              path:
                "/user/assignable/search?project=" +
                encodeURIComponent(input.scope) +
                "&startAt=0&maxResults=100",
              schema: bounded(JiraUser),
            })
          : [];
        const types = allowed(raw, "CREATE_ISSUES") ? yield* issueTypes(input) : [];
        return {
          labels: [...new Set(sample.issues.flatMap((issue) => issue.fields.labels))]
            .slice(0, 100)
            .map((name) => ({ name, color: null, description: null })),
          assignees: users.map((user) => ({ ...jiraActor(user), id: user.accountId })),
          issueTypes: types.map((type) => ({ id: type.id, name: type.name })),
          truncated: true,
        };
      }),
  };
  return api;
});
