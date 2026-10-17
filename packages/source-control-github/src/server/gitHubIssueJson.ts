/**
 * GraphQL result schemas and mappers for GitHub issues. Enum-ish fields are decoded as plain strings
 * and normalized here, so a schema addition GitHub ships never fails a whole payload.
 *
 * @module source-control-github/server/gitHubIssueJson
 */
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { GraphQL, GraphQLGroup } from "effect/graphql";
import * as Queries from "./issueTracker.graphql.ts";
import type {
  IssueActor,
  IssueComment,
  IssueEvent,
  IssueListOrder,
  IssueLabel,
  IssueLinkedPullRequest,
  IssueState,
  IssueTemplate,
  IssueViewerPermissions,
  PullRequestState,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import type { TrackerIssueSummary } from "@t3tools/issue-tracker-core/server/IssueTracker";

import { toReactions } from "./gitHubPullRequestJson.ts";

/** GitHub refuses a search page larger than this with EXCESSIVE_PAGINATION. */
export const SEARCH_MAX_ROWS = 100;

const LenientRows = Schema.Struct({
  ...Queries.IssueConnection.fields,
  nodes: Schema.NullOr(Schema.Array(Schema.Unknown)),
});
export const IssueSearch = GraphQL.query(Queries.IssueSearch.name, {
  document: Queries.IssueSearch.document,
  variables: Queries.IssueSearch.variables,
  result: Schema.Struct({ ...Queries.IssueSearch.result.fields, search: LenientRows }),
});
const RepositoryIssues = GraphQL.query(Queries.RepositoryIssues.name, {
  document: Queries.RepositoryIssues.document,
  variables: Queries.RepositoryIssues.variables,
  result: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        ...Queries.RepositoryIssuesRepositoryRepository.fields,
        issues: LenientRows,
      }),
    ),
  }),
});
const Timeline = Schema.Struct({
  ...Queries.IssueDetailRepositoryIssueTimelineItemsIssueTimelineItemsConnection.fields,
  nodes: Schema.NullOr(Schema.Array(Schema.Unknown)),
});
export const IssueDetail = GraphQL.query(Queries.IssueDetail.name, {
  document: Queries.IssueDetail.document,
  variables: Queries.IssueDetail.variables,
  result: Schema.Struct({
    ...Queries.IssueDetail.result.fields,
    repository: Schema.NullOr(
      Schema.Struct({
        ...Queries.IssueDetailRepositoryRepository.fields,
        issue: Schema.NullOr(
          Schema.Struct({
            ...Queries.IssueDetailRepositoryIssueIssue.fields,
            timelineItems: Timeline,
          }),
        ),
      }),
    ),
  }),
});
const HistoryTimeline = Schema.Struct({
  ...Queries.IssueHistoryRepositoryIssueTimelineItemsIssueTimelineItemsConnection.fields,
  nodes: Schema.NullOr(Schema.Array(Schema.Unknown)),
});
const IssueHistory = GraphQL.query(Queries.IssueHistory.name, {
  document: Queries.IssueHistory.document,
  variables: Queries.IssueHistory.variables,
  result: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        issue: Schema.NullOr(Schema.Struct({ timelineItems: HistoryTimeline })),
      }),
    ),
  }),
});
const IssueTemplates = GraphQL.query(Queries.IssueTemplates.name, {
  document: Queries.IssueTemplates.document,
  variables: Queries.IssueTemplates.variables,
  result: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        ...Queries.IssueTemplatesRepositoryRepository.fields,
        issueTemplates: Schema.NullOr(Schema.Array(Schema.Unknown)),
      }),
    ),
  }),
});
export const IssueQueries = GraphQLGroup.make(
  IssueSearch,
  RepositoryIssues,
  IssueDetail,
  IssueTemplates,
  Queries.IssueComments,
  IssueHistory,
  Queries.IssueViewerPermissions,
  Queries.IssueNodeId,
  Queries.IssueCommentScope,
  Queries.IssueCandidates,
  Queries.IssueViewer,
  Queries.IssueClosingPullRequests,
  Queries.IssueRelatedPullRequests,
);

const RawLabelSchema = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawCreatedIssueSchema = Schema.Struct({
  id: Schema.optional(Schema.Int),
  number: Schema.Int,
  html_url: Schema.String,
});

