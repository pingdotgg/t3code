import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import type {
  ExecutionEnvironmentCapabilities,
  IssueActor,
  IssueComment,
  IssueDetail,
  IssueEvent,
  IssueReactionContent,
  IssueState,
} from "@t3tools/contracts";

export const ISSUE_REACTIONS: ReadonlyArray<{
  content: IssueReactionContent;
  emoji: string;
  label: string;
}> = [
  { content: "thumbs-up", emoji: "👍", label: "Thumbs up" },
  { content: "thumbs-down", emoji: "👎", label: "Thumbs down" },
  { content: "laugh", emoji: "😄", label: "Laugh" },
  { content: "hooray", emoji: "🎉", label: "Hooray" },
  { content: "confused", emoji: "😕", label: "Confused" },
  { content: "heart", emoji: "❤️", label: "Heart" },
  { content: "rocket", emoji: "🚀", label: "Rocket" },
  { content: "eyes", emoji: "👀", label: "Eyes" },
];

export function issueAccess(
  detail: IssueDetail | null,
  grants: {
    connected: boolean;
    comment: boolean;
    update: boolean;
    setState: boolean;
    react: boolean;
  },
): {
  comment: boolean;
  react: boolean;
  commentReact: boolean;
  edit: boolean;
  editBody: boolean;
  labels: boolean;
  assignees: boolean;
  states: ReadonlyArray<IssueState>;
  closeReasons: ReadonlyArray<string>;
} {
  const writable = detail !== null && grants.connected && detail.writable;
  const states = detail?.states ?? detail?.capabilities.states ?? [];
  const reactionsAllowed =
    writable && grants.react && detail.capabilities.reactionContents?.length !== 0;
  const statesAllowed =
    writable && grants.setState && detail.viewerPermissions.setState && states.length > 0;
  const closeReasons = statesAllowed
    ? detail.capabilities.closeReasons.filter(
        (reason) => detail.state.category !== "closed" || reason !== detail.state.closeReason,
      )
    : [];
  const categoryOnly = states.every((state) => state.name.toLowerCase() === state.category);
  const edit =
    writable && grants.update && detail.capabilities.edit && detail.viewerPermissions.edit;
  return {
    react: reactionsAllowed && detail.capabilities.reactions,
    commentReact:
      reactionsAllowed && (detail.capabilities.commentReactions ?? detail.capabilities.reactions),
    comment:
      writable && grants.comment && detail.capabilities.comment && detail.viewerPermissions.comment,
    edit,
    editBody: edit && detail.bodyEditable !== false,
    labels:
      writable &&
      grants.update &&
      detail.capabilities.labels &&
      detail.viewerPermissions.labels &&
      detail.labelsTruncated !== true,
    assignees:
      writable &&
      grants.update &&
      detail.capabilities.assignees &&
      detail.viewerPermissions.assignees,
    states: statesAllowed
      ? states.filter((state) =>
          categoryOnly
            ? state.category !== detail.state.category ||
              (state.category === "closed" && closeReasons.length > 0)
            : state.name.toLowerCase() !== detail.state.name.toLowerCase(),
        )
      : [],
    closeReasons,
  };
}

export function issueReactionOptions(contents?: ReadonlyArray<IssueReactionContent>) {
  return contents === undefined
    ? ISSUE_REACTIONS
    : ISSUE_REACTIONS.filter((reaction) => contents.includes(reaction.content));
}

export function issueReactionAllowed(
  issue: IssueDetail,
  access: Pick<ReturnType<typeof issueAccess>, "react" | "commentReact">,
  content: IssueReactionContent,
  subjectId?: string,
  comments: ReadonlyArray<IssueComment> = issue.comments,
): boolean {
  const subjectAllowed =
    subjectId === undefined
      ? access.react
      : access.commentReact &&
        comments.some((comment) => comment.id === subjectId && comment.reactions !== undefined);
  return subjectAllowed && (issue.capabilities.reactionContents?.includes(content) ?? true);
}

export function linkedPullRequestContext(
  url: string,
  environmentId: string,
  projects: ReadonlyArray<EnvironmentProject>,
  capabilities: ExecutionEnvironmentCapabilities | undefined,
) {
  const link = parseChangeRequestUrl(url);
  const provider = sourceControlClients.findByChangeRequestUrl(url);
  if (link === null || provider === undefined || capabilities?.pullRequests !== true) return null;
  const local = projects.filter((project) => project.environmentId === environmentId);
  const serves = (
    project: EnvironmentProject,
    check: "isChangeRequestInRepository" | "canReadChangeRequestOnHost",
  ) => {
    const identity = project.repositoryIdentity;
    return identity?.provider === provider.kind && provider[check](identity, link);
  };
  const project =
    local.find((candidate) => serves(candidate, "isChangeRequestInRepository")) ??
    (capabilities.threadPullRequests === true
      ? local.find((candidate) => serves(candidate, "canReadChangeRequestOnHost"))
      : undefined);
  return project ? { environmentId, projectId: project.id } : null;
}

export const issueAssigneeId = (actor: IssueActor) => actor.id ?? actor.login;

export function resolveIssueType(
  types: ReadonlyArray<{ readonly id: string }>,
  chosen: string | null,
): string | null {
  if (types.length === 1) return types[0]!.id;
  return types.some((type) => type.id === chosen) ? chosen : null;
}

export function issueCreateBlocked(input: {
  readonly hasScope: boolean;
  readonly canWrite: boolean;
  readonly templates: {
    readonly pending: boolean;
    readonly list: {
      readonly blankIssuesEnabled: boolean;
      readonly templates: ReadonlyArray<unknown>;
    } | null;
  } | null;
  readonly blankChosen: boolean;
  readonly issueTypes: {
    readonly pending: boolean;
    readonly error: string | null;
    readonly count: number;
    readonly chosen: string | null;
  } | null;
}): string | null {
  if (!input.hasScope) return "No project here can file issues.";
  if (!input.canWrite) return "Creating issues needs the source-control write scope.";
  const templates = input.templates;
  if (templates !== null) {
    if (templates.list === null)
      return templates.pending ? "Loading templates…" : "Templates could not be read.";
    if (input.blankChosen && templates.list.blankIssuesEnabled === false) {
      return templates.list.templates.length > 0
        ? "This tracker requires a template."
        : "This tracker requires a template, and none can be filled in here.";
    }
  }
  const types = input.issueTypes;
  if (types === null || types.chosen !== null) return null;
  if (types.pending) return "Loading issue types…";
  if (types.error !== null) return `Issue types could not be read: ${types.error}`;
  return types.count === 0 ? "This project offers no issue types." : "Choose an issue type.";
}

type IssueTimelineItem =
  | { readonly kind: "comment"; readonly comment: IssueComment }
  | { readonly kind: "event"; readonly event: IssueEvent };

export function issueTimeline(
  comments: ReadonlyArray<IssueComment>,
  events: ReadonlyArray<IssueEvent>,
): IssueTimelineItem[] {
  const items: IssueTimelineItem[] = [
    ...comments.map((comment) => ({ kind: "comment" as const, comment })),
    ...events.map((event) => ({ kind: "event" as const, event })),
  ];
  const createdAt = (item: IssueTimelineItem) =>
    item.kind === "comment" ? item.comment.createdAt : item.event.createdAt;
  return items.sort((a, b) => Date.parse(createdAt(a)) - Date.parse(createdAt(b)));
}
