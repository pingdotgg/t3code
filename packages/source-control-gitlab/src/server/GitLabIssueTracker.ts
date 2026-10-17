/**
 * GitLab's issue tracker over `glab api`, which signs every request with the credentials the
 * checkout's remote resolves to, the way the merge request reads do.
 *
 * @module source-control-gitlab/server/GitLabIssueTracker
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  IssueTrackerKind,
  issueHostKey,
  type IssueCapabilities,
  type IssueActor,
  type IssueEvent,
  type IssuePageInput,
  type IssueListOrder,
  type IssueInvolvement,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type IssueScopeTarget,
  type IssueTarget,
  type TrackerIssueDetail,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import * as GitLabCli from "./GitLabCli.ts";
import {
  decodeCreatedIssueJson,
  decodeIssueAwardPageJson,
  decodeIssueAwardsJson,
  decodeIssueDetailJson,
  decodeIssueListJson,
  decodeIssueOwnAwardPageJson,
  decodeIssueViewerPermissionsJson,
  decodeIssueUpdatedMetadataJson,
  decodeLinkedMergeRequestsJson,
  decodeProjectLabelsJson,
  decodeProjectMembersJson,
  decodeTemplateEntriesJson,
  decodeTemplateJson,
  ISSUE_AWARD_EMOJI_GRAPHQL_QUERY,
  ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
  PAGE_SIZE,
  toSystemEvent,
  nativeEventUrl,
  type GitLabTemplateEntry,
} from "./gitLabIssueJson.ts";
import { decodeViewerJson, gitLabAwardName, toReactions } from "./gitLabMergeRequestJson.ts";
import {
  decodeWorkItemEnvelope,
  decodeWorkItemJson,
  decodeWorkItemMutationJson,
  decodeEpicJson,
  decodeEpicHistoryJson,
  EPIC_QUERY,
  EPIC_HISTORY_QUERY,
  WORK_ITEM_HIERARCHY_QUERY,
  WORK_ITEM_PARENT_MUTATION,
  WORK_ITEM_QUERY,
  type GitLabWorkItem,
  type GitLabWorkItemWithHierarchy,
  type GitLabEpic,
  type GitLabEpicActivity,
} from "./gitLabIssueHierarchy.ts";

const EditCommentPermissions = Schema.Struct({
  data: Schema.Struct({
    note: Schema.NullOr(
      Schema.Struct({ userPermissions: Schema.Struct({ adminNote: Schema.Boolean }) }),
    ),
  }),
});
const HistoryActor = Schema.Struct({
  id: Schema.optional(Schema.Int),
  username: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const HistoryRow = Schema.Struct({
  id: Schema.Int,
  created_at: Schema.String,
  body: Schema.optional(Schema.String),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  system: Schema.optional(Schema.Boolean),
  action: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  author: Schema.optional(Schema.NullOr(HistoryActor)),
  user: Schema.optional(Schema.NullOr(HistoryActor)),
  label: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
});

const TimelineCursor = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literals(["comments", "history"]),
  target: Schema.String,
  position: Schema.String,
});
const CommentPosition = Schema.Struct({
  native: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  ids: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
const HistoryPosition = Schema.Struct({
  page: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000000 })),
  offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resourceOffset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 })),
  ids: Schema.Array(Schema.Int).check(Schema.isMaxLength(100)),
  resources: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  previousIds: Schema.Array(Schema.Int).check(Schema.isMaxLength(100)),
  previousTime: Schema.NullOr(Schema.String),
});

const KIND = IssueTrackerKind.make("gitlab");

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  editComment: true,
  subIssues: true,
  createSubIssue: true,
  updateParent: true,
  subIssueNoun: "Tasks",
  listSorts: ["created", "updated"],
  listOrders: ["asc", "desc"],
  commentOrders: ["asc", "desc"],
  historyOrders: ["asc", "desc"],
  labels: true,
  assignees: true,
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: true,
  involvements: ["all", "assigned", "authored"],
  states: [
    { category: "open", name: "open" },
    { category: "closed", name: "closed" },
  ],
  // GitLab records nothing about why an issue was closed.
  closeReasons: [],
};

const EPIC_CAPABILITIES: IssueCapabilities = {
  commentOrders: ["asc", "desc"],
  historyOrders: ["asc", "desc"],
  create: false,
  edit: false,
  comment: false,
  editComment: false,
  subIssues: true,
  createSubIssue: false,
  updateParent: false,
  subIssueNoun: "Work items",
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: true,
  search: false,
  states: [],
  closeReasons: [],
};
const EPIC_PERMISSIONS: IssueViewerPermissions = {
  updateParent: false,
  setState: false,
  comment: false,
  edit: false,
  labels: false,
  assignees: false,
};

function groupPath(scope: string): string | null {
  const trimmed = scope.trim();
  return /^group:/i.test(trimmed) ? trimmed.slice(6) : null;
}

function epicActor(actor: GitLabEpic["author"]): IssueActor | null {
  return actor === null
    ? null
    : { id: actor.id, login: actor.username, name: actor.name, avatarUrl: actor.avatarUrl };
}

/** How many of a scope's templates are read in full; each one is a request of its own. */
const TEMPLATE_LIMIT = 20;

const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The REST API addresses a project by its URL-encoded full path. */
function projectPath(scope: string): string {
  return encodeURIComponent(scope.trim());
}

/** An issue key is its iid; anything else names no GitLab issue. */
function parseNumber(key: string): number | null {
  return /^[1-9]\d*$/.test(key) ? Number(key) : null;
}

/** A page cursor this tracker handed out, or null for anything it could not have issued. */
function parsePage(cursor: string | undefined): number | null {
  if (cursor === undefined) return 1;
  return /^[1-9]\d{0,6}$/.test(cursor) ? Number(cursor) : null;
}

