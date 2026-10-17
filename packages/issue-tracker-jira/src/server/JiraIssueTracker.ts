import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  IssueCapabilities,
  IssuePageInput,
  IssueListOrder,
  IssueRelation,
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
  jiraBodyText,
  jiraBodyEditable,
  textToAdf,
  normalizeJiraIssue,
  buildJql,
  jiraActor,
  jiraState,
  jiraDate,
  jiraEvents,
  quoteJiraJql,
} from "./jiraJson.ts";
import { normalizeJiraInstanceHost } from "./jiraDataCenter.ts";
import { jiraRichBody, parseJiraRichBody } from "./jiraAdf.ts";
import {
  JiraField,
  jiraFormFieldLimit,
  createReserved,
  transitionReserved,
  jiraInputFields,
  jiraFieldValues,
} from "./jiraForms.ts";

const DESCRIPTOR: StandaloneIssueTrackerDescriptor = {
  tracker: JiraApi.KIND,
  displayName: "Jira",
  host: null,
  scopeNoun: "project",
  credential: {
    label: "API token",
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    fields: [
      { key: "site", label: "Jira site", secret: false },
      {
        key: "deployment",
        label: "Deployment (cloud or data-center)",
        secret: false,
        optional: true,
      },
      { key: "email", label: "Account email (Cloud)", secret: false, optional: true },
      { key: "token", label: "API token", secret: true },
    ],
  },
};

const CAPABILITIES: IssueCapabilities = {
  create: true,
  createIssueTypes: true,
  createFields: true,
  stateFields: true,
  richText: true,
  edit: true,
  comment: true,
  editComment: true,
  subIssues: true,
  createSubIssue: true,
  updateParent: true,
  listSorts: ["created", "updated"],
  listOrders: ["asc", "desc"],
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
      name: Schema.optional(Text),
      to: JiraStatus,
      isAvailable: Schema.optional(Schema.Boolean),
      fields: Schema.optional(Schema.Record(Schema.String, JiraField)),
    }),
  ),
});
const Types = Schema.Struct({
  startAt: Count,
  total: Schema.optional(Count),
  isLast: Schema.optional(Schema.Boolean),
  issueTypes: bounded(
    Schema.Struct({ id: Text, name: Text, subtask: Schema.optional(Schema.Boolean) }),
  ),
});
const Fields = Schema.Struct({
  startAt: Count,
  total: Schema.optional(Count),
  isLast: Schema.optional(Schema.Boolean),
  fields: bounded(JiraField),
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
  values: bounded(JiraHistoryEntry, 200),
});
const ScopeIssue = Schema.Struct({
  key: Text,
  changelog: JiraIssue.fields.changelog,
  fields: Schema.Struct({
    project: Schema.Struct({ id: Text, key: Text }),
    status: JiraStatus,
    description: Schema.optional(Schema.Unknown),
  }),
});
const Epic = Schema.Struct({ key: Text });
const AgileIssue = Schema.Struct({
  ...JiraIssue.fields,
  fields: Schema.Struct({
    ...JiraIssue.fields.fields.fields,
    epic: Schema.optional(Schema.NullOr(Epic)),
  }),
});
const AgileSearch = Schema.Struct({ ...Search.fields, issues: bounded(AgileIssue, 200) });
const issueFields = [
  "project",
  "parent",
  "issuetype",
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
  "fixVersions",
];
const permissionNames =
  "CREATE_ISSUES,EDIT_ISSUES,ADD_COMMENTS,ASSIGN_ISSUES,TRANSITION_ISSUES,EDIT_ALL_COMMENTS,EDIT_OWN_COMMENTS";
const commentOffset = (cursor: string) => {
  if (!/^(0|[1-9][0-9]{0,8})$/.test(cursor)) throw new Error("Invalid Jira comment cursor.");
  return Number(cursor);
};
const TimelineCursor = Schema.Struct({
  identity: Text,
  kind: Schema.Literals(["comments", "history"]),
  position: Count,
  total: Count,
  boundary: Text,
});
const decodeTimelineCursor = Schema.decodeSync(Schema.fromJsonString(TimelineCursor));
const encodeTimeline = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const timelineIdentity = (input: IssueTarget, order: IssueListOrder) =>
  encodeTimeline([
    "jira",
    input.cwd,
    normalizeJiraInstanceHost(input.host),
    input.scope,
    input.key,
    input.connectionId ?? null,
    order,
  ]);
