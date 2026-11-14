import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import type {
  IssueActor,
  IssueComment,
  IssueEvent,
  IssueEventKind,
  IssueLabel,
  IssueLinkedPullRequest,
  IssueState,
  IssueTemplate,
  IssueViewerPermissions,
  PullRequestState,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import type { TrackerIssueSummary } from "@t3tools/source-control-core/server/IssueTracker";

import type * as Issues from "./issues.graphql.ts";
import { toReactions } from "./gitHubPullRequestJson.ts";

type DetailIssue = NonNullable<NonNullable<Issues.IssueDetail.Result["repository"]>["issue"]>;
type Actor = {
  readonly login: string;
  readonly name?: string | null;
  readonly avatarUrl: string | null;
};
type Label = NonNullable<NonNullable<NonNullable<Issues.NodesIssue["labels"]>["nodes"]>[number]>;
type TimelineItem = NonNullable<NonNullable<DetailIssue["timelineItems"]["nodes"]>[number]>;
type Comments = Omit<DetailIssue["comments"], "totalCount">;
type Reference = NonNullable<
  NonNullable<NonNullable<DetailIssue["closedByPullRequestsReferences"]>["nodes"]>[number]
>;

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function toActor(raw: Actor | null | undefined): IssueActor | null {
  const login = trimmed(raw?.login);
  return login === null
    ? null
    : {
        login,
        name: trimmed(raw != null && "name" in raw ? raw.name : null),
        avatarUrl: trimmed(raw?.avatarUrl),
      };
}

function toActors(raw: ReadonlyArray<Actor | null> | null | undefined): ReadonlyArray<IssueActor> {
  return (raw ?? []).flatMap((entry) => toActor(entry) ?? []);
}

function toLabels(raw: ReadonlyArray<Label | null> | null | undefined): ReadonlyArray<IssueLabel> {
  return (raw ?? []).flatMap((label) => {
    const name = trimmed(label?.name);
    return name === null ? [] : [{ name, color: trimmed(label?.color) }];
  });
}

/** GitHub uses uppercase close reasons; an open issue has `""` or `REOPENED`. */
function toIssueState(
  state: string | null | undefined,
  stateReason: string | null | undefined,
): IssueState {
  if (state?.trim().toUpperCase() !== "CLOSED") return { category: "open", name: "open" };
  const reason = stateReason?.trim().toUpperCase();
  return {
    category: "closed",
    name: "closed",
    ...(reason === "COMPLETED"
      ? { closeReason: "completed" }
      : reason === "NOT_PLANNED"
        ? { closeReason: "not-planned" }
        : reason === "DUPLICATE"
          ? { closeReason: "duplicate" }
          : {}),
  };
}

function toSummary(raw: Omit<Issues.NodesIssue, "__typename">): TrackerIssueSummary {
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
    commentCount: Math.max(0, raw.comments?.totalCount ?? 0),
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
  raw: Reference | null | undefined,
  closesIssue: boolean,
): IssueLinkedPullRequest | null {
  if (raw == null) return null;
  const { title, url, number } = raw;
  const repository = raw.repository.nameWithOwner;
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

/** The change GitHub recorded, or null for a kind this page has no vocabulary for. */
function toEventFields(
  raw: TimelineItem,
): { readonly kind: IssueEventKind; readonly detail: string | null } | null {
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
        detail: trimmed(
          raw.assignee != null && "login" in raw.assignee ? raw.assignee.login : null,
        ),
      };
    case "UnassignedEvent":
      return {
        kind: "unassigned",
        detail: trimmed(
          raw.assignee != null && "login" in raw.assignee ? raw.assignee.login : null,
        ),
      };
    case "RenamedTitleEvent":
      return { kind: "renamed", detail: trimmed(raw.currentTitle) };
    case "CrossReferencedEvent": {
      const repository = trimmed(
        raw.source != null && "repository" in raw.source
          ? raw.source.repository.nameWithOwner
          : null,
      );
      const number = raw.source != null && "number" in raw.source ? raw.source.number : 0;
      return {
        kind: "referenced",
        detail: repository === null || number <= 0 ? null : `${repository}#${number}`,
      };
    }
    default:
      return null;
  }
}

function toComments(
  raw: Comments | null | undefined,
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
        url: trimmed(comment.url),
        reactions: toReactions(comment.reactionGroups, viewer),
      },
    ];
  });
}

function previousCursorOf(
  pageInfo: { readonly hasPreviousPage: boolean; readonly startCursor: string | null } | undefined,
) {
  return pageInfo?.hasPreviousPage === true ? pageInfo.startCursor : null;
}

function toViewerPermissions(raw: {
  readonly viewerPermission?: string | null | undefined;
  readonly issue: { readonly viewerCanUpdate: boolean } | null;
}): IssueViewerPermissions {
  const canUpdate = raw.issue?.viewerCanUpdate !== false;
  const canTriage = ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE"].includes(
    raw.viewerPermission?.trim().toUpperCase() ?? "",
  );
  return {
    setState: canUpdate,
    comment: true,
    edit: canUpdate,
    labels: canTriage,
    assignees: canTriage,
  };
}

