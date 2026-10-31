import type {
  LinearCycle,
  LinearIssue,
  LinearIssueDetail,
  LinearLinkedPullRequest,
  LinearMilestone,
  LinearPriority,
  LinearProject,
  LinearStateType,
  LinearTeam,
  LinearTeamMetadata,
} from "@t3tools/contracts";

import type {
  IssueNode,
  ProjectNode,
  IssueDetailResponse,
  MilestonesResponse,
  TeamMetadataResponse,
  TeamsResponse,
} from "./responseSchemas.ts";

const STATE_TYPES: ReadonlySet<string> = new Set<LinearStateType>([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);

/** Unknown future types read as `unstarted`, the most conservative bucket (never auto-moved as done). */
function toStateType(value: string): LinearStateType {
  return STATE_TYPES.has(value) ? (value as LinearStateType) : "unstarted";
}

function toPriority(value: number): LinearPriority {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : 0;
}

const GITHUB_PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/u;

function attachmentPullRequestState(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const record = metadata as Record<string, unknown>;
  const value = record.status ?? record.state;
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
}

/** GitHub PR attachments only; other attachment kinds (designs, docs) are not pull requests. */
function parseLinkedPullRequests(
  attachments: IssueNode["attachments"]["nodes"],
): ReadonlyArray<LinearLinkedPullRequest> {
  const seen = new Set<string>();
  const result: LinearLinkedPullRequest[] = [];
  for (const attachment of attachments) {
    if (attachment.sourceType !== null && attachment.sourceType.toLowerCase() !== "github")
      continue;
    const match = GITHUB_PULL_REQUEST_URL.exec(attachment.url);
    if (match === null) continue;
    const [, repository, number] = match;
    const key = `${repository}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      repository: repository ?? null,
      number: Number(number),
      state: attachmentPullRequestState(attachment.metadata),
      url: attachment.url,
    });
  }
  return result;
}

export function mapIssue(node: IssueNode): LinearIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    state: {
      id: node.state.id,
      name: node.state.name,
      type: toStateType(node.state.type),
      color: node.state.color,
    },
    priority: toPriority(node.priority),
    priorityLabel: node.priorityLabel,
    assignee: node.assignee,
    labels: node.labels.nodes.map((label) => ({ ...label })),
    cycle: node.cycle,
    milestone: node.projectMilestone,
    project: node.project,
    team: node.team,
    parent: node.parent,
    // Canceled sub-issues are neither work to do nor work done, so they leave both counts.
    subIssueCount: node.children.nodes.filter((child) => child.state.type !== "canceled").length,
    completedSubIssueCount: node.children.nodes.filter((child) => child.state.type === "completed")
      .length,
    branchName: node.branchName,
    updatedAt: node.updatedAt,
    linkedPullRequests: parseLinkedPullRequests(node.attachments.nodes),
  };
}

export function mapTeams(
  teams: typeof TeamsResponse.Type.teams.nodes,
  assignedTeamIds: ReadonlyArray<string>,
): ReadonlyArray<LinearTeam> {
  const assigned = new Map<string, number>();
  for (const teamId of assignedTeamIds) assigned.set(teamId, (assigned.get(teamId) ?? 0) + 1);
  return teams.map((team) => ({
    id: team.id,
    key: team.key,
    name: team.name,
    description: team.description,
    color: team.color,
    icon: team.icon,
    projectCount: team.projects.nodes.length,
    assignedToViewerCount: assigned.get(team.id) ?? 0,
  }));
}

export function mapProject(node: ProjectNode): LinearProject {
  return {
    id: node.id,
    name: node.name,
    status: node.status,
    progress: clampProgress(node.progress),
    targetDate: node.targetDate,
    teamIds: node.teams.nodes.map((team) => team.id),
    url: node.url,
  };
}

/** Linear reports progress as 0..1 on projects and, on some milestone payloads, as 0..100. */
function clampProgress(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? Math.min(1, value / 100) : value;
}

export function mapMilestones(
  project: NonNullable<typeof MilestonesResponse.Type.project>,
): ReadonlyArray<LinearMilestone> {
  return project.projectMilestones.nodes
    .map((node) => {
      const progress = clampProgress(node.progress);
      return {
        id: node.id,
        projectId: project.id,
        name: node.name,
        progress,
        targetDate: node.targetDate,
        sortOrder: node.sortOrder,
        completed: progress >= 1 || node.status === "done",
        issueCount: node.issues.nodes.length,
      };
    })
    .toSorted((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * `isCurrent`: now falls inside the cycle. `isNext`: the soonest cycle that has not started.
 * Newest cycles first, since planning happens around the current one.
 */
export function mapTeamMetadata(
  team: NonNullable<typeof TeamMetadataResponse.Type.team>,
  nowMs: number,
): LinearTeamMetadata {
  const parsed = team.cycles.nodes.map((cycle) => ({
    cycle,
    start: cycle.startsAt === null ? Number.NaN : Date.parse(cycle.startsAt),
    end: cycle.endsAt === null ? Number.NaN : Date.parse(cycle.endsAt),
  }));
  const nextStart = Math.min(
    ...parsed.filter((entry) => entry.start > nowMs).map((entry) => entry.start),
  );
  const cycles: LinearCycle[] = parsed
    .map(({ cycle, start, end }) => ({
      id: cycle.id,
      number: cycle.number,
      name: cycle.name,
      startsAt: cycle.startsAt,
      endsAt: cycle.endsAt,
      isCurrent: start <= nowMs && nowMs < end,
      isNext: Number.isFinite(nextStart) && start === nextStart,
    }))
    .toSorted((a, b) => b.number - a.number);
  return {
    teamId: team.id,
    states: team.states.nodes
      .map((state) => ({ ...state, type: toStateType(state.type) }))
      .toSorted((a, b) => a.position - b.position),
    labels: team.labels.nodes.map((label) => ({ ...label })),
    cycles,
    members: team.members.nodes.map((member) => ({ ...member })),
  };
}

export function mapIssueDetail(
  issue: NonNullable<typeof IssueDetailResponse.Type.issue>,
  subIssues: ReadonlyArray<LinearIssue>,
): LinearIssueDetail {
  const { description, comments, ...node } = issue;
  return {
    issue: mapIssue({
      ...node,
      projectMilestone:
        node.projectMilestone === null
          ? null
          : { id: node.projectMilestone.id, name: node.projectMilestone.name },
    }),
    description: description ?? "",
    milestoneProgress:
      node.projectMilestone?.progress == null
        ? null
        : clampProgress(node.projectMilestone.progress),
    subIssues,
    comments: comments.nodes
      .map((comment) => ({
        id: comment.id,
        author: comment.user,
        body: comment.body,
        createdAt: comment.createdAt,
      }))
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    attachments: node.attachments.nodes.map((attachment) => ({
      id: attachment.id,
      title: attachment.title,
      url: attachment.url,
      sourceType: attachment.sourceType,
    })),
  };
}