const timelineCursor = (
  input: IssueTarget,
  kind: "comments" | "history",
  order: IssueListOrder,
  cursor?: string,
) => {
  if (order !== "asc" && order !== "desc") throw new Error("Invalid Jira timeline order.");
  if (cursor === undefined) return undefined;
  if (cursor.length > 8192) throw new Error("Invalid Jira timeline cursor.");
  const page = decodeTimelineCursor(cursor);
  if (
    page.identity !== timelineIdentity(input, order) ||
    page.kind !== kind ||
    !Number.isSafeInteger(page.total) ||
    !Number.isSafeInteger(page.position) ||
    page.position <= 0 ||
    page.position >= page.total
  )
    throw new Error("Invalid Jira timeline cursor.");
  return page;
};
const encodeTimelineCursor = (
  input: IssueTarget,
  kind: "comments" | "history",
  order: IssueListOrder,
  position: number,
  total: number,
  boundary: string,
) => encodeTimeline({ identity: timelineIdentity(input, order), kind, position, total, boundary });
const matchesState = (
  transition: (typeof Transitions.Type)["transitions"][number],
  state: string,
) => (transition.to.statusCategory.key === "done") === (state === "closed");
const transitionFields = (transition: (typeof Transitions.Type)["transitions"][number]) => {
  const fields = transition.fields ?? {};
  if (Object.keys(fields).length > jiraFormFieldLimit)
    throw new Error("Too many Jira transition fields.");
  return fields;
};
const RemoteLinks = bounded(
  Schema.Struct({
    object: Schema.Struct({
      title: Text.check(Schema.isMaxLength(4096)),
      url: Text.check(Schema.isMaxLength(8192)),
    }),
  }),
);
const safeRemoteLink = (link: (typeof RemoteLinks.Type)[number]) => {
  try {
    const url = new URL(link.object.url);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? [{ title: link.object.title, url: link.object.url }]
      : [];
  } catch {
    return [];
  }
};
const metadataProgress = (
  page: {
    readonly startAt: number;
    readonly total?: number | undefined;
    readonly isLast?: boolean | undefined;
  },
  startAt: number,
  count: number,
  total: number | undefined,
  maximum = 100,
) => {
  const next = startAt + count;
  if (
    page.startAt !== startAt ||
    next > maximum ||
    (page.total === undefined && page.isLast === undefined) ||
    (page.total !== undefined && (page.total > maximum || page.total < next)) ||
    (total !== undefined && page.total !== total) ||
    (page.isLast === true && page.total !== undefined && page.total !== next) ||
    (page.isLast === false && page.total !== undefined && page.total === next)
  )
    throw new Error("Inconsistent Jira metadata page.");
  const more = page.isLast === false || (page.isLast !== true && next < (page.total ?? next));
  if (more && (count === 0 || next >= maximum)) throw new Error("Incomplete Jira metadata.");
  return { total: page.total, more };
};
const formAttempt = <A>(operation: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: () =>
      JiraApi.failed(
        operation,
        "Check extra required fields and allowed values in this Jira form.",
      ),
  });