const decodeIssueRow = Schema.decodeUnknownExit(Queries.IssueRow);
const decodeTemplate = Schema.decodeUnknownExit(Queries.IssueTemplate);
const decodeHistoryItem = Schema.decodeUnknownExit(Queries.IssueHistoryItem);
const decodeTimelineItem = Schema.decodeUnknownExit(Queries.IssueTimelineItem);
const decodeCreatedIssue = decodeJsonResult(RawCreatedIssueSchema);
const decodeRestIssueLabels = decodeJsonResult(
  Schema.Struct({ labels: Schema.Array(RawLabelSchema) }),
);
export const decodeRestIssueMetadataJson = decodeJsonResult(
  Schema.Struct({
    labels: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
    assignees: Schema.optional(Schema.Array(Schema.Struct({ login: Schema.String }))),
  }),
);

type DecodeFailure =
  ReturnType<typeof decodeCreatedIssue> extends Result.Result<unknown, infer E> ? E : never;

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function toActor(raw: Partial<Queries.AssigneesNodesUser> | null | undefined): IssueActor | null {
  const login = trimmed(raw?.login);
  return login === null
    ? null
    : { login, name: trimmed(raw?.name), avatarUrl: trimmed(raw?.avatarUrl) };
}

function toActors(
  raw: ReadonlyArray<Partial<Queries.AssigneesNodesUser> | null> | null | undefined,
): ReadonlyArray<IssueActor> {
  return (raw ?? []).flatMap((entry) => toActor(entry) ?? []);
}

function toLabels(
  raw: ReadonlyArray<typeof RawLabelSchema.Type | null> | null | undefined,
): ReadonlyArray<IssueLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label?.name);
    return name === null ? [] : [{ name, color: trimmed(label?.color) }];
  });
}

/** GitHub spells a close reason `COMPLETED` / `NOT_PLANNED`; an open issue has `""` or `REOPENED`. */
function toIssueState(
  state: string | null | undefined,
  stateReason: string | null | undefined,
): IssueState {
  if (state?.trim().toUpperCase() !== "CLOSED")
    return { category: "open", name: "open", workflowCategory: "unstarted" };
  const reason = stateReason?.trim().toUpperCase();
  return {
    category: "closed",
    name: "closed",
    workflowCategory: reason === "NOT_PLANNED" ? "canceled" : "completed",
    ...(reason === "COMPLETED"
      ? { closeReason: "completed" }
      : reason === "NOT_PLANNED"
        ? { closeReason: "not-planned" }
        : {}),
  };
}

function toSummary(raw: Queries.IssueRow): TrackerIssueSummary {
  return {
    key: String(raw.number),
    displayKey: `#${raw.number}`,
    title: raw.title,
    url: raw.url,
    author: toActor(raw.author),
    state: toIssueState(raw.state, raw.stateReason),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    closedAt: trimmed(raw.closedAt),
    assignees: toActors(raw.assignees?.nodes),
    labels: toLabels(raw.labels?.nodes),
    labelsTruncated: raw.labels?.pageInfo?.hasNextPage === true,
    milestone: raw.milestone?.title ?? null,
    commentCount: Math.max(0, raw.comments?.totalCount ?? 0),
  };
}

export interface GitHubIssueSearchPage {
  readonly items: ReadonlyArray<TrackerIssueSummary>;
  readonly nextCursor: string | null;
}

export function toIssueSearch(data: typeof IssueSearch.result.Type): GitHubIssueSearchPage {
  return toIssuePage(data.search);
}

export function toRepositoryIssues(data: typeof RepositoryIssues.result.Type) {
  return data.repository === null ? null : toIssuePage(data.repository.issues);
}

function toIssuePage(page: typeof LenientRows.Type): GitHubIssueSearchPage {
  const items = (page.nodes ?? []).flatMap((entry) => {
    const row = decodeIssueRow(entry);
    return Exit.isSuccess(row) ? [toSummary(row.value)] : [];
  });
  return {
    items,
    nextCursor: page.pageInfo?.hasNextPage === true ? trimmed(page.pageInfo.endCursor) : null,
  };
}

function toPullRequestState(value: string | null | undefined): PullRequestState {
  switch (value?.trim().toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return "open";
  }
}

function toLinkedPullRequest(
  raw:
    | (Partial<Queries.IssueLinkedPullRequest> & { readonly __typename?: string })
    | null
    | undefined,
  closesIssue: boolean,
): IssueLinkedPullRequest | null {
  if (raw == null) return null;
  const typename = trimmed(raw.__typename);
  if (typename !== null && typename !== "PullRequest") return null;
  const repository = trimmed(raw.repository?.nameWithOwner);
  const title = trimmed(raw.title);
  const url = trimmed(raw.url);
  const number = raw.number ?? 0;
  if (repository === null || title === null || url === null || number <= 0) return null;
  return {
    repository,
    number,
    title,
    url,
    state: toPullRequestState(raw.state),
    isDraft: raw.isDraft ?? false,
    closesIssue,
  };
}