function query(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

function involvementParams(input: {
  readonly involvement: IssueInvolvement;
  readonly viewer: string;
}): ReadonlyArray<readonly [string, string]> {
  switch (input.involvement) {
    case "authored":
      return [["author_username", input.viewer]];
    case "assigned":
      return [["assignee_username", input.viewer]];
    case "mentioned":
    case "all":
      return [];
  }
}

function reasonFor(error: GitLabCli.GitLabCliError): IssueTrackerError["reason"] {
  switch (error._tag) {
    case "GitLabCliUnavailableError":
      return "missing-tool";
    case "GitLabCliAuthenticationError":
      return "unauthenticated";
    case "GitLabCliRateLimitError":
      return "rate-limited";
    default:
      return "failed";
  }
}

export const make: Effect.Effect<IssueTrackerApi, never, GitLabCli.GitLabCli> = Effect.gen(
  function* () {
    const gitlab = yield* GitLabCli.GitLabCli;

    const fail = (operation: string) => (error: GitLabCli.GitLabCliError) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: reasonFor(error),
        detail: error.message,
        cause: error,
      });

    const unreadable = (operation: string, cause: unknown) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: "failed",
        detail: `GitLab returned an unreadable ${operation} response.`,
        cause,
      });

    const notFound = (operation: string) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: "not-found",
        detail: "GitLab could not find the requested issue.",
      });

    const refused = (operation: string, detail: string) =>
      new IssueTrackerError({ tracker: KIND, operation, reason: "failed", detail });

    const api = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly operation: string;
      readonly path: string;
      readonly method?: string;
      readonly body?: unknown;
      readonly includeHeaders?: boolean;
    }) =>
      GitLabCli.api(
        input.includeHeaders
          ? (request) => gitlab.execute({ ...request, args: [...request.args, "--include"] })
          : gitlab.execute,
        {
          cwd: input.cwd,
          path: input.path,
          hostname: input.host,
          ...(input.method === undefined ? {} : { method: input.method }),
          ...(input.body === undefined ? {} : { stdin: encodeBody(input.body) }),
        },
      ).pipe(
        Effect.mapError(fail(input.operation)),
        Effect.flatMap((result) =>
          (input.operation === "listTemplates" ||
            input.operation === "update" ||
            input.operation === "getHistory" ||
            input.path === "graphql") &&
          result.stdoutTruncated
            ? Effect.fail(unreadable(input.operation, "truncated-response"))
            : Effect.succeed(result.stdout.trim()),
        ),
      );

    const read = <A>(input: {
      readonly cwd: string;
      readonly host: string;
      readonly operation: string;
      readonly path: string;
      readonly method?: string;
      readonly body?: unknown;
      readonly decode: (raw: string) => Result.Result<A, unknown>;
    }): Effect.Effect<A, IssueTrackerError> =>
      api(input).pipe(
        Effect.flatMap((raw) => {
          const decoded = input.decode(raw);
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(unreadable(input.operation, decoded.failure));
        }),
      );

    const write = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly operation: string;
      readonly path: string;
      readonly method: string;
      readonly body?: unknown;
    }) => api(input).pipe(Effect.asVoid);

    const nativeGraphql = (
      input: IssueScopeTarget,
      operation: string,
      query: string,
      variables: unknown,
    ) =>
      api({
        ...input,
        operation,
        path: "graphql",
        method: "POST",
        body: { query, variables },
      }).pipe(
        Effect.flatMap((raw) => {
          const envelope = decodeWorkItemEnvelope(raw);
          if (Result.isFailure(envelope))
            return Effect.fail(unreadable(operation, envelope.failure));
          return envelope.success.errors?.length
            ? Effect.fail(
                refused(
                  operation,
                  envelope.success.errors.map((error) => error.message).join("; "),
                ),
              )
            : Effect.succeed(raw);
        }),
      );

    const targetIdentity = (input: IssueTarget & { readonly order?: IssueListOrder }) =>
      encodeBody([
        input.cwd,
        issueHostKey(input.host),
        input.scope.trim().toLowerCase(),
        input.key,
        input.connectionId ?? null,
        input.order ?? "desc",
      ]);
    const cursorFor = (
      input: IssueTarget & { readonly order?: IssueListOrder },
      kind: "comments" | "history",
      position: string,
    ) =>
      Effect.gen(function* () {
        const payload = Buffer.from(
          encodeBody({ v: 1, kind, target: targetIdentity(input), position }),
        ).toString("base64url");
        if (payload.length > 8192)
          return yield* refused(
            kind === "comments" ? "getComments" : "getHistory",
            "GitLab returned an oversized timeline cursor.",
          );
        return payload;
      });
    const cursorPosition = (
      input: IssueTarget & {
        readonly cursor?: string | undefined;
        readonly order?: IssueListOrder;
      },
      kind: "comments" | "history",
      operation: string,
    ) =>
      Effect.gen(function* () {
        if (input.order !== undefined && input.order !== "asc" && input.order !== "desc")
          return yield* refused(operation, "The timeline order is invalid.");
        if (input.cursor === undefined) return undefined;
        if (input.cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
          return yield* refused(operation, "The timeline cursor is invalid. Refresh this issue.");
        const decoded = decodeJsonResult(TimelineCursor)(
          Buffer.from(input.cursor, "base64url").toString("utf8"),
        );
        if (
          Result.isFailure(decoded) ||
          decoded.success.kind !== kind ||
          decoded.success.target !== targetIdentity(input) ||
          Buffer.from(encodeBody(decoded.success)).toString("base64url") !== input.cursor
        )
          return yield* refused(
            operation,
            "The timeline cursor belongs to another account, issue, or order.",
          );
        return decoded.success.position;
      });

    const hierarchyWidget = (item: GitLabWorkItemWithHierarchy, operation: string) => {
      const widgets = item.widgets.filter(
        (widget) => widget.__typename === "WorkItemWidgetHierarchy",
      );
      const widget = widgets[0];
      return widgets.length === 1 && widget?.parent !== undefined
        ? Effect.succeed({ ...widget, parent: widget.parent })
        : Effect.fail(
            refused(
              operation,
              "GitLab does not expose a readable hierarchy widget for this work item.",
            ),
          );
    };

    const projectWorkItem = (input: IssueTarget, item: GitLabWorkItem, operation: string) =>
      item.iid === input.key &&
      item.project?.fullPath.toLowerCase() === input.scope.trim().toLowerCase() &&
      item.namespace.fullPath.toLowerCase() === input.scope.trim().toLowerCase()
        ? Effect.succeed(item)
        : Effect.fail(refused(operation, "The work item does not belong to this project."));

    const groupWorkItem = (input: IssueTarget, item: GitLabWorkItem, operation: string) =>
      item.iid === input.key &&
      item.project === null &&
      item.workItemType.name === "Epic" &&
      item.namespace.fullPath.toLowerCase() === groupPath(input.scope)?.toLowerCase()
        ? Effect.void
        : Effect.fail(refused(operation, "The work item is not an Epic in this group."));

    const workItem = (
      input: IssueTarget,
      operation: string,
      page?: { first: number; after?: string },
    ) =>
      Effect.gen(function* () {
        const iid = parseNumber(input.key);
        if (iid === null || !Number.isSafeInteger(iid)) return yield* notFound(operation);
        const group = groupPath(input.scope);
        if (
          group !== null &&
          (!input.scope.trim().startsWith("group:") ||
            group
              .split("/")
              .some((part) => !part || part === "." || part === ".." || /[:\\%?#\s]/.test(part)))
        )
          return yield* notFound(operation);
        const raw = yield* nativeGraphql(
          input,
          operation,
          page === undefined ? WORK_ITEM_QUERY : WORK_ITEM_HIERARCHY_QUERY,
          {
            fullPath: group ?? input.scope.trim(),
            iid: input.key,
            ...page,
          },
        );
        const decoded = decodeWorkItemJson(raw);
        if (Result.isFailure(decoded)) return yield* unreadable(operation, decoded.failure);
        const selected = decoded.success.data.namespace?.workItem;
        if (selected === undefined || selected === null) return yield* notFound(operation);
        if (group === null) yield* projectWorkItem(input, selected, operation);
        else yield* groupWorkItem(input, selected, operation);
        return selected;
      });

    const parentPermission = (input: IssueTarget, operation: string) =>
      workItem(input, operation).pipe(
        Effect.flatMap((item) =>
          hierarchyWidget(item, operation).pipe(
            Effect.as(
              item.workItemType.name === "Task" &&
                !item.archived &&
                item.userPermissions.adminParentLink,
            ),
          ),
        ),
        Effect.catchIf(
          (error) => error.reason === "failed" || error.reason === "not-found",
          () => Effect.succeed(false),
        ),
      );

    const relation = (input: IssueScopeTarget, item: GitLabWorkItem, operation: string) => {
      const url = URL.parse(item.webUrl);
      const prefix = `${item.project === null ? "/groups" : ""}/${item.namespace.fullPath}/-/`;
      const paths = [
        `${prefix}work_items/${item.iid}`,
        `${prefix}${item.project === null ? "epics" : "issues"}/${item.iid}`,
      ];
      if (
        url === null ||
        !["https:", "http:"].includes(url.protocol) ||
        url.host.toLowerCase() !== input.host.toLowerCase() ||
        url.username ||
        url.password ||
        !paths.includes(url.pathname.replace(/\/$/, ""))
      )
        return Effect.fail(
          refused(operation, "GitLab returned a work item URL outside this host."),
        );
      return Effect.succeed({
        scope: item.project === null ? `group:${item.namespace.fullPath}` : item.namespace.fullPath,
        key: item.iid,
        displayKey: `${item.project === null ? "&" : "#"}${item.iid}`,
        title: item.title,
        url: item.webUrl,
        itemType: item.workItemType.name,
        ...(item.project === null && item.workItemType.name !== "Epic"
          ? { externalOnly: true }
          : {}),
        state:
          item.state === "CLOSED"
            ? {
                category: "closed" as const,
                name: "closed",
                workflowCategory: "completed" as const,
              }
            : { category: "open" as const, name: "open", workflowCategory: "unstarted" as const },
      });
    };

    const projectParent = (child: GitLabWorkItem, parent: GitLabWorkItem) =>
      child.workItemType.name === "Task" &&
      parent.workItemType.name === "Issue" &&
      parent.project !== null &&
      parent.project.fullPath === child.project?.fullPath &&
      parent.namespace.fullPath === child.namespace.fullPath;

    const epicParent = (child: GitLabWorkItem, parent: GitLabWorkItem) =>
      parent.project === null &&
      parent.workItemType.name === "Epic" &&
      (child.project === null
        ? child.workItemType.name === "Epic"
        : child.workItemType.name === "Issue" &&
          child.project.fullPath === child.namespace.fullPath);

    const epicActivity = (
      page: GitLabEpicActivity | null | undefined,
      after: string | undefined,
      first: number,
      operation: string,
    ) =>
      Effect.gen(function* () {
        if (
          page == null ||
          page.nodes.length > first ||
          (page.pageInfo.hasNextPage &&
            (!page.pageInfo.endCursor ||
              page.pageInfo.endCursor.length > 4096 ||
              page.pageInfo.endCursor === after)) ||
          page.nodes.some(
            ({ notes }) =>
              notes.pageInfo.hasNextPage ||
              notes.nodes.length !== 1 ||
              notes.nodes[0]?.system !== true,
          )
        )
          return yield* refused(operation, "GitLab returned an incomplete epic activity page.");
        const items = page.nodes
          .flatMap(({ notes }) => notes.nodes)
          .map((note): IssueEvent => {
            const event = toSystemEvent(note.body);
            const label = note.id.startsWith("gid://gitlab/LabelNote/");
            return {
              id: note.id,
              kind:
                event?.kind ??
                (label && /^added .+ labels?$/.test(note.body)
                  ? "labeled"
                  : label && /^removed .+ labels?$/.test(note.body)
                    ? "unlabeled"
                    : "updated"),
              actor: epicActor(note.author),
              createdAt: note.createdAt,
              detail: event === null ? note.body.trim() || null : event.detail,
              ...(nativeEventUrl(note.url) === undefined ? {} : { url: nativeEventUrl(note.url) }),
            };
          });
        if (new Set(items.map((event) => event.id)).size !== items.length)
          return yield* refused(operation, "GitLab returned duplicate epic activity.");
        return {
          items,
          nextCursor: page.pageInfo.hasNextPage ? `activity:${page.pageInfo.endCursor}` : null,
        };
      });

    const epicHistory = (
      input: IssueTarget & IssuePageInput & { readonly order?: IssueListOrder },
    ) =>
      Effect.gen(function* () {
        const group = groupPath(input.scope);
        const iid = parseNumber(input.key);
        const first = Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE);
        const position = yield* cursorPosition(input, "history", "getHistory");
        const parsed =
          position === undefined ? undefined : decodeJsonResult(CommentPosition)(position);
        if (parsed !== undefined && Result.isFailure(parsed))
          return yield* refused("getHistory", "The activity cursor is invalid.");
        const previous =
          parsed !== undefined && Result.isSuccess(parsed) ? parsed.success : undefined;
        if (previous !== undefined && new Set(previous.ids).size !== previous.ids.length)
          return yield* refused("getHistory", "The activity cursor has duplicate note boundaries.");
        const after = previous?.native;
        if (
          group === null ||
          !input.scope.trim().startsWith("group:") ||
          group
            .split("/")
            .some((part) => !part || part === "." || part === ".." || /[:\\%?#\s]/.test(part)) ||
          iid === null ||
          !Number.isSafeInteger(iid) ||
          !Number.isSafeInteger(first) ||
          first < 1 ||
          (input.cursor !== undefined && (!after || after.length > 4096))
        )
          return yield* notFound("getHistory");
        const raw = yield* nativeGraphql(
          input,
          "getHistory",
          input.order === "asc"
            ? EPIC_HISTORY_QUERY.replace("CREATED_DESC", "CREATED_ASC")
            : EPIC_HISTORY_QUERY,
          {
            fullPath: group,
            iid: input.key,
            first,
            after: after ?? null,
          },
        );
        const decoded = decodeEpicHistoryJson(raw);
        if (Result.isFailure(decoded)) return yield* unreadable("getHistory", decoded.failure);
        const selected = decoded.success.data.namespace?.workItem;
        if (selected == null) return yield* notFound("getHistory");
        yield* groupWorkItem(input, selected, "getHistory");
        yield* relation(input, selected, "getHistory");
        const widgets = selected.widgets.filter(
          (widget) => widget.__typename === "WorkItemWidgetNotes",
        );
        if (widgets.length !== 1)
          return yield* refused(
            "getHistory",
            "GitLab returned an unreadable epic activity widget.",
          );
        const result = yield* epicActivity(widgets[0]?.discussions, after, first, "getHistory");
        if (
          result.items.some(
            (event, index) =>
              previous?.ids.includes(event.id) ||
              !Number.isFinite(Date.parse(event.createdAt)) ||
              (index > 0 &&
                (input.order === "asc"
                  ? Date.parse(event.createdAt) < Date.parse(result.items[index - 1]!.createdAt)
                  : Date.parse(event.createdAt) > Date.parse(result.items[index - 1]!.createdAt))),
          )
        )
          return yield* refused(
            "getHistory",
            "GitLab returned repeated or unordered epic activity.",
          );
        return {
          items: result.items,
          nextCursor:
            result.nextCursor === null
              ? null
              : yield* cursorFor(
                  input,
                  "history",
                  encodeBody({
                    native: result.nextCursor.slice(9),
                    ids: result.items.map(({ id }) => id),
                  }),
                ),
        };
      });

    const epic = (
      input: IssueTarget & {
        readonly cursor?: string | undefined;
        readonly order?: IssueListOrder;
      },
      operation: string,
    ) =>
      Effect.gen(function* () {
        const position = yield* cursorPosition(input, "comments", operation);
        const parsed =
          position === undefined ? undefined : decodeJsonResult(CommentPosition)(position);
        if (parsed !== undefined && Result.isFailure(parsed))
          return yield* refused(operation, "The comments cursor is invalid.");
        const previous =
          parsed !== undefined && Result.isSuccess(parsed) ? parsed.success : undefined;
        if (previous !== undefined && new Set(previous.ids).size !== previous.ids.length)
          return yield* refused(operation, "The comments cursor has duplicate note boundaries.");
        const group = groupPath(input.scope);
        const iid = parseNumber(input.key);
        if (
          group === null ||
          !input.scope.trim().startsWith("group:") ||
          group
            .split("/")
            .some((part) => !part || part === "." || part === ".." || /[:\\%?#\s]/.test(part)) ||
          iid === null ||
          !Number.isSafeInteger(iid)
        )
          return yield* notFound(operation);
        const raw = yield* nativeGraphql(
          input,
          operation,
          input.order === "asc"
            ? EPIC_QUERY.replace(
                "notes(last: 100, before: $before)",
                "notes(first: 100, after: $before)",
              ).replace(
                "hasPreviousPage startCursor",
                "hasPreviousPage: hasNextPage startCursor: endCursor",
              )
            : EPIC_QUERY,
          {
            fullPath: group,
            iid: input.key,
            before: previous?.native ?? null,
            includeHistory: operation === "getIssue",
            first: PAGE_SIZE,
            after: null,
          },
        );
        const decoded = decodeEpicJson(raw);
        if (Result.isFailure(decoded)) return yield* unreadable(operation, decoded.failure);
        const selected = decoded.success.data.namespace?.workItem;
        if (selected === undefined || selected === null) return yield* notFound(operation);
        yield* groupWorkItem(input, selected, operation);
        const reference = yield* relation(input, selected, operation);
        const notes = selected.widgets.filter(
          (widget) => widget.__typename === "WorkItemWidgetNotes",
        );
        const page = notes[0]?.notes;
        if (
          notes.length !== 1 ||
          page === undefined ||
          page.nodes.length > PAGE_SIZE ||
          (page.pageInfo.hasPreviousPage &&
            (!page.pageInfo.startCursor ||
              page.pageInfo.startCursor.length > 4096 ||
              page.pageInfo.startCursor === previous?.native))
        )
          return yield* refused(operation, "GitLab returned an unreadable epic notes page.");
        if (
          new Set(page.nodes.map(({ id }) => id)).size !== page.nodes.length ||
          page.nodes.some(({ id }) => previous?.ids.includes(id))
        )
          return yield* refused(operation, "GitLab returned repeated epic comments.");
        const comments = (input.order === "asc" ? page.nodes : page.nodes.toReversed())
          .filter((note) => !note.system)
          .map((note) => ({
            id: note.id,
            author: epicActor(note.author),
            body: note.body,
            createdAt: note.createdAt,
            editedAt: note.lastEditedAt,
            url: nativeEventUrl(note.url) ?? null,
            canEdit: false,
          }));
        const activity =
          operation === "getIssue"
            ? yield* epicActivity(notes[0]?.discussions, undefined, PAGE_SIZE, operation)
            : { items: [], nextCursor: null };
        const nextCursor =
          page.pageInfo.hasPreviousPage && page.pageInfo.startCursor !== null
            ? yield* cursorFor(
                input,
                "comments",
                encodeBody({
                  native: page.pageInfo.startCursor,
                  ids: page.nodes.map(({ id }) => id),
                }),
              )
            : null;
        return {
          selected,
          reference,
          viewer: decoded.success.data.currentUser?.username ?? null,
          comments,
          events: activity.items,
          historyNextCursor: activity.nextCursor,
          nextCursor,
        };
      });

    const epicDetail = (input: IssueTarget): Effect.Effect<TrackerIssueDetail, IssueTrackerError> =>
      epic(input, "getIssue").pipe(
        Effect.map(
          ({ selected, reference, viewer, comments, events, nextCursor, historyNextCursor }) => {
            const labels = selected.widgets.find(
              (widget) => widget.__typename === "WorkItemWidgetLabels",
            )?.labels;
            const assignees = selected.widgets.find(
              (widget) => widget.__typename === "WorkItemWidgetAssignees",
            )?.assignees;
            return {
              ...reference,
              capabilities: EPIC_CAPABILITIES,
              viewerPermissions: EPIC_PERMISSIONS,
              body: selected.description ?? "",
              bodyEditable: false,
              author: epicActor(selected.author),
              viewer,
              createdAt: selected.createdAt,
              updatedAt: selected.updatedAt,
              closedAt: selected.closedAt,
              assignees: assignees?.nodes.flatMap((actor) => epicActor(actor) ?? []) ?? [],
              labels:
                labels?.nodes.map((label) => ({ name: label.title, color: label.color })) ?? [],
              labelsTruncated: labels?.pageInfo.hasNextPage ?? false,
              commentCount: null,
              comments,
              commentsCursor: nextCursor,
              events,
              linkedPullRequests: [],
              historyTruncated: historyNextCursor !== null,
            };
          },
        ),
      );

    const writableParent = (parent: GitLabWorkItem, operation: string) =>
      parent.workItemType.name === "Issue" &&
      !parent.archived &&
      parent.userPermissions.adminParentLink
        ? Effect.void
        : Effect.fail(
            refused(
              operation,
              "The parent must be an Issue that you can link in an active project.",
            ),
          );

    const linkParent = (
      input: IssueTarget,
      child: GitLabWorkItemWithHierarchy,
      parent: GitLabWorkItem | null,
      operation: string,
    ) =>
      Effect.gen(function* () {
        const widget = yield* hierarchyWidget(child, operation);
        if (
          child.workItemType.name !== "Task" ||
          child.archived ||
          !child.userPermissions.adminParentLink
        )
          return yield* refused(
            operation,
            "Only a Task with parent-link permission in an active project can change parent.",
          );
        if (widget.parent !== null && !projectParent(child, widget.parent))
          return yield* refused(operation, "The existing parent is not an Issue in this project.");
        if (parent !== null) {
          yield* writableParent(parent, operation);
          if (parent.id === child.id || (parent.confidential && !child.confidential))
            return yield* refused(
              operation,
              "The parent and Task have incompatible hierarchy or confidentiality.",
            );
        } else if (
          widget.parent !== null &&
          (!widget.parent.userPermissions.adminParentLink || widget.parent.archived)
        ) {
          return yield* refused(operation, "You cannot remove this parent link.");
        }
        if (parent === null && widget.parent === null) return;
        const raw = yield* nativeGraphql(input, operation, WORK_ITEM_PARENT_MUTATION, {
          input: { id: child.id, hierarchyWidget: { parentId: parent?.id ?? null } },
        });
        const decoded = decodeWorkItemMutationJson(raw);
        if (Result.isFailure(decoded)) return yield* unreadable(operation, decoded.failure);
        const result = decoded.success.data.workItemUpdate;
        if (result.errors.length > 0) return yield* refused(operation, result.errors.join("; "));
        if (result.workItem === null) return yield* unreadable(operation, "missing-work-item");
        yield* projectWorkItem(input, result.workItem, operation);
        const updated = yield* hierarchyWidget(result.workItem, operation);
        if (
          result.workItem.id !== child.id ||
          (updated.parent?.id ?? null) !== (parent?.id ?? null)
        )
          return yield* refused(operation, "GitLab did not save the requested parent link.");
      });

    /** The signed-in account; an answer naming nobody is a failure, since every comparison needs a login. */
    const viewer = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly operation: string;
    }): Effect.Effect<string, IssueTrackerError> =>
      read({
        cwd: input.cwd,
        host: input.host,
        operation: input.operation,
        path: "user",
        decode: decodeViewerJson,
      }).pipe(
        Effect.filterOrFail(
          (login) => login !== null,
          () => refused(input.operation, "GitLab returned no username for the signed-in account."),
        ),
      );

    /** The issue as REST addresses it, or a not-found for a key that names no iid. */
    const issuePath = (
      input: { readonly scope: string; readonly key: string },
      operation: string,
    ): Effect.Effect<{ readonly number: number; readonly path: string }, IssueTrackerError> => {
      if (groupPath(input.scope) !== null)
        return Effect.fail(refused(operation, "Group epics are read-only."));
      const number = parseNumber(input.key);
      return number === null
        ? Effect.fail(notFound(operation))
        : Effect.succeed({ number, path: `projects/${projectPath(input.scope)}/issues/${number}` });
    };

    /** GitLab names assignees by numeric id, which is what the candidates carry as `id`. */
    const assigneeIds = (
      operation: string,
      assignees: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<number>, IssueTrackerError> => {
      const ids = assignees.map((id) => (/^[1-9]\d*$/.test(id) ? Number(id) : null));
      return ids.every((id) => id !== null)
        ? Effect.succeed(ids)
        : Effect.fail(refused(operation, "GitLab assignees are named by their user id."));
    };

    const paged = (path: string, page: number) =>
      `${path}?${query([
        ["per_page", String(PAGE_SIZE)],
        ["page", String(page)],
      ])}`;

    const awards = (
      input: IssueTarget & {
        readonly number: number;
        readonly operation: string;
        readonly cursor?: string;
        readonly order?: IssueListOrder;
      },
    ) =>
      Effect.gen(function* () {
        const position = yield* cursorPosition(input, "comments", input.operation);
        const decodedPosition =
          position === undefined ? undefined : decodeJsonResult(CommentPosition)(position);
        if (decodedPosition !== undefined && Result.isFailure(decodedPosition))
          return yield* refused(input.operation, "The comments cursor is invalid.");
        const previous =
          decodedPosition !== undefined && Result.isSuccess(decodedPosition)
            ? decodedPosition.success
            : undefined;
        if (
          previous !== undefined &&
          (previous.ids.length === 0 || new Set(previous.ids).size !== previous.ids.length)
        )
          return yield* refused(
            input.operation,
            "The comments cursor has contradictory note boundaries.",
          );
        const order = input.order ?? "desc";
        const page = yield* read({
          ...input,
          path: "graphql",
          method: "POST",
          body: {
            query:
              order === "desc"
                ? ISSUE_AWARD_EMOJI_GRAPHQL_QUERY
                : ISSUE_AWARD_EMOJI_GRAPHQL_QUERY.replace(
                    `notes(last: ${PAGE_SIZE}, before: $cursor)`,
                    `notes(first: ${PAGE_SIZE}, after: $cursor)`,
                  ).replace(
                    "hasPreviousPage startCursor",
                    "hasPreviousPage: hasNextPage startCursor: endCursor",
                  ),
            variables: {
              fullPath: input.scope.trim(),
              iid: String(input.number),
              ...(previous === undefined ? {} : { cursor: previous.native }),
            },
          },
          decode: (raw) => decodeIssueAwardPageJson(raw, order),
        });
        if (
          page.nativeIds.length > PAGE_SIZE ||
          new Set(page.nativeIds).size !== page.nativeIds.length ||
          page.nativeIds.some((id) => previous?.ids.includes(id)) ||
          (page.nextCursor !== null &&
            (!page.nextCursor ||
              page.nextCursor.length > 4096 ||
              page.nativeIds.length === 0 ||
              page.nextCursor === previous?.native))
        )
          return yield* refused(
            input.operation,
            "GitLab returned a repeated or incomplete comments page.",
          );
        return {
          ...page,
          nextCursor:
            page.nextCursor === null
              ? null
              : yield* cursorFor(
                  input,
                  "comments",
                  encodeBody({ native: page.nextCursor, ids: page.nativeIds }),
                ),
        };
      });

    const historyEvent = (
      phase: "notes" | "labels" | "states",
      row: typeof HistoryRow.Type,
    ): IssueEvent | null => {
      if (phase === "notes" && !row.system) return null;
      const body = row.body?.trim() ?? "";
      const event = phase === "notes" ? toSystemEvent(body) : null;
      if (
        phase === "notes" &&
        (event?.kind === "closed" ||
          event?.kind === "reopened" ||
          /^(?:added|removed) (?:\S*~\d+|\d+ deleted).* labels?$/.test(body))
      )
        return null;
      if (phase === "labels" && row.action !== "add" && row.action !== "remove") return null;
      if (phase === "states" && row.state !== "closed" && row.state !== "reopened") return null;
      const user = row.author ?? row.user;
      const url = nativeEventUrl(row.url);
      return {
        id: `${phase}:${row.id}`,
        kind:
          phase === "labels"
            ? row.action === "add"
              ? "labeled"
              : "unlabeled"
            : phase === "states"
              ? row.state === "closed"
                ? "closed"
                : "reopened"
              : (event?.kind ?? "updated"),
        actor:
          user == null
            ? null
            : {
                id: user.id === undefined ? undefined : String(user.id),
                login: user.username,
                name: user.name ?? null,
                avatarUrl: user.avatar_url ?? null,
              },
        createdAt: row.created_at,
        detail:
          event === null
            ? phase === "states"
              ? null
              : (row.label?.name ?? body) || null
            : event.detail,
        ...(url === undefined ? {} : { url }),
      };
    };
    const issueHistory = (
      input: IssueTarget & IssuePageInput & { readonly order?: IssueListOrder },
    ) =>
      Effect.gen(function* () {
        const position = yield* cursorPosition(input, "history", "getHistory");
        const decoded =
          position === undefined ? undefined : decodeJsonResult(HistoryPosition)(position);
        if (decoded !== undefined && Result.isFailure(decoded))
          return yield* refused("getHistory", "The history cursor has an invalid page or offset.");
        const saved =
          decoded !== undefined && Result.isSuccess(decoded) ? decoded.success : undefined;
        if (
          saved !== undefined &&
          (new Set(saved.ids).size !== saved.ids.length ||
            new Set(saved.previousIds).size !== saved.previousIds.length ||
            (saved.ids.length === 0 && saved.offset !== 0) ||
            (saved.page === 1 && (saved.previousIds.length !== 0 || saved.previousTime !== null)) ||
            (saved.page > 1 &&
              (saved.previousIds.length === 0 ||
                saved.previousTime === null ||
                !Number.isFinite(Date.parse(saved.previousTime)))))
        )
          return yield* refused(
            "getHistory",
            "The history cursor has contradictory page boundaries.",
          );
        const limit = Math.min(input.limit ?? 50, PAGE_SIZE);
        if (!Number.isSafeInteger(limit) || limit < 1)
          return yield* refused("getHistory", "The history page size is invalid.");
        const { path } = yield* issuePath(input, "getHistory");
        const order = input.order ?? "desc";
        const compare = (left: IssueEvent, right: IssueEvent) =>
          (order === "desc" ? -1 : 1) *
          (Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.id.localeCompare(right.id));
        const notesPage = saved?.page ?? 1;
        const load = (endpoint: string, page: number) =>
          api({
            ...input,
            operation: "getHistory",
            path: `${path}/${endpoint}?per_page=${PAGE_SIZE}&page=${page}${endpoint === "notes" ? `&sort=${order}&order_by=created_at` : ""}`,
            includeHeaders: true,
          }).pipe(
            Effect.flatMap((raw) =>
              Effect.gen(function* () {
                const headers = new Map<string, string>();
                let body = raw;
                if (raw.startsWith("HTTP/")) {
                  const split = /\r?\n\r?\n/.exec(raw);
                  if (split === null)
                    return yield* unreadable("getHistory", "missing-response-body");
                  for (const line of raw.slice(0, split.index).split(/\r?\n/).slice(1)) {
                    const colon = line.indexOf(":");
                    if (colon < 1)
                      return yield* unreadable("getHistory", "invalid-pagination-header");
                    const key = line.slice(0, colon).toLowerCase();
                    if (
                      headers.has(key) &&
                      ["x-next-page", "x-total-pages", "x-total", "link"].includes(key)
                    )
                      return yield* unreadable("getHistory", "duplicate-pagination-header");
                    headers.set(key, line.slice(colon + 1).trim());
                  }
                  body = raw.slice(split.index + split[0].length);
                }
                const decodedRows = decodeJsonResult(Schema.Array(HistoryRow))(body);
                if (Result.isFailure(decodedRows))
                  return yield* unreadable("getHistory", decodedRows.failure);
                const native = decodedRows.success;
                const next = headers.get("x-next-page");
                const totalPages = headers.get("x-total-pages");
                const total = headers.get("x-total");
                if (
                  [totalPages, total].some(
                    (value) => value !== undefined && !/^(?:0|[1-9]\d{0,8})$/.test(value),
                  ) ||
                  (next !== undefined &&
                    next !== "" &&
                    (!/^[1-9]\d{0,6}$/.test(next) || Number(next) !== page + 1)) ||
                  (totalPages !== undefined && Number(totalPages) > 0 && page > Number(totalPages))
                )
                  return yield* refused(
                    "getHistory",
                    "GitLab returned inconsistent history pagination.",
                  );
                const linkMore = /<[^>]+>;\s*rel="?next"?/.test(headers.get("link") ?? "");
                const more =
                  next !== undefined
                    ? next !== ""
                    : totalPages !== undefined
                      ? page < Number(totalPages)
                      : total !== undefined
                        ? page * PAGE_SIZE < Number(total)
                        : linkMore || native.length >= PAGE_SIZE;
                if (
                  (linkMore && !more) ||
                  (totalPages !== undefined && more !== page < Number(totalPages)) ||
                  (totalPages === "0" && native.length !== 0) ||
                  (total !== undefined && more !== page * PAGE_SIZE < Number(total)) ||
                  (total !== undefined &&
                    totalPages !== undefined &&
                    Number(totalPages) !== Math.ceil(Number(total) / PAGE_SIZE) &&
                    !(total === "0" && totalPages === "1")) ||
                  (total !== undefined && Number(total) < native.length) ||
                  native.length > PAGE_SIZE
                )
                  return yield* refused(
                    "getHistory",
                    "GitLab returned contradictory history pagination.",
                  );
                if (native.length === 0 && more)
                  return yield* refused(
                    "getHistory",
                    "GitLab returned an empty continuing history page.",
                  );
                return {
                  rows: native,
                  more,
                  complete:
                    !more &&
                    (next !== undefined ||
                      totalPages !== undefined ||
                      total !== undefined ||
                      headers.has("link")),
                };
              }),
            ),
          );
        const [notePage, labelPage, statePage] = yield* Effect.all(
          [
            load("notes", notesPage),
            load("resource_label_events", 1),
            load("resource_state_events", 1),
          ],
          { concurrency: 3 },
        );
        const rows = notePage.rows;
        const labels = labelPage.rows;
        const states = statePage.rows;
        const truncated = !labelPage.complete || !statePage.complete;
        if (
          [labels, states].some(
            (native) =>
              new Set(native.map(({ id }) => id)).size !== native.length ||
              native.some(({ created_at }) => !Number.isFinite(Date.parse(created_at))),
          )
        )
          return yield* refused(
            "getHistory",
            "GitLab returned an inconsistent resource history page.",
          );
        const resources = [
          ...labels.flatMap((row) => historyEvent("labels", row) ?? []),
          ...states.flatMap((row) => historyEvent("states", row) ?? []),
        ].sort(compare);
        const resourceIds = resources.map(({ id }) => id);
        const resourceFingerprint = Buffer.from(
          yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", Buffer.from(encodeBody(resourceIds))),
          ),
        ).toString("hex");
        const previousIds = saved?.previousIds ?? [];
        const previousTime = saved?.previousTime ?? null;
        const moreNotes = notePage.more;
        if (
          saved !== undefined &&
          (saved.resources !== resourceFingerprint ||
            (saved.ids.length !== 0 &&
              encodeBody(saved.ids) !== encodeBody(rows.map(({ id }) => id))) ||
            saved.offset > rows.length ||
            saved.resourceOffset > resources.length)
        )
          return yield* refused("getHistory", "GitLab history changed. Refresh this issue.");
        if (
          rows.length > PAGE_SIZE ||
          new Set(rows.map(({ id }) => id)).size !== rows.length ||
          rows.some(
            (row, index) =>
              !Number.isFinite(Date.parse(row.created_at)) ||
              previousIds.includes(row.id) ||
              (index > 0 &&
                (order === "desc"
                  ? Date.parse(row.created_at) > Date.parse(rows[index - 1]!.created_at)
                  : Date.parse(row.created_at) < Date.parse(rows[index - 1]!.created_at))) ||
              (previousTime !== null &&
                (order === "desc"
                  ? Date.parse(row.created_at) > Date.parse(previousTime)
                  : Date.parse(row.created_at) < Date.parse(previousTime))),
          )
        )
          return yield* refused(
            "getHistory",
            "GitLab returned a repeated or unordered history page.",
          );
        const items: IssueEvent[] = [];
        let offset = saved?.offset ?? 0;
        let resourceOffset = saved?.resourceOffset ?? 0;
        while (items.length < limit) {
          while (offset < rows.length && historyEvent("notes", rows[offset]!) === null) offset++;
          const note = rows[offset] === undefined ? null : historyEvent("notes", rows[offset]!);
          if (note === null && moreNotes) break;
          const resource = resources[resourceOffset];
          if (note === null && resource === undefined) break;
          if (resource !== undefined && (note === null || compare(resource, note) < 0)) {
            items.push(resource);
            resourceOffset++;
          } else if (note !== null) {
            items.push(note);
            offset++;
          }
        }
        const exhausted = offset === rows.length;
        const nextCursor =
          exhausted && !moreNotes && resourceOffset === resources.length
            ? null
            : yield* cursorFor(
                input,
                "history",
                encodeBody({
                  page: exhausted && moreNotes ? notesPage + 1 : notesPage,
                  offset: exhausted && moreNotes ? 0 : offset,
                  resourceOffset,
                  ids: exhausted && moreNotes ? [] : rows.map(({ id }) => id),
                  resources: resourceFingerprint,
                  previousIds: exhausted && moreNotes ? rows.map(({ id }) => id) : previousIds,
                  previousTime: exhausted && moreNotes ? rows.at(-1)!.created_at : previousTime,
                }),
              );
        return { items, nextCursor, ...(truncated ? { truncated: true } : {}) };
      });

    const linked = (input: {
      readonly cwd: string;
      readonly host: string;
      readonly path: string;
      readonly endpoint: "closed_by" | "related_merge_requests";
    }) =>
      read({
        cwd: input.cwd,
        host: input.host,
        operation: "getIssue",
        path: paged(`${input.path}/${input.endpoint}`, 1),
        decode: (raw) => decodeLinkedMergeRequestsJson(raw, input.endpoint === "closed_by"),
      });

    const candidatePage = <A>(
      input: IssueScopeTarget & IssuePageInput,
      operation: string,
      endpoint: string,
      decode: (raw: string) => Result.Result<ReadonlyArray<A>, unknown>,
    ) => {
      if (groupPath(input.scope) !== null)
        return Effect.fail(refused(operation, "Group epics are read-only."));
      const page = parsePage(input.cursor);
      if (page === null)
        return Effect.fail(refused(operation, "The cursor was not one GitLab handed out."));
      const limit = Math.min(input.limit ?? 50, PAGE_SIZE);
      return api({
        ...input,
        operation,
        path: `projects/${projectPath(input.scope)}/${endpoint}?per_page=${limit}&page=${page}`,
      }).pipe(
        Effect.flatMap((raw) => {
          const rows = decodeJsonResult(Schema.Array(Schema.Unknown))(raw);
          const items = decode(raw);
          return Result.isSuccess(rows) && Result.isSuccess(items)
            ? Effect.succeed({
                items: items.success,
                nextCursor: rows.success.length >= limit ? String(page + 1) : null,
              })
            : Effect.fail(unreadable(operation, raw));
        }),
      );
    };

    const template =
      (input: { readonly cwd: string; readonly host: string; readonly scope: string }) =>
      (entry: GitLabTemplateEntry) =>
        read({
          cwd: input.cwd,
          host: input.host,
          operation: "listTemplates",
          path: `projects/${projectPath(input.scope)}/templates/issues/${encodeURIComponent(entry.key)}`,
          decode: (raw) => decodeTemplateJson(entry, raw),
        });

    return {
      kind: KIND,
      capabilities: CAPABILITIES,

      getHierarchy: (input) =>
        Effect.gen(function* () {
          const first = Math.min(input.limit ?? 50, PAGE_SIZE);
          if (
            !Number.isSafeInteger(first) ||
            first < 1 ||
            (input.cursor !== undefined &&
              (input.cursor.length === 0 || input.cursor.length > 4096))
          )
            return yield* refused("getHierarchy", "The hierarchy page is invalid.");
          const selected = yield* workItem(input, "getHierarchy", {
            first,
            ...(input.cursor === undefined ? {} : { after: input.cursor }),
          });
          const widget = yield* hierarchyWidget(selected, "getHierarchy");
          const children = widget.children;
          if (
            children === undefined ||
            children.nodes.length > first ||
            (children.pageInfo.hasNextPage &&
              (!children.pageInfo.endCursor ||
                children.pageInfo.endCursor.length > 4096 ||
                children.pageInfo.endCursor === input.cursor))
          )
            return yield* refused(
              "getHierarchy",
              "GitLab returned an inconsistent hierarchy page.",
            );
          if (
            children.nodes.some(
              (child) =>
                child.id === selected.id ||
                (!projectParent(child, selected) && !epicParent(child, selected)),
            ) ||
            new Set(children.nodes.map((child) => child.id)).size !== children.nodes.length ||
            new Set(
              children.nodes.map(
                (child) =>
                  `${child.project === null ? "group:" : ""}${child.namespace.fullPath}:${child.iid}`,
              ),
            ).size !== children.nodes.length ||
            (widget.parent !== null &&
              (widget.parent.id === selected.id ||
                (!projectParent(selected, widget.parent) && !epicParent(selected, widget.parent))))
          )
            return yield* refused(
              "getHierarchy",
              "GitLab returned an unsupported project hierarchy.",
            );
          return {
            parent:
              widget.parent === null ? null : yield* relation(input, widget.parent, "getHierarchy"),
            children: {
              items: yield* Effect.forEach(children.nodes, (child) =>
                relation(input, child, "getHierarchy"),
              ),
              nextCursor: children.pageInfo.hasNextPage ? children.pageInfo.endCursor : null,
            },
          };
        }),

      setParent: (input) =>
        Effect.gen(function* () {
          if (groupPath(input.scope) !== null)
            return yield* refused("setParent", "Group epics are read-only.");
          if (input.parentKey === input.key)
            return yield* refused("setParent", "An issue cannot be its own parent.");
          const child = yield* workItem(input, "setParent");
          const parent =
            input.parentKey === null
              ? null
              : yield* workItem({ ...input, key: input.parentKey }, "setParent");
          yield* linkParent(input, child, parent, "setParent");
        }),

      getViewer: (input) => viewer({ cwd: input.cwd, host: input.host, operation: "getViewer" }),

      listIssues: (input) => {
        if (groupPath(input.scope) !== null)
          return Effect.fail(
            refused("listIssues", "Group epics cannot be listed as project issues."),
          );
        if (input.involvement === "mentioned") {
          return Effect.fail(refused("listIssues", "GitLab cannot filter issues by mentions."));
        }
        if (input.sort === "comments") {
          return Effect.fail(refused("listIssues", "GitLab cannot sort issues by comments."));
        }
        const page = parsePage(input.cursor);
        if (page === null) {
          return Effect.fail(refused("listIssues", "The cursor was not one GitLab handed out."));
        }
        const categories = input.stateCategories;
        const open =
          categories === undefined ? input.state !== "closed" : categories.includes("unstarted");
        const closed =
          categories === undefined ? input.state !== "open" : categories.includes("completed");
        if (!open && !closed) return Effect.succeed({ items: [], nextCursor: null });
        const state = open && closed ? "all" : open ? "opened" : "closed";
        const perPage = Math.min(Math.max(input.limit, 1), PAGE_SIZE);
        const text = input.query?.trim() ?? "";
        return read({
          cwd: input.cwd,
          host: input.host,
          operation: "listIssues",
          path: `projects/${projectPath(input.scope)}/issues?${query([
            ["state", state],
            ["scope", "all"],
            ["with_labels_details", "true"],
            ...involvementParams(input),
            // GitLab's own `search` matches title and description, URL-encoded like every other
            // value here, so no text in it can become a parameter of its own.
            ...(text.length === 0 ? [] : [["search", text] as const]),
            ["order_by", `${input.sort ?? "updated"}_at`],
            ["sort", input.order ?? "desc"],
            ["per_page", String(perPage)],
            ["page", String(page)],
          ])}`,
          decode: decodeIssueListJson,
        }).pipe(
          Effect.map((list) => ({
            items: list.items,
            nextCursor: list.rawCount < perPage ? null : String(page + 1),
          })),
        );
      },

      getIssue: (input) => {
        if (groupPath(input.scope) !== null) return epicDetail(input);
        return issuePath(input, "getIssue").pipe(
          Effect.flatMap(({ number, path }) =>
            Effect.all(
              [
                read({
                  cwd: input.cwd,
                  host: input.host,
                  operation: "getIssue",
                  path,
                  decode: decodeIssueDetailJson,
                }),
                read({
                  cwd: input.cwd,
                  host: input.host,
                  operation: "getIssue",
                  path: paged(`${path}/award_emoji`, 1),
                  decode: decodeIssueAwardsJson,
                }),
                issueHistory(input),
                linked({ cwd: input.cwd, host: input.host, path, endpoint: "closed_by" }),
                linked({
                  cwd: input.cwd,
                  host: input.host,
                  path,
                  endpoint: "related_merge_requests",
                }),
                awards({
                  ...input,
                  number,
                  operation: "getIssue",
                }),
              ],
              { concurrency: 4 },
            ),
          ),
          Effect.map(([issue, issueAwards, history, closing, related, awardPage]) => {
            const closingKeys = new Set(closing.map((link) => `${link.repository}!${link.number}`));
            const eventUrls = new Map(
              awardPage.eventUrls.map(({ id, url }) => [`notes:${id}`, url]),
            );
            return {
              ...issue,
              capabilities: {
                ...CAPABILITIES,
                historyOrders: history.truncated === true ? [] : CAPABILITIES.historyOrders,
                createSubIssue: issue.itemType?.toLowerCase() === "issue",
                updateParent: issue.itemType?.toLowerCase() === "task",
              },
              viewer: awardPage.viewer,
              viewerPermissions: awardPage.viewerPermissions,
              reactions: toReactions({ nodes: issueAwards }, awardPage.viewer),
              reactionsTruncated: issueAwards.length >= PAGE_SIZE,
              comments: awardPage.comments,
              commentsCursor: awardPage.nextCursor,
              historyTruncated: history.truncated === true || history.nextCursor !== null,
              events: history.items.map((event) => {
                const url = event.url ?? eventUrls.get(event.id);
                return url === undefined ? event : { ...event, url };
              }),
              // A merge request that closes the issue outranks its sighting as a mere mention.
              linkedPullRequests: [
                ...closing,
                ...related.filter((link) => !closingKeys.has(`${link.repository}!${link.number}`)),
              ],
            };
          }),
          Effect.filterOrElse(
            (detail) => detail.itemType?.toLowerCase() !== "task",
            (detail) =>
              parentPermission(input, "getIssue").pipe(
                Effect.map((updateParent) => ({
                  ...detail,
                  viewerPermissions: { ...detail.viewerPermissions, updateParent },
                })),
              ),
          ),
        );
      },

      getComments: (input) => {
        if (groupPath(input.scope) !== null)
          return epic(input, "getComments").pipe(
            Effect.map(({ comments, nextCursor }) => ({ comments, nextCursor })),
          );
        return issuePath(input, "getComments").pipe(
          Effect.flatMap(({ number }) =>
            awards({
              ...input,
              number,
              operation: "getComments",
            }),
          ),
          Effect.map((page) => ({
            comments: page.comments,
            nextCursor: page.nextCursor,
          })),
        );
      },

      getViewerPermissions: (input) => {
        if (groupPath(input.scope) !== null) return Effect.succeed(EPIC_PERMISSIONS);
        return issuePath(input, "getViewerPermissions").pipe(
          Effect.flatMap(({ number }) =>
            read({
              cwd: input.cwd,
              host: input.host,
              operation: "getViewerPermissions",
              path: "graphql",
              method: "POST",
              body: {
                query: ISSUE_VIEWER_PERMISSIONS_GRAPHQL_QUERY,
                variables: { fullPath: input.scope.trim(), iid: String(number) },
              },
              decode: decodeIssueViewerPermissionsJson,
            }).pipe(
              Effect.flatMap(({ itemType, ...permissions }) =>
                itemType?.toLowerCase() === "task"
                  ? parentPermission(input, "getViewerPermissions").pipe(
                      Effect.map((updateParent) => ({ ...permissions, updateParent })),
                    )
                  : Effect.succeed(permissions),
              ),
            ),
          ),
        );
      },

      editComment: (input) =>
        issuePath(input, "editComment").pipe(
          Effect.flatMap(({ path }) => {
            if (parseNumber(input.commentId) === null)
              return Effect.fail(refused("editComment", "The comment id names no GitLab note."));
            return read({
              ...input,
              operation: "editComment",
              path: `${path}/notes/${input.commentId}`,
              decode: decodeJsonResult(
                Schema.Struct({
                  id: Schema.Int,
                  noteable_iid: Schema.Int,
                  noteable_type: Schema.String,
                  system: Schema.Boolean,
                }),
              ),
            }).pipe(
              Effect.filterOrFail(
                (note) =>
                  String(note.id) === input.commentId &&
                  String(note.noteable_iid) === input.key &&
                  note.noteable_type === "Issue" &&
                  !note.system,
                () => refused("editComment", "The comment does not belong to this issue."),
              ),
              Effect.flatMap(() =>
                read({
                  ...input,
                  operation: "editComment",
                  path: "graphql",
                  method: "POST",
                  body: {
                    query: "query($id:NoteID!) { note(id:$id) { userPermissions { adminNote } } }",
                    variables: { id: `gid://gitlab/Note/${input.commentId}` },
                  },
                  decode: decodeJsonResult(EditCommentPermissions),
                }),
              ),
              Effect.filterOrFail(
                (result) => result.data.note?.userPermissions.adminNote === true,
                () => refused("editComment", "You cannot edit this comment."),
              ),
              Effect.flatMap(() =>
                write({
                  ...input,
                  operation: "editComment",
                  path: `${path}/notes/${input.commentId}`,
                  method: "PUT",
                  body: { body: input.body },
                }),
              ),
            );
          }),
        ),

      getHistory: (input) =>
        groupPath(input.scope) !== null ? epicHistory(input) : issueHistory(input),

      getLinkedPullRequests: (input) =>
        Effect.gen(function* () {
          const match = /^(closing|related):([1-9]\d{0,6})$/.exec(input.cursor ?? "closing:1");
          if (match === null)
            return yield* refused(
              "getLinkedPullRequests",
              "The linked merge request cursor was not one GitLab handed out.",
            );
          const closing = match[1] === "closing";
          const page = Number(match[2]);
          const limit = Math.min(input.limit ?? 50, PAGE_SIZE);
          const { path } = yield* issuePath(input, "getLinkedPullRequests");
          const raw = yield* api({
            ...input,
            operation: "getLinkedPullRequests",
            path: `${path}/${closing ? "closed_by" : "related_merge_requests"}?per_page=${limit}&page=${page}`,
          });
          const rows = decodeJsonResult(Schema.Array(Schema.Unknown))(raw);
          const items = decodeLinkedMergeRequestsJson(raw, closing);
          if (!Result.isSuccess(rows) || !Result.isSuccess(items))
            return yield* unreadable("getLinkedPullRequests", raw);
          return {
            items: items.success,
            nextCursor:
              rows.success.length >= limit
                ? `${closing ? "closing" : "related"}:${page + 1}`
                : closing
                  ? "related:1"
                  : null,
          };
        }),

      listLabelCandidates: (input) =>
        candidatePage(input, "listLabelCandidates", "labels", decodeProjectLabelsJson),
      listAssigneeCandidates: (input) =>
        candidatePage(input, "listAssigneeCandidates", "users", decodeProjectMembersJson),

      create: (input) =>
        Effect.gen(function* () {
          if (groupPath(input.scope) !== null)
            return yield* refused("create", "Group epics are read-only.");
          const assignee_ids = yield* assigneeIds("create", input.assignees);
          const parent =
            input.parentKey === undefined
              ? null
              : yield* workItem({ ...input, key: input.parentKey }, "create");
          if (parent !== null) {
            yield* hierarchyWidget(parent, "create");
            yield* writableParent(parent, "create");
          }
          const issue = yield* read({
            cwd: input.cwd,
            host: input.host,
            operation: "create",
            path: `projects/${projectPath(input.scope)}/issues`,
            method: "POST",
            body: {
              title: input.title,
              description: input.body,
              labels: input.labels.join(","),
              assignee_ids,
              ...(parent === null ? {} : { issue_type: "task", confidential: parent.confidential }),
            },
            decode: decodeCreatedIssueJson,
          });
          const created = {
            key: String(issue.number),
            displayKey: `#${issue.number}`,
            url: issue.url,
            warnings: (
              [
                ["labels", input.labels, issue.labels],
                ["assignees", input.assignees, issue.assigneeIds],
              ] as const
            ).flatMap(([field, requested, saved]) =>
              requested.some((value) => !saved.includes(value))
                ? [`The issue was created, but GitLab did not save the requested ${field}.`]
                : [],
            ),
          };
          if (parent === null) return created;
          const linked = yield* Effect.gen(function* () {
            if (issue.itemType !== "task")
              return yield* refused("create", "GitLab did not create a native Task.");
            const childInput = { ...input, key: created.key };
            const child = yield* workItem(childInput, "create");
            yield* linkParent(childInput, child, parent, "create");
          }).pipe(Effect.result);
          return {
            ...created,
            parentLinked: Result.isSuccess(linked),
            warnings: Result.isSuccess(linked)
              ? created.warnings
              : [
                  ...created.warnings,
                  `The item was created, but its parent link could not be confirmed. ${linked.failure.detail}`,
                ],
          };
        }),

      comment: (input) =>
        issuePath(input, "comment").pipe(
          Effect.flatMap(({ path }) =>
            write({
              cwd: input.cwd,
              host: input.host,
              operation: "comment",
              path: `${path}/notes`,
              method: "POST",
              body: { body: input.body },
            }),
          ),
        ),

      update: (input) =>
        Effect.all([
          issuePath(input, "update"),
          input.assignees === undefined ? Effect.void : assigneeIds("update", input.assignees),
        ]).pipe(
          Effect.flatMap(([{ path }, assignee_ids]) =>
            api({
              cwd: input.cwd,
              host: input.host,
              operation: "update",
              path,
              method: "PUT",
              body: {
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.body === undefined ? {} : { description: input.body }),
                ...(input.labels === undefined ? {} : { labels: input.labels.join(",") }),
                ...(assignee_ids === undefined
                  ? {}
                  : { assignee_ids: assignee_ids.length === 0 ? [0] : assignee_ids }),
              },
            }).pipe(
              Effect.flatMap((raw) => {
                if (input.labels === undefined && assignee_ids === undefined) return Effect.void;
                const decoded = decodeIssueUpdatedMetadataJson(raw);
                const actual = Result.isSuccess(decoded) ? decoded.success : undefined;
                const fields = [
                  ["labels", input.labels, actual?.labels],
                  [
                    "assignees",
                    assignee_ids?.map(String),
                    actual?.assignees?.map((actor) => String(actor.id)),
                  ],
                ] as const;
                const skipped = fields.flatMap(([name, expected, saved]) => {
                  if (expected === undefined) return [];
                  if (saved === undefined) return [name];
                  const wanted = new Set(expected);
                  const received = new Set(saved);
                  return wanted.size === received.size &&
                    [...wanted].every((value) => received.has(value))
                    ? []
                    : [name];
                });
                return skipped.length === 0
                  ? Effect.void
                  : Effect.fail(
                      refused(
                        "update",
                        `GitLab did not save the requested ${skipped.join(" and ")}.`,
                      ),
                    );
              }),
            ),
          ),
        ),

      setState: (input) =>
        issuePath(input, "setState").pipe(
          Effect.flatMap(({ path }) => {
            if (input.state !== "open" && input.state !== "closed")
              return Effect.fail(
                refused("setState", "GitLab supports only open and closed issue states."),
              );
            return write({
              cwd: input.cwd,
              host: input.host,
              operation: "setState",
              path,
              method: "PUT",
              body: { state_event: input.state === "closed" ? "close" : "reopen" },
            });
          }),
        ),

      setReaction: (input) =>
        issuePath(input, "setReaction").pipe(
          Effect.flatMap(({ path }) => {
            if (input.subjectId !== undefined && !/^[1-9]\d*$/.test(input.subjectId)) {
              return Effect.fail(refused("setReaction", "The comment id names no GitLab note."));
            }
            const subject =
              input.subjectId === undefined
                ? `${path}/award_emoji`
                : `${path}/notes/${input.subjectId}/award_emoji`;
            if (input.reacted) {
              return write({
                cwd: input.cwd,
                host: input.host,
                operation: "setReaction",
                path: `${subject}?${query([["name", gitLabAwardName(input.content)]])}`,
                method: "POST",
              });
            }
            // GitLab deletes an award by its id and takes no emoji name there, so the reader's own
            // award of that name is looked up first. Nothing to delete is success.
            return viewer({ cwd: input.cwd, host: input.host, operation: "setReaction" }).pipe(
              Effect.flatMap((login) =>
                Effect.gen(function* () {
                  for (let page = 1; page <= 10; page++) {
                    const awards = yield* read({
                      cwd: input.cwd,
                      host: input.host,
                      operation: "setReaction",
                      path: paged(subject, page),
                      decode: (raw) =>
                        decodeIssueOwnAwardPageJson(raw, { content: input.content, viewer: login }),
                    });
                    if (awards.id !== null || awards.rawCount < PAGE_SIZE) return awards.id;
                  }
                  return yield* refused(
                    "setReaction",
                    "GitLab returned more awards than could be searched. The reaction was not removed.",
                  );
                }),
              ),
              Effect.flatMap((own) =>
                own === null
                  ? Effect.void
                  : write({
                      cwd: input.cwd,
                      host: input.host,
                      operation: "setReaction",
                      path: `${subject}/${own}`,
                      method: "DELETE",
                    }),
              ),
            );
          }),
        ),

      listTemplates: (input) => {
        if (groupPath(input.scope) !== null)
          return Effect.fail(refused("listTemplates", "Group epics are read-only."));
        if (input.metadataOnly && input.templateKey !== undefined)
          return Effect.fail(
            refused("listTemplates", "Choose a template catalog or one template body."),
          );
        if (input.templateKey !== undefined)
          return template(input)({ key: input.templateKey, name: input.templateKey }).pipe(
            Effect.map((loaded) => ({ templates: [loaded], blankIssuesEnabled: true })),
          );
        return read({
          cwd: input.cwd,
          host: input.host,
          operation: "listTemplates",
          path: `projects/${projectPath(input.scope)}/templates/issues`,
          decode: (raw) => decodeTemplateEntriesJson(raw, input.metadataOnly === true),
        }).pipe(
          Effect.flatMap((entries) => {
            if (!input.metadataOnly)
              return Effect.forEach(entries.slice(0, TEMPLATE_LIMIT), template(input), {
                concurrency: 4,
              });
            if (entries.length > 100)
              return Effect.fail(
                refused(
                  "listTemplates",
                  "This project exceeds the supported template limit of 100.",
                ),
              );
            return Effect.succeed(
              entries.map((entry) => ({
                ...entry,
                about: "",
                title: "",
                body: "",
                labels: [],
                assignees: [],
                contentDeferred: true,
              })),
            );
          }),
          // GitLab has no switch that forbids an issue filed from nothing.
          Effect.map((templates) => ({ templates, blankIssuesEnabled: true })),
        );
      },

      listCandidates: (input) => {
        if (groupPath(input.scope) !== null)
          return Effect.fail(refused("listCandidates", "Group epics are read-only."));
        return Effect.all(
          [
            read({
              cwd: input.cwd,
              host: input.host,
              operation: "listCandidates",
              path: paged(`projects/${projectPath(input.scope)}/labels`, 1),
              decode: decodeProjectLabelsJson,
            }),
            read({
              cwd: input.cwd,
              host: input.host,
              operation: "listCandidates",
              path: paged(`projects/${projectPath(input.scope)}/members/all`, 1),
              decode: decodeProjectMembersJson,
            }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([labels, assignees]) => ({
            labels,
            assignees,
            truncated: labels.length >= PAGE_SIZE || assignees.length >= PAGE_SIZE,
          })),
        );
      },
    };
  },
);