interface GitHubIssueDetail extends TrackerIssueSummary {
  readonly body: string;
  readonly viewer: string | null;
  readonly viewerPermissions: IssueViewerPermissions;
  readonly reactions: ReturnType<typeof toReactions>;
  readonly comments: ReadonlyArray<IssueComment>;
  readonly commentsCursor: string | null;
  readonly events: ReadonlyArray<IssueEvent>;
  readonly linkedPullRequests: ReadonlyArray<IssueLinkedPullRequest>;
}

/** Null for a number that names no issue the viewer can see. */
export function toIssueDetail({
  viewer: rawViewer,
  repository,
}: Issues.IssueDetail.Result): GitHubIssueDetail | null {
  const issue = repository?.issue;
  if (issue == null) return null;
  const viewer = trimmed(rawViewer?.login);

  // Closing references lead; a cross-reference seen twice is filed under the stronger relation.
  const links = new Map<string, IssueLinkedPullRequest>();
  for (const node of issue.closedByPullRequestsReferences?.nodes ?? []) {
    const link = toLinkedPullRequest(node, true);
    if (link !== null) links.set(`${link.repository.toLowerCase()}#${link.number}`, link);
  }
  const events: IssueEvent[] = [];
  for (const entry of issue.timelineItems?.nodes ?? []) {
    if (entry === null) continue;
    const item = entry;
    if (item.__typename === "CrossReferencedEvent") {
      const link =
        item.source.__typename === "PullRequest" ? toLinkedPullRequest(item.source, false) : null;
      const linkKey = link === null ? null : `${link.repository.toLowerCase()}#${link.number}`;
      if (link !== null && linkKey !== null && !links.has(linkKey)) links.set(linkKey, link);
    }
    const fields = toEventFields(item);
    const id = trimmed("id" in item ? item.id : null);
    const createdAt = trimmed("createdAt" in item ? item.createdAt : null);
    if (fields === null || id === null || createdAt === null) continue;
    events.push({ id, ...fields, actor: toActor("actor" in item ? item.actor : null), createdAt });
  }
  return {
    ...toSummary(issue),
    body: issue.body ?? "",
    viewer,
    viewerPermissions: toViewerPermissions({
      viewerPermission: repository?.viewerPermission,
      issue,
    }),
    reactions: toReactions(issue.reactionGroups, viewer),
    comments: toComments(issue.comments, viewer),
    commentsCursor: previousCursorOf(issue.comments?.pageInfo),
    events,
    linkedPullRequests: [...links.values()],
  };
}

export function toIssueSearch({ search }: Issues.IssueSearch.Result) {
  return {
    items: (search.nodes ?? []).flatMap((node) =>
      node !== null && node.__typename === "Issue" ? [toSummary(node)] : [],
    ),
    nextCursor: search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null,
  };
}

export function toIssueComments({ viewer, repository }: Issues.IssueComments.Result) {
  const comments = repository?.issue?.comments;
  return {
    comments: toComments(comments, viewer.login),
    nextCursor: previousCursorOf(comments?.pageInfo),
  };
}

export function toIssueCandidates(
  repository: NonNullable<Issues.IssueCandidates.Result["repository"]>,
) {
  const { labels, assignableUsers } = repository;
  return {
    labels: (labels?.nodes ?? []).flatMap((label) =>
      label === null
        ? []
        : [
            {
              name: label.name,
              color: label.color,
              description: label.description,
            },
          ],
    ),
    assignees: toActors(assignableUsers.nodes).map((actor) => ({ ...actor, id: actor.login })),
    truncated:
      labels?.pageInfo.hasNextPage === true || assignableUsers.pageInfo.hasNextPage === true,
  };
}

export function toIssueTemplates(
  repository: NonNullable<Issues.IssueTemplates.Result["repository"]>,
): ReadonlyArray<IssueTemplate> {
  return (repository.issueTemplates ?? []).flatMap((template) => {
    if (template === null || template.filename.trim() === "") return [];
    return [
      {
        key: template.filename,
        name: template.name,
        about: template.about ?? "",
        title: template.title ?? "",
        body: template.body ?? "",
        labels: (template.labels?.nodes ?? []).flatMap((node) => node?.name ?? []),
        assignees: (template.assignees.nodes ?? []).flatMap((node) => node?.login ?? []),
      },
    ];
  });
}

const decodeCreatedIssue = decodeJsonResult(
  Schema.Struct({ number: Schema.Int, html_url: TrimmedNonEmptyString }),
);

export function decodeCreatedIssueJson(raw: string) {
  return Result.map(decodeCreatedIssue(raw), (issue) => ({
    number: issue.number,
    url: issue.html_url,
  }));
}