function nativeUrl(value: string | null | undefined): string | undefined {
  const url = trimmed(value);
  if (url === null || url.length > 8192 || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return ["https:", "http:"].includes(parsed.protocol) &&
    parsed.username === "" &&
    parsed.password === ""
    ? url
    : undefined;
}

/** The change GitHub recorded, or null for a kind this page has no vocabulary for. */
function toEventFields(
  raw: Queries.IssueTimelineItem,
): Pick<IssueEvent, "kind" | "detail" | "url" | "reference"> | null {
  switch (raw.__typename) {
    case "ClosedEvent":
      return { kind: "closed", detail: null };
    case "ReopenedEvent":
      return { kind: "reopened", detail: null };
    case "LabeledEvent":
      return { kind: "labeled", detail: trimmed(raw.label?.name) };
    case "UnlabeledEvent":
      return { kind: "unlabeled", detail: trimmed(raw.label?.name) };
    case "AssignedEvent":
      return {
        kind: "assigned",
        detail:
          raw.assignee != null && "login" in raw.assignee ? trimmed(raw.assignee.login) : null,
      };
    case "UnassignedEvent":
      return {
        kind: "unassigned",
        detail:
          raw.assignee != null && "login" in raw.assignee ? trimmed(raw.assignee.login) : null,
      };
    case "RenamedTitleEvent":
      return { kind: "renamed", detail: trimmed(raw.currentTitle) };
    case "CrossReferencedEvent": {
      const repository =
        "repository" in raw.source ? trimmed(raw.source.repository.nameWithOwner) : null;
      const number = "number" in raw.source ? raw.source.number : 0;
      const url = nativeUrl(raw.url);
      const sourceUrl = "url" in raw.source ? nativeUrl(raw.source.url) : undefined;
      const title = "title" in raw.source ? trimmed(raw.source.title) : null;
      const identifier = repository === null || number <= 0 ? null : `${repository}#${number}`;
      return {
        kind: "referenced",
        detail: identifier,
        ...(url === undefined ? {} : { url }),
        ...(sourceUrl === undefined
          ? {}
          : {
              reference: {
                url: sourceUrl,
                ...(title === null ? {} : { title }),
                ...(identifier === null ? {} : { identifier }),
              },
            }),
      };
    }
    default:
      return null;
  }
}

function toComments(
  raw:
    | Pick<Queries.IssueDetailRepositoryIssueCommentsIssueCommentConnection, "nodes">
    | null
    | undefined,
  viewer: string | null,
): ReadonlyArray<IssueComment> {
  return (raw?.nodes ?? []).flatMap((comment) => {
    const id = trimmed(comment?.id);
    if (comment == null || id === null) return [];
    return [
      {
        id,
        author: toActor(comment.author),
        body: comment.body ?? "",
        createdAt: comment.createdAt,
        editedAt: comment.lastEditedAt ?? null,
        canEdit: comment.viewerCanUpdate ?? false,
        url: trimmed(comment.url),
        reactions: toReactions(comment.reactionGroups, viewer),
      },
    ];
  });
}

/** Where a newest-last connection carries on into older rows; null once it is whole. */
function previousCursorOf(
  pageInfo: Queries.IssueDetailRepositoryIssueCommentsPageInfoPageInfo | undefined,
): string | null {
  return pageInfo?.hasPreviousPage === true ? (trimmed(pageInfo.startCursor) ?? "") : null;
}

function toViewerPermissions(raw: Queries.IssueViewerPermissionsRepositoryRepository) {
  const writable = raw.isArchived !== true;
  const role = raw.viewerPermission?.trim().toUpperCase();
  const canUpdate = writable && raw.issue?.viewerCanUpdate === true;
  const canTriage = role == null || ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE"].includes(role);
  return {
    setState: canUpdate,
    comment:
      writable &&
      (raw.issue?.locked !== true || role == null || ["ADMIN", "MAINTAIN", "WRITE"].includes(role)),
    edit: canUpdate,
    updateDependencies: writable && role != null && canTriage,
    labels: writable && canTriage,
    assignees: writable && canTriage,
  };
}

export interface GitHubIssueDetail extends TrackerIssueSummary {
  readonly body: string;
  readonly viewer: string | null;
  readonly viewerPermissions: IssueViewerPermissions;
  readonly reactions: ReturnType<typeof toReactions>;
  readonly comments: ReadonlyArray<IssueComment>;
  readonly commentsCursor: string | null;
  readonly events: ReadonlyArray<IssueEvent>;
  readonly historyTruncated?: boolean;
  readonly linkedPullRequests: ReadonlyArray<IssueLinkedPullRequest>;
}

/** Null for a number that names no issue the viewer can see. */
export function toIssueDetail(data: typeof IssueDetail.result.Type): GitHubIssueDetail | null {
  const { viewer: rawViewer, repository } = data;
  if (repository === null || repository.issue === null) return null;
  const issue = repository.issue;
  const viewer = trimmed(rawViewer?.login);

  // Closing references lead; a cross-reference seen twice is filed under the stronger relation.
  const links = new Map<string, IssueLinkedPullRequest>();
  for (const node of issue.closedByPullRequestsReferences?.nodes ?? []) {
    const link = toLinkedPullRequest(node, true);
    if (link !== null) links.set(`${link.repository.toLowerCase()}#${link.number}`, link);
  }
  const events: IssueEvent[] = [];
  for (const entry of issue.timelineItems?.nodes ?? []) {
    const item = decodeTimelineItem(entry);
    if (!Exit.isSuccess(item)) continue;
    if (item.value.__typename === "CrossReferencedEvent") {
      const link = toLinkedPullRequest(item.value.source, false);
      const linkKey = link === null ? null : `${link.repository.toLowerCase()}#${link.number}`;
      if (link !== null && linkKey !== null && !links.has(linkKey)) links.set(linkKey, link);
    }
    const fields = toEventFields(item.value);
    if (fields === null || !("id" in item.value) || !("createdAt" in item.value)) continue;
    const id = trimmed(item.value.id);
    const createdAt = trimmed(item.value.createdAt);
    if (id === null || createdAt === null) continue;
    events.push({ id, ...fields, actor: toActor(item.value.actor), createdAt });
  }
  return {
    ...toSummary(issue),
    body: issue.body ?? "",
    viewer,
    viewerPermissions: toViewerPermissions({
      viewerPermission: repository.viewerPermission,
      isArchived: repository.isArchived,
      issue,
    }),
    reactions: toReactions(issue.reactionGroups, viewer),
    comments: toComments(issue.comments, viewer).toReversed(),
    commentsCursor: previousCursorOf(issue.comments?.pageInfo),
    events: events.toReversed(),
    historyTruncated: issue.timelineItems?.pageInfo?.hasPreviousPage === true,
    linkedPullRequests: [...links.values()],
  };
}

export function decodeRestIssueLabelsJson(
  raw: string,
): Result.Result<ReadonlyArray<IssueLabel>, DecodeFailure> {
  return Result.map(decodeRestIssueLabels(raw), (issue) => toLabels(issue.labels));
}

function timelinePage(
  pageInfo: Queries.IssueCommentsRepositoryIssueCommentsPageInfoPageInfo,
  order: IssueListOrder,
  rowCount: number,
) {
  const more = order === "asc" ? pageInfo.hasNextPage : pageInfo.hasPreviousPage;
  const cursor = order === "asc" ? pageInfo.endCursor : pageInfo.startCursor;
  return {
    nextCursor: more ? trimmed(cursor) : null,
    valid: !more || (rowCount > 0 && trimmed(cursor) !== null),
    oppositePage: order === "asc" ? pageInfo.hasPreviousPage : pageInfo.hasNextPage,
  };
}

export function toIssueComments(
  data: Queries.IssueComments.Result,
  order: IssueListOrder = "desc",
) {
  if (data.repository?.issue == null) return null;
  const comments = data.repository.issue.comments;
  const viewer = trimmed(data.viewer?.login);
  const items = toComments(comments, viewer);
  return {
    comments: order === "asc" ? items : items.toReversed(),
    rowCount: comments.nodes?.length ?? 0,
    ...timelinePage(comments.pageInfo, order, comments.nodes?.length ?? 0),
  };
}

export function toIssueHistory(
  data: typeof IssueHistory.result.Type,
  order: IssueListOrder = "desc",
) {
  if (data.repository?.issue == null) return null;
  const timeline = data.repository.issue.timelineItems;
  const items = (timeline.nodes ?? []).flatMap((entry): IssueEvent[] => {
    const decoded = decodeHistoryItem(entry);
    if (Exit.isFailure(decoded)) return [];
    const raw = decoded.value;
    if (!("id" in raw) || !("createdAt" in raw)) return [];
    const id = trimmed(raw.id);
    const createdAt = trimmed(raw.createdAt);
    if (id === null || createdAt === null) return [];
    const fields = toEventFields(raw) ?? {
      kind: "updated" as const,
      detail: raw.__typename
        .replace(/Event$/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase(),
    };
    return [{ id, ...fields, actor: toActor("actor" in raw ? raw.actor : null), createdAt }];
  });
  return {
    items: order === "asc" ? items : items.toReversed(),
    rowCount: timeline.nodes?.length ?? 0,
    ...timelinePage(timeline.pageInfo, order, timeline.nodes?.length ?? 0),
  };
}

export function toIssueViewerPermissions(data: Queries.IssueViewerPermissions.Result) {
  return data.repository?.issue == null ? null : toViewerPermissions(data.repository);
}

export function toIssueNodeId(data: Queries.IssueNodeId.Result) {
  return data.repository?.issue?.id ?? null;
}

export function toIssueCommentScope(data: Queries.IssueCommentScope.Result) {
  const expected = data.repository?.issue?.id ?? null;
  return (
    expected !== null && data.node?.__typename === "IssueComment" && expected === data.node.issue.id
  );
}

export function toIssueEditableCommentScope(data: Queries.IssueCommentScope.Result) {
  return (
    data.repository?.issue?.id != null &&
    data.node?.__typename === "IssueComment" &&
    data.repository.issue.id === data.node.issue.id &&
    data.node.viewerCanUpdate === true
  );
}

export function toIssueCandidates(data: Queries.IssueCandidates.Result) {
  if (data.repository === null) return null;
  const { labels, assignableUsers } = data.repository;
  return {
    labels: (labels?.nodes ?? []).flatMap((label) => {
      const name = trimmed(label?.name);
      return name === null
        ? []
        : [{ name, color: trimmed(label?.color), description: trimmed(label?.description) }];
    }),
    assignees: toActors(assignableUsers.nodes).map((actor) => ({ ...actor, id: actor.login })),
    truncated:
      labels?.pageInfo?.hasNextPage === true || assignableUsers.pageInfo?.hasNextPage === true,
  };
}

export function toIssueTemplates(
  data: typeof IssueTemplates.result.Type,
): ReadonlyArray<IssueTemplate> {
  return (data.repository?.issueTemplates ?? []).flatMap((entry) => {
    const template = decodeTemplate(entry);
    if (Exit.isFailure(template)) return [];
    const key = trimmed(template.value.filename);
    if (key === null) return [];
    return [
      {
        key,
        name: trimmed(template.value.name) ?? key,
        about: template.value.about ?? "",
        title: template.value.title ?? "",
        body: template.value.body ?? "",
        labels: (template.value.labels?.nodes ?? []).flatMap((node) => trimmed(node?.name) ?? []),
        assignees: (template.value.assignees?.nodes ?? []).flatMap(
          (node) => trimmed(node?.login) ?? [],
        ),
      },
    ];
  });
}

export function decodeCreatedIssueJson(
  raw: string,
): Result.Result<
  { readonly id?: number; readonly number: number; readonly url: string },
  DecodeFailure
> {
  return Result.map(decodeCreatedIssue(raw), (issue) => ({
    ...(issue.id === undefined ? {} : { id: issue.id }),
    number: issue.number,
    url: issue.html_url,
  }));
}

export function toIssueTemplateFiles(data: typeof IssueTemplates.result.Type) {
  const repository = data.repository;
  if (repository === null) return null;
  const entries = (
    tree: Queries.FormsTree | Queries.RootFormsTree | Queries.FormsGitObjectOther | null,
  ) =>
    tree?.__typename === "Tree"
      ? (tree.entries ?? []).map((entry) => ({
          name: entry.name,
          object: entry.object?.__typename === "Blob" ? { text: entry.object.text } : null,
        }))
      : [];
  return {
    entries: entries(repository.forms),
    legacyEntries: [...entries(repository.rootForms), ...entries(repository.docsForms)],
    oid: repository.forms?.__typename === "Tree" ? repository.forms.oid : undefined,
    repository: repository.nameWithOwner,
    isPrivate: repository.isPrivate,
  };
}

export function toIssueLinkedPullRequests(
  data: Queries.IssueClosingPullRequests.Result | Queries.IssueRelatedPullRequests.Result,
  closesIssue: boolean,
) {
  const issue = data.repository?.issue;
  if (issue == null) return null;
  const connection =
    "closedByPullRequestsReferences" in issue
      ? issue.closedByPullRequestsReferences
      : issue.timelineItems;
  if (connection == null) return null;
  return {
    pageInfo: connection.pageInfo,
    items: (connection.nodes ?? []).flatMap((node) => {
      if (node == null) return [];
      const source = "source" in node ? node.source : node;
      return toLinkedPullRequest(source, closesIssue) ?? [];
    }),
  };
}