export const make = Effect.gen(function* () {
  const jira = yield* JiraApi.JiraApi;
  const readIssue = (input: Pick<IssueTarget, "host" | "key">) =>
    jira.request({
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
  const requireIssue = (input: IssueTarget) =>
    Effect.gen(function* () {
      const issue = yield* readIssue(input);
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
  const requireScopeIssue = (
    input: IssueTarget,
    operation: string,
    description = false,
    expandHistory = false,
  ) =>
    Effect.gen(function* () {
      const issue = yield* jira.request({
        host: input.host,
        operation,
        method: "GET",
        path:
          "/issue/" +
          encodeURIComponent(input.key) +
          "?fields=project,status" +
          (description ? ",description" : "") +
          (expandHistory ? "&expand=changelog" : ""),
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
  const dataCenterParentContext = (input: IssueTarget, selected: typeof JiraIssue.Type) =>
    Effect.gen(function* () {
      if (selected.fields.issuetype?.subtask !== false) return null;
      const current = yield* jira.request({
        host: input.host,
        operation: "getHierarchy",
        method: "GET",
        path:
          "/agile/1.0/issue/" +
          encodeURIComponent(selected.key) +
          "?fields=" +
          issueFields.join(",") +
          ",epic",
        schema: AgileIssue,
      });
      if (
        current.key !== selected.key ||
        current.fields.project?.id !== selected.fields.project?.id ||
        current.fields.issuetype?.subtask !== false
      )
        return yield* JiraApi.failed("getHierarchy", "Jira returned inconsistent epic membership.");
      const ownEpic = yield* jira
        .request({
          host: input.host,
          operation: "getHierarchy",
          method: "GET",
          path: "/agile/1.0/epic/" + encodeURIComponent(selected.key),
          schema: Epic,
        })
        .pipe(
          Effect.catchIf(
            (error) => JiraApi.isHttpStatus(error, 404),
            () => Effect.succeed(null),
          ),
        );
      if (ownEpic !== null && ownEpic.key !== selected.key)
        return yield* JiraApi.failed("getHierarchy", "Jira returned a different epic.");
      return { current, ownEpic };
    }).pipe(
      Effect.catchIf(
        (error) => JiraApi.isHttpStatus(error, 404) || JiraApi.isHttpStatus(error, 403),
        () => Effect.succeed(null),
      ),
    );
  const permissions = (
    input: IssueScopeTarget & { readonly key?: string | undefined },
    operation: string,
  ) =>
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
    granted?: typeof Permissions.Type,
    deployment: "cloud" | "data-center" = "cloud",
    order: IssueListOrder = "desc",
  ) =>
    JiraApi.attempt("getComments", () => {
      if (page.comments.length === 0 && page.startAt < page.total)
        throw new Error("Incomplete Jira comment page.");
      return {
        comments: page.comments.map((comment) => {
          const richBody = jiraRichBody(comment.body, deployment);
          return {
            id: comment.id,
            author: comment.author ? jiraActor(comment.author) : null,
            body: jiraBodyText(comment.body),
            ...(richBody === undefined ? {} : { richBody }),
            createdAt: jiraDate(comment.created),
            editedAt: comment.created === comment.updated ? null : jiraDate(comment.updated),
            canEdit:
              granted !== undefined &&
              (allowed(granted, "EDIT_ALL_COMMENTS") ||
                (input.viewer !== undefined &&
                  input.viewer === comment.author?.accountId &&
                  allowed(granted, "EDIT_OWN_COMMENTS"))) &&
              ((deployment === "cloud" && jiraBodyEditable(comment.body)) ||
                richBody !== undefined),
            url:
              JiraApi.jiraIssueUrl(input.host, input.key) +
              "?focusedCommentId=" +
              encodeURIComponent(comment.id),
          };
        }),
        nextCursor:
          page.startAt + page.comments.length < page.total
            ? encodeTimelineCursor(
                input,
                "comments",
                order,
                page.startAt + page.comments.length,
                page.total,
                page.comments.at(-1)!.id,
              )
            : null,
      };
    });
  const comments = (
    input: IssueTarget,
    startAt: number,
    granted?: typeof Permissions.Type,
    deployment: "cloud" | "data-center" = "cloud",
    order: IssueListOrder = "desc",
    previous?: typeof TimelineCursor.Type,
  ) =>
    Effect.gen(function* () {
      const page = yield* jira.request({
        host: input.host,
        operation: "getComments",
        method: "GET",
        path:
          "/issue/" +
          encodeURIComponent(input.key) +
          "/comment?orderBy=" +
          (order === "desc" ? "-created" : "created") +
          "&startAt=" +
          startAt +
          "&maxResults=50",
        schema: CommentPage,
      });
      if (
        page.startAt !== startAt ||
        startAt > page.total ||
        startAt + page.comments.length > page.total ||
        (page.comments.length === 0 && startAt < page.total) ||
        (previous !== undefined && page.total !== previous.total) ||
        new Set(page.comments.map((row) => row.id)).size !== page.comments.length ||
        page.comments.some(
          (row, index) =>
            row.id === previous?.boundary ||
            (index > 0 &&
              (order === "desc"
                ? Date.parse(row.created) > Date.parse(page.comments[index - 1]!.created)
                : Date.parse(row.created) < Date.parse(page.comments[index - 1]!.created))),
        )
      )
        return yield* JiraApi.failed("getComments", "Jira returned an inconsistent comment page.");
      return yield* commentResult(input, page, granted, deployment, order);
    });
  const history = (
    input: IssueTarget,
    order: IssueListOrder,
    limit: number,
    previous?: typeof TimelineCursor.Type,
    embedded?: typeof History.Type,
    operation = "getHistory",
  ) =>
    Effect.gen(function* () {
      const read = (startAt: number, maximum: number) =>
        jira.request({
          host: input.host,
          operation,
          method: "GET",
          path:
            "/issue/" +
            encodeURIComponent(input.key) +
            "/changelog?startAt=" +
            startAt +
            "&maxResults=" +
            maximum,
          schema: History,
        });
      let metadata = embedded;
      if (previous === undefined && order === "desc" && metadata?.total === undefined) {
        metadata = yield* read(0, 1);
        if (
          metadata.startAt !== 0 ||
          metadata.total === undefined ||
          metadata.values.length > 1 ||
          metadata.values.length !== Math.min(metadata.total, 1) ||
          (metadata.isLast !== undefined &&
            metadata.isLast !== (metadata.values.length === metadata.total))
        )
          return yield* JiraApi.failed(operation, "Jira returned inconsistent history metadata.");
      }
      if (
        metadata?.total !== undefined &&
        (!Number.isSafeInteger(metadata.total) ||
          (metadata.startAt ?? 0) > metadata.total ||
          metadata.values.length > metadata.total - (metadata.startAt ?? 0))
      )
        return yield* JiraApi.failed(operation, "Jira returned inconsistent history metadata.");
      const total = previous?.total ?? metadata?.total;
      const end = previous?.position ?? total;
      const startAt = order === "desc" ? Math.max(0, end! - limit) : (previous?.position ?? 0);
      const maximum =
        order === "desc"
          ? end! - startAt
          : Math.min(limit, total === undefined ? limit : total - startAt);
      const embeddedStart = metadata?.startAt ?? 0;
      const page =
        metadata !== undefined &&
        metadata.total !== undefined &&
        embeddedStart <= startAt &&
        embeddedStart + metadata.values.length === metadata.total &&
        startAt + maximum <= metadata.total
          ? {
              startAt,
              total: metadata.total,
              isLast: startAt + maximum === metadata.total,
              values: metadata.values
                .toSorted((a, b) => Date.parse(a.created) - Date.parse(b.created))
                .slice(startAt - embeddedStart, startAt - embeddedStart + maximum),
            }
          : yield* read(startAt, Math.max(1, maximum));
      const actualTotal = page.total;
      if (
        actualTotal === undefined ||
        !Number.isSafeInteger(actualTotal) ||
        page.startAt !== startAt ||
        startAt > actualTotal ||
        page.values.length > maximum ||
        startAt + page.values.length > actualTotal ||
        (total !== undefined && actualTotal < total) ||
        (order === "desc" && page.values.length !== maximum) ||
        (page.values.length === 0 && startAt < actualTotal) ||
        (page.isLast !== undefined &&
          page.isLast !== (startAt + page.values.length === actualTotal)) ||
        new Set(page.values.map((row) => row.id)).size !== page.values.length ||
        page.values.some((row) => row.id === previous?.boundary)
      )
        return yield* JiraApi.failed(operation, "Jira returned an inconsistent history page.");
      const bound = total ?? actualTotal;
      const position = order === "desc" ? startAt : startAt + page.values.length;
      const values = order === "desc" ? page.values.toReversed() : page.values;
      return {
        items: yield* JiraApi.attempt(operation, () => jiraEvents(values)),
        nextCursor: (order === "desc" ? position > 0 : position < bound)
          ? encodeTimelineCursor(input, "history", order, position, bound, values.at(-1)!.id)
          : null,
      };
    });
  const issueTypes = (input: IssueScopeTarget) =>
    Effect.gen(function* () {
      const types: Array<(typeof Types.Type)["issueTypes"][number]> = [];
      let total: number | undefined;
      let more: boolean;
      do {
        const startAt = types.length;
        const page = yield* jira.request({
          host: input.host,
          operation: "issueTypes",
          method: "GET",
          path:
            "/issue/createmeta/" +
            encodeURIComponent(input.scope) +
            "/issuetypes?startAt=" +
            startAt +
            "&maxResults=100",
          schema: Types,
        });
        const progress = yield* JiraApi.attempt("issueTypes", () =>
          metadataProgress(page, startAt, page.issueTypes.length, total),
        );
        total = progress.total;
        more = progress.more;
        types.push(...page.issueTypes);
      } while (more);
      if (new Set(types.map((type) => type.id)).size !== types.length)
        return yield* JiraApi.failed("issueTypes", "Jira returned duplicate issue types.");
      return types;
    });
  const createFields = (input: IssueScopeTarget, issueType: string, operation: string) =>
    Effect.gen(function* () {
      const fields: Array<typeof JiraField.Type> = [];
      let total: number | undefined;
      let more: boolean;
      do {
        const startAt = fields.length;
        const page = yield* jira.request({
          host: input.host,
          operation,
          method: "GET",
          path:
            "/issue/createmeta/" +
            encodeURIComponent(input.scope) +
            "/issuetypes/" +
            encodeURIComponent(issueType) +
            "?startAt=" +
            startAt +
            "&maxResults=100",
          schema: Fields,
        });
        const progress = yield* JiraApi.attempt(operation, () =>
          metadataProgress(page, startAt, page.fields.length, total, jiraFormFieldLimit),
        );
        total = progress.total;
        more = progress.more;
        fields.push(...page.fields);
      } while (more);
      return yield* JiraApi.attempt(operation, () => {
        const result: Record<string, typeof JiraField.Type> = {};
        for (const field of fields) {
          if (
            !field.fieldId ||
            ["__proto__", "constructor", "prototype"].includes(field.fieldId) ||
            Object.hasOwn(result, field.fieldId)
          )
            throw new Error("Invalid Jira form field.");
          result[field.fieldId] = field;
        }
        return result;
      });
    });
  const pageLimit = (operation: string, input: IssuePageInput) => {
    const limit = input.limit ?? 100;
    return !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (input.cursor !== undefined && (!input.cursor || input.cursor.length > 4096))
      ? Effect.fail(JiraApi.failed(operation, "Invalid Jira page."))
      : Effect.succeed(limit);
  };
  const relation = (issue: typeof JiraIssue.Type, host: string, scope: string): IssueRelation => ({
    scope:
      issue.fields.project?.key === scope || issue.fields.project?.id === scope
        ? scope
        : issue.fields.project!.key,
    key: issue.key,
    displayKey: issue.key,
    title: issue.fields.summary,
    url: JiraApi.jiraIssueUrl(host, issue.key),
    state: jiraState(issue.fields.status),
  });

  const richDocument = (
    cloud: boolean,
    operation: string,
    richBody: Parameters<typeof parseJiraRichBody>[0],
  ) =>
    JiraApi.attempt(operation, () =>
      parseJiraRichBody(richBody, cloud ? "cloud" : "data-center", operation === "editComment"),
    );
  const api: StandaloneIssueTrackerApi = {
    kind: JiraApi.KIND,
    standalone: DESCRIPTOR,
    capabilities: CAPABILITIES,
    probeCredential: jira.probeCredential,
    listScopes: jira.listScopes,
    getScope: jira.getScope,
    getViewer: (input) => viewer(input.host),
    listIssues: (input) =>
      Effect.gen(function* () {
        if (input.scope.trim() === "")
          return yield* JiraApi.failed("listIssues", "Choose a Jira project.");
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
        if (jql === null) return { items: [], nextCursor: null };
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
            page.issues.map((issue) => normalizeJiraIssue(issue, input.host)),
          ),
          nextCursor: page.isLast === true ? null : (page.nextPageToken ?? null),
        };
      }),
    getIssue: (input) =>
      Effect.gen(function* () {
        const issue = yield* requireIssue(input);
        const remoteLinksRequest = jira.request({
          host: input.host,
          operation: "getIssue",
          method: "GET",
          path: "/issue/" + encodeURIComponent(input.key) + "/remotelink",
          schema: RemoteLinks,
        });
        const [who, rawPermissions, remoteLinks, deployment] = yield* Effect.all(
          [
            viewer(input.host),
            permissions(input, "getIssue"),
            remoteLinksRequest,
            jira.deploymentFor(input.host),
          ],
          { concurrency: 4 },
        );
        const embedded = issue.fields.comment;
        const completeComments =
          embedded !== undefined &&
          (embedded.startAt ?? 0) === 0 &&
          (embedded.comments?.length ?? 0) === embedded.total;
        const page = completeComments
          ? yield* commentResult(
              { ...input, viewer: who },
              {
                startAt: 0,
                total: embedded.total,
                comments: (embedded.comments ?? []).toSorted(
                  (a, b) => Date.parse(b.created) - Date.parse(a.created),
                ),
              },
              rawPermissions,
              deployment,
            )
          : yield* comments({ ...input, viewer: who }, 0, rawPermissions, deployment);
        const events = yield* history(
          input,
          "desc",
          50,
          undefined,
          issue.changelog === undefined
            ? undefined
            : { ...issue.changelog, values: issue.changelog.histories },
          "getIssue",
        );
        const richBody = jiraRichBody(issue.fields.description, deployment);
        const parentContext =
          deployment === "cloud" ? null : yield* dataCenterParentContext(input, issue);
        const updateParent = parentContext !== null && parentContext.ownEpic === null;
        return {
          ...(yield* JiraApi.attempt("getIssue", () => normalizeJiraIssue(issue, input.host))),
          body: yield* JiraApi.attempt("getIssue", () => jiraBodyText(issue.fields.description)),
          bodyEditable: yield* JiraApi.attempt(
            "getIssue",
            () => deployment === "cloud" && jiraBodyEditable(issue.fields.description),
          ),
          ...(richBody === undefined ? {} : { richBody }),
          ...(deployment === "cloud" ? {} : { capabilities: { ...CAPABILITIES, updateParent } }),
          externalLinks: remoteLinks.flatMap(safeRemoteLink),
          states: [jiraState(issue.fields.status)],
          viewer: who,
          viewerPermissions: {
            ...toPermissions(rawPermissions),
            ...(deployment === "cloud"
              ? {}
              : { updateParent: updateParent && allowed(rawPermissions, "EDIT_ISSUES") }),
          },
          comments: page.comments,
          commentsCursor: page.nextCursor,
          events: events.items,
          historyTruncated: events.nextCursor !== null,
          linkedPullRequests: [],
        };
      }),
    getComments: (input) =>
      Effect.gen(function* () {
        const order = input.order ?? "desc";
        const previous = yield* JiraApi.attempt("getComments", () =>
          timelineCursor(input, "comments", order, input.cursor),
        );
        yield* requireScopeIssue(input, "getComments");
        return yield* comments(
          input,
          previous?.position ?? 0,
          input.viewer === undefined ? undefined : yield* permissions(input, "getComments"),
          yield* jira.deploymentFor(input.host),
          order,
          previous,
        );
      }),
    getViewerPermissions: (input) =>
      permissions(input, "getViewerPermissions").pipe(Effect.map(toPermissions)),
    create: (input) =>
      Effect.gen(function* () {
        if (input.assignees.length > 1)
          return yield* JiraApi.failed("create", "A Jira issue can have only one assignee.");
        const parent =
          input.parentKey === undefined
            ? null
            : yield* readIssue({ ...input, key: input.parentKey });
        const types = yield* issueTypes(input);
        const availableTypes =
          parent === null ? types.filter((type) => type.subtask !== true) : types;
        const selected =
          input.issueType === undefined
            ? availableTypes.length === 1
              ? availableTypes[0]
              : undefined
            : types.find((type) => type.id === input.issueType);
        if (!selected) return yield* JiraApi.failed("create", "Select a Jira issue type first.");
        if (selected.subtask === true && parent === null)
          return yield* JiraApi.failed("create", "Select a parent issue for this Jira subtask.");
        if (
          selected.subtask === true &&
          parent !== null &&
          parent.fields.project?.key !== input.scope &&
          parent.fields.project?.id !== input.scope
        )
          return yield* JiraApi.failed(
            "getIssue",
            "This issue is outside the selected Jira project.",
            "not-found",
          );
        if (input.templateKey !== undefined)
          return yield* JiraApi.failed("create", "Jira issue templates are not supported.");
        const metadata = yield* createFields(input, selected.id, "create");
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        const nativeFields = yield* formAttempt("create", () =>
          jiraFieldValues(metadata, input.fieldValues, createReserved, cloud),
        );
        const primaryValues = {
          summary: input.title,
          description: input.body,
          labels: input.labels,
          assignee: input.assignees,
          parent: parent?.key,
        };
        yield* formAttempt("create", () => {
          for (const [id, value] of Object.entries(primaryValues)) {
            const field = metadata[id];
            const empty =
              value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
            if (field?.required && !field.hasDefaultValue && empty)
              throw new Error("Missing required Jira field.");
            if (field?.operations !== undefined && !field.operations.includes("set") && !empty)
              throw new Error("This Jira field cannot be set.");
          }
        });
        const fields = new Set(Object.keys(metadata));
        if (
          (parent !== null && selected.subtask !== true && !fields.has("parent")) ||
          (input.body !== "" && !fields.has("description")) ||
          (input.labels.length > 0 && !fields.has("labels")) ||
          (input.assignees.length > 0 && !fields.has("assignee"))
        )
          return yield* JiraApi.failed(
            "create",
            "This Jira issue type does not allow the selected description, labels or assignee on creation.",
          );
        const body = yield* JiraApi.attempt("create", () =>
          cloud ? textToAdf(input.body) : input.body,
        );
        const created = yield* jira.request({
          host: input.host,
          operation: "create",
          method: "POST",
          path: "/issue",
          schema: Schema.Struct({ key: Text }),
          body: {
            fields: {
              ...nativeFields,
              project: /^[0-9]+$/.test(input.scope) ? { id: input.scope } : { key: input.scope },
              issuetype: { id: selected.id },
              summary: input.title,
              ...(parent === null ? {} : { parent: { key: parent.key } }),
              ...(fields.has("description") &&
              !(metadata.description?.hasDefaultValue && input.body === "")
                ? { description: body }
                : {}),
              ...(fields.has("labels") &&
              !(metadata.labels?.hasDefaultValue && input.labels.length === 0)
                ? { labels: input.labels }
                : {}),
              ...(input.assignees[0] === undefined
                ? {}
                : { assignee: { accountId: input.assignees[0] } }),
            },
          },
        });
        return {
          ...(parent === null ? {} : { parentLinked: true }),
          key: created.key,
          displayKey: created.key,
          url: JiraApi.jiraIssueUrl(input.host, created.key),
        };
      }),
    comment: (input) =>
      Effect.gen(function* () {
        yield* requireScopeIssue(input, "comment");
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        const body = yield* JiraApi.attempt("comment", () =>
          cloud ? textToAdf(input.body) : input.body,
        );
        yield* jira.request({
          host: input.host,
          operation: "comment",
          method: "POST",
          path: "/issue/" + encodeURIComponent(input.key) + "/comment",
          schema: JiraComment,
          body: { body },
        });
      }),
    editComment: (input) =>
      Effect.gen(function* () {
        yield* requireScopeIssue(input, "editComment");
        const path =
          "/issue/" +
          encodeURIComponent(input.key) +
          "/comment/" +
          encodeURIComponent(input.commentId);
        const comment = yield* jira.request({
          host: input.host,
          operation: "editComment",
          method: "GET",
          path,
          schema: JiraComment,
        });
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        if (
          input.richBody === undefined &&
          (!cloud || !(yield* JiraApi.attempt("editComment", () => jiraBodyEditable(comment.body))))
        )
          return yield* JiraApi.failed(
            "editComment",
            "This comment has rich content. Edit it in Jira to preserve its formatting and attachments.",
          );
        const body =
          input.richBody === undefined
            ? yield* JiraApi.attempt("editComment", () =>
                cloud ? textToAdf(input.body) : input.body,
              )
            : yield* richDocument(cloud, "editComment", input.richBody);
        yield* jira.request({
          host: input.host,
          operation: "editComment",
          method: "PUT",
          path,
          schema: JiraComment,
          body: { body },
        });
      }),
    getHierarchy: (input) =>
      Effect.gen(function* () {
        const limit = yield* pageLimit("getHierarchy", input);
        const current = yield* requireIssue(input);
        const parentContext =
          (yield* jira.deploymentFor(input.host)) === "cloud"
            ? null
            : yield* dataCenterParentContext(input, current);
        const parentKey = current.fields.parent?.key ?? parentContext?.current.fields.epic?.key;
        const epic = parentContext?.ownEpic;
        const epicCursor =
          epic == null || !input.cursor?.startsWith("epic:") ? undefined : input.cursor.slice(5);
        if (epicCursor !== undefined)
          yield* JiraApi.attempt("getHierarchy", () => commentOffset(epicCursor));
        const parent =
          parentKey === undefined
            ? null
            : yield* jira.request({
                host: input.host,
                operation: "getHierarchy",
                method: "GET",
                path:
                  "/issue/" +
                  encodeURIComponent(parentKey) +
                  "?fields=" +
                  issueFields.filter((field) => field !== "description").join(","),
                schema: JiraIssue,
              });
        const page =
          epicCursor === undefined
            ? yield* jira.request({
                host: input.host,
                operation: "getHierarchy",
                method: "POST",
                path: "/search/jql",
                schema: Search,
                body: {
                  jql: "parent = " + quoteJiraJql(current.key) + " ORDER BY created DESC",
                  fields: issueFields.filter((field) => field !== "description"),
                  maxResults: limit,
                  ...(input.cursor === undefined ? {} : { nextPageToken: input.cursor }),
                },
              })
            : { issues: [], isLast: true, nextPageToken: undefined };
        if (
          page.issues.length > limit ||
          (page.isLast === false && !page.nextPageToken) ||
          (input.cursor !== undefined && page.nextPageToken === input.cursor) ||
          page.issues.some(
            (child) =>
              child.fields.parent?.key !== current.key || child.fields.project === undefined,
          ) ||
          (parent !== null && parent.fields.project === undefined)
        )
          return yield* JiraApi.failed(
            "getHierarchy",
            "Jira returned an inconsistent child issue page.",
          );
        const items = page.issues.map((child) => relation(child, input.host, input.scope));
        let nextCursor = page.isLast === true ? null : (page.nextPageToken ?? null);
        if (epic != null && nextCursor === null) {
          nextCursor = "epic:" + (epicCursor ?? "0");
          if (items.length < limit) {
            const children = yield* jira
              .request({
                host: input.host,
                operation: "getHierarchy",
                method: "GET",
                path:
                  "/agile/1.0/epic/" +
                  encodeURIComponent(current.key) +
                  "/issue?startAt=" +
                  (epicCursor ?? "0") +
                  "&maxResults=" +
                  (limit - items.length) +
                  "&fields=" +
                  issueFields.filter((field) => field !== "description").join(",") +
                  ",epic",
                schema: AgileSearch,
              })
              .pipe(
                Effect.catchIf(
                  (error) => JiraApi.isHttpStatus(error, 403) || JiraApi.isHttpStatus(error, 404),
                  () => Effect.succeed(null),
                ),
              );
            if (children === null)
              return {
                parent: parent === null ? null : relation(parent, input.host, input.scope),
                children: { items, nextCursor: null, truncated: true },
              };
            if (
              children.issues.length > limit - items.length ||
              children.issues.some(
                (child) =>
                  child.fields.epic?.key !== current.key || child.fields.project === undefined,
              )
            )
              return yield* JiraApi.failed(
                "getHierarchy",
                "Jira returned inconsistent epic children.",
              );
            items.push(
              ...children.issues
                .filter((child) => child.fields.issuetype?.subtask !== true)
                .map((child) => relation(child, input.host, input.scope)),
            );
            nextCursor =
              children.isLast === true || children.nextPageToken === undefined
                ? null
                : "epic:" + children.nextPageToken;
          }
        }
        return {
          parent: parent === null ? null : relation(parent, input.host, input.scope),
          children: {
            items,
            nextCursor,
          },
        };
      }),
    setParent: (input) =>
      Effect.gen(function* () {
        const deployment = yield* jira.deploymentFor(input.host);
        const selected = yield* requireIssue(input);
        if (input.parentKey === null && selected.fields.issuetype?.subtask === true)
          return yield* JiraApi.failed(
            "setParent",
            "Jira subtasks must have a parent. Change the issue type in Jira first.",
          );
        if (deployment === "data-center") {
          const context = yield* dataCenterParentContext(input, selected);
          if (context === null || context.ownEpic !== null)
            return yield* JiraApi.failed(
              "setParent",
              "Only base issues can change their Jira Software epic here.",
            );
        }
        const parent =
          input.parentKey === null ? null : yield* readIssue({ ...input, key: input.parentKey });
        if (parent?.key === selected.key)
          return yield* JiraApi.failed("setParent", "An issue cannot be its own parent.");
        if (deployment === "data-center") {
          if (parent !== null) {
            const epic = yield* jira.request({
              host: input.host,
              operation: "setParent",
              method: "GET",
              path: "/agile/1.0/epic/" + encodeURIComponent(parent.key),
              schema: Epic,
            });
            if (epic.key !== parent.key)
              return yield* JiraApi.failed("setParent", "Jira returned a different epic.");
          }
          yield* jira.request({
            host: input.host,
            operation: "setParent",
            method: "POST",
            path:
              "/agile/1.0/epic/" +
              (parent === null ? "none" : encodeURIComponent(parent.key)) +
              "/issue",
            schema: Schema.Undefined,
            body: { issues: [selected.key] },
          });
          return;
        }
        yield* jira.request({
          host: input.host,
          operation: "setParent",
          method: "PUT",
          path: "/issue/" + encodeURIComponent(selected.key),
          schema: Schema.Undefined,
          body:
            parent === null
              ? { update: { parent: [{ set: { none: true } }] } }
              : { fields: { parent: { key: parent.key } } },
        });
      }),
    getHistory: (input) =>
      Effect.gen(function* () {
        const limit = yield* pageLimit("getHistory", input);
        const order = input.order ?? "desc";
        const previous = yield* JiraApi.attempt("getHistory", () =>
          timelineCursor(input, "history", order, input.cursor),
        );
        const expanded =
          previous === undefined &&
          order === "desc" &&
          (yield* jira.deploymentFor(input.host)) === "data-center";
        const issue = yield* requireScopeIssue(input, "getHistory", false, expanded);
        return yield* history(
          input,
          order,
          Math.min(limit, 100),
          previous,
          expanded && issue.changelog !== undefined
            ? { ...issue.changelog, values: issue.changelog.histories }
            : undefined,
        );
      }),
    listLabelCandidates: (input) =>
      Effect.gen(function* () {
        const limit = yield* pageLimit("listLabelCandidates", input);
        const page = yield* jira.request({
          host: input.host,
          operation: "listLabelCandidates",
          method: "POST",
          path: "/search/jql",
          schema: Search,
          body: {
            jql: "project = " + quoteJiraJql(input.scope) + " ORDER BY updated DESC",
            fields: issueFields.filter((field) => field !== "description"),
            maxResults: limit,
            ...(input.cursor === undefined ? {} : { nextPageToken: input.cursor }),
          },
        });
        if (
          page.issues.length > limit ||
          (page.isLast === false && !page.nextPageToken) ||
          (input.cursor !== undefined && page.nextPageToken === input.cursor) ||
          page.issues.some(
            (issue) =>
              !issue.fields.project ||
              (issue.fields.project.key !== input.scope && issue.fields.project.id !== input.scope),
          )
        )
          return yield* JiraApi.failed(
            "listLabelCandidates",
            "Jira returned labels outside this project or an inconsistent page.",
          );
        return {
          items: [...new Set(page.issues.flatMap((issue) => issue.fields.labels ?? []))].map(
            (name) => ({ name, color: null, description: null }),
          ),
          nextCursor: page.isLast === true ? null : (page.nextPageToken ?? null),
        };
      }),
    listAssigneeCandidates: (input) =>
      Effect.gen(function* () {
        const limit = yield* pageLimit("listAssigneeCandidates", input);
        const startAt = yield* JiraApi.attempt("listAssigneeCandidates", () =>
          commentOffset(input.cursor ?? "0"),
        );
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        if (!cloud && startAt !== 0)
          return yield* JiraApi.failed(
            "listAssigneeCandidates",
            "Jira Data Center assignee search has no next page.",
          );
        if (startAt >= 1000)
          return yield* JiraApi.failed(
            "listAssigneeCandidates",
            "Jira assignee search is limited to the first 1000 users.",
          );
        const window = Math.min(limit, cloud ? 1000 - startAt : 100);
        const users = yield* jira.request({
          host: input.host,
          operation: "listAssigneeCandidates",
          method: "GET",
          path:
            "/user/assignable/search?project=" +
            encodeURIComponent(input.scope) +
            "&startAt=" +
            startAt +
            "&maxResults=" +
            window,
          schema: bounded(JiraUser, 200),
        });
        if (users.length > window)
          return yield* JiraApi.failed(
            "listAssigneeCandidates",
            "Jira returned too many assignees.",
          );
        return {
          items: users.map(jiraActor),
          nextCursor: cloud && startAt + window < 1000 ? String(startAt + window) : null,
          ...(cloud
            ? startAt + window >= 1000
              ? { truncated: true }
              : {}
            : users.length === window
              ? { truncated: true }
              : {}),
        };
      }),
    update: (input) =>
      Effect.gen(function* () {
        if (input.assignees !== undefined && input.assignees.length > 1)
          return yield* JiraApi.failed("update", "A Jira issue can have only one assignee.");
        const issue = yield* requireScopeIssue(
          input,
          "update",
          input.body !== undefined || input.richBody !== undefined,
        );
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        if (
          input.body !== undefined &&
          input.richBody === undefined &&
          (!cloud ||
            !(yield* JiraApi.attempt("update", () => jiraBodyEditable(issue.fields.description))))
        )
          return yield* JiraApi.failed(
            "update",
            "This description has rich content. Edit it in Jira to preserve its formatting and attachments.",
          );
        const text = input.body;
        const body =
          input.richBody !== undefined
            ? yield* richDocument(cloud, "update", input.richBody)
            : text === undefined
              ? undefined
              : yield* JiraApi.attempt("update", () => (cloud ? textToAdf(text) : text));
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
        if (input.closeReason !== undefined)
          return yield* JiraApi.failed(
            "setState",
            "Choose a Jira workflow transition without a close reason.",
          );
        const issue = yield* requireScopeIssue(input, "setState");
        if (
          input.transitionId === undefined &&
          Object.keys(input.fieldValues ?? {}).length === 0 &&
          (issue.fields.status.id === input.state ||
            issue.fields.status.name === input.state ||
            ((input.state === "open" || input.state === "closed") &&
              (issue.fields.status.statusCategory.key === "done") === (input.state === "closed")))
        )
          return;
        const available = yield* transitions(input);
        const candidates = available.transitions.filter(
          (transition) =>
            transition.isAvailable !== false &&
            (input.transitionId === undefined || transition.id === input.transitionId) &&
            (transition.to.id === input.state ||
              transition.to.name === input.state ||
              ((input.state === "open" || input.state === "closed") &&
                matchesState(transition, input.state))),
        );
        const transition = candidates.length === 1 ? candidates[0] : undefined;
        if (!transition)
          return yield* JiraApi.failed(
            "setState",
            "Choose one available Jira workflow transition.",
          );
        const cloud = (yield* jira.deploymentFor(input.host)) === "cloud";
        const fields = yield* formAttempt("setState", () =>
          jiraFieldValues(
            transitionFields(transition),
            input.fieldValues,
            transitionReserved,
            cloud,
          ),
        );
        yield* jira.request({
          host: input.host,
          operation: "setState",
          method: "POST",
          path: "/issue/" + encodeURIComponent(input.key) + "/transitions",
          schema: Schema.Undefined,
          body: {
            transition: { id: transition.id },
            ...(Object.keys(fields).length === 0 ? {} : { fields }),
          },
        });
      }),
    listCandidates: (input) =>
      Effect.gen(function* () {
        const issueTarget = input.key === undefined ? null : { ...input, key: input.key };
        if (issueTarget !== null) yield* requireScopeIssue(issueTarget, "listCandidates");
        const raw = yield* permissions(input, "listCandidates");
        const available = issueTarget === null ? null : yield* transitions(issueTarget);
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
        if (input.issueType !== undefined && !types.some((type) => type.id === input.issueType))
          return yield* JiraApi.failed("listCandidates", "Select an available Jira issue type.");
        const fields =
          input.issueType === undefined
            ? undefined
            : yield* createFields(input, input.issueType, "listCandidates").pipe(
                Effect.flatMap((metadata) =>
                  JiraApi.attempt("listCandidates", () =>
                    jiraInputFields(metadata, createReserved),
                  ),
                ),
              );
        const statuses =
          available === null
            ? (yield* jira.request({
                host: input.host,
                operation: "listCandidates",
                method: "GET",
                path: "/project/" + encodeURIComponent(input.scope) + "/statuses",
                schema: bounded(Schema.Struct({ statuses: bounded(JiraStatus) })),
              })).flatMap((type) => type.statuses)
            : [];
        const nativeStates = [...new Map(statuses.map((status) => [status.id, status])).values()];
        if (nativeStates.length > 100)
          return yield* JiraApi.failed(
            "listCandidates",
            "This Jira project has too many states to load here.",
          );
        return {
          states:
            available === null
              ? nativeStates.map(jiraState)
              : yield* JiraApi.attempt("listCandidates", () =>
                  available.transitions
                    .filter((transition) => transition.isAvailable !== false)
                    .map((transition) => ({
                      ...jiraState(transition.to),
                      name: transition.name ?? transition.to.name,
                      transitionId: transition.id,
                      fields: jiraInputFields(transitionFields(transition), transitionReserved),
                    })),
                ),
          ...(fields === undefined ? {} : { fields }),
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
