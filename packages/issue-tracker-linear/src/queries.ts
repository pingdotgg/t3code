import type { LinearIssueFilter } from "@t3tools/contracts";

/** Page size for every connection we walk; Linear allows 250 but complexity grows with it. */
const PAGE_SIZE = 50;
/** Hard cap on one list; the UI shows "Showing first 250". */
export const LIST_ISSUE_CAP = 250;

// Sub-issue counts only need state types; lists keep this small to stay under query complexity limits.
const ISSUE_FIELDS = `
  id identifier title url priority priorityLabel branchName updatedAt
  state { id name type color }
  assignee { id name avatarUrl }
  labels(first: 10) { nodes { id name color } }
  cycle { id number }
  projectMilestone { id name }
  project { id name }
  team { id key name }
  parent { id identifier }
  children(first: 25) { nodes { id state { type } } }
  attachments(first: 10) { nodes { id title url sourceType metadata } }
`;

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";

export const VIEWER_QUERY = `query Viewer {
  viewer { id name email avatarUrl }
  organization { id name urlKey }
}`;

export const TEAMS_QUERY = `query Teams($after: String) {
  teams(first: ${PAGE_SIZE}, after: $after) {
    nodes { id key name description color icon projects(first: 100) { nodes { id } } }
    ${PAGE_INFO}
  }
}`;

export const ASSIGNED_ISSUES_QUERY = `query AssignedIssues {
  viewer {
    assignedIssues(first: ${LIST_ISSUE_CAP}, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { team { id } }
    }
  }
}`;

export const TEAM_METADATA_QUERY = `query TeamMetadata($teamId: String!) {
  team(id: $teamId) {
    id
    states(first: 100) { nodes { id name type color position } }
    labels(first: 250) { nodes { id name color } }
    cycles(first: 50) { nodes { id number name startsAt endsAt } }
    members(first: 250) { nodes { id name avatarUrl } }
  }
}`;

const PROJECT_FIELDS = `
  id name url progress targetDate
  status { name type color }
  teams(first: 25) { nodes { id } }
`;

export const TEAM_PROJECTS_QUERY = `query TeamProjects($teamId: String!, $after: String) {
  team(id: $teamId) {
    projects(first: ${PAGE_SIZE}, after: $after) { nodes { ${PROJECT_FIELDS} } ${PAGE_INFO} }
  }
}`;

export const PROJECTS_QUERY = `query Projects($after: String) {
  projects(first: ${PAGE_SIZE}, after: $after) { nodes { ${PROJECT_FIELDS} } ${PAGE_INFO} }
}`;

/** Milestone rows show "50+ issues" past this; nested connections multiply query complexity. */
const MILESTONE_ISSUE_COUNT_CAP = 50;

export const MILESTONES_QUERY = `query Milestones($projectId: String!) {
  project(id: $projectId) {
    id
    projectMilestones(first: ${PAGE_SIZE}) {
      nodes {
        id name progress targetDate sortOrder status
        issues(first: ${MILESTONE_ISSUE_COUNT_CAP}) { nodes { id } pageInfo { hasNextPage } }
      }
    }
  }
}`;

export const ISSUES_QUERY = `query Issues($filter: IssueFilter, $after: String) {
  issues(first: ${PAGE_SIZE}, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    ${PAGE_INFO}
  }
}`;

export const VIEW_ISSUES_QUERY = `query ViewIssues($viewId: String!, $after: String) {
  customView(id: $viewId) {
    issues(first: ${PAGE_SIZE}, after: $after) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} }
  }
}`;

export const ISSUE_QUERY = `query Issue($issueId: String!) {
  issue(id: $issueId) { ${ISSUE_FIELDS} }
}`;

export const ISSUE_DETAIL_QUERY = `query IssueDetail($issueId: String!) {
  issue(id: $issueId) {
    ${ISSUE_FIELDS.replace("projectMilestone { id name }", "projectMilestone { id name progress }")}
    description
    comments(last: 20) { nodes { id body createdAt user { id name avatarUrl } } }
  }
}`;

export const SUB_ISSUES_QUERY = `query SubIssues($issueId: String!, $after: String) {
  issue(id: $issueId) {
    children(first: ${PAGE_SIZE}, after: $after) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} }
  }
}`;

export const VIEWS_QUERY = `query Views($after: String) {
  customViews(first: ${PAGE_SIZE}, after: $after) { nodes { id name description } ${PAGE_INFO} }
}`;

export const SEARCH_QUERY = `query Search($term: String!) {
  searchIssues(term: $term, first: 20) { nodes { ${ISSUE_FIELDS} } }
}`;

export const MOVE_ISSUE_MUTATION = `mutation MoveIssue($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
}`;

export const CREATE_COMMENT_MUTATION = `mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
}`;

export const UPDATE_COMMENT_MUTATION = `mutation UpdateComment($commentId: String!, $body: String!) {
  commentUpdate(id: $commentId, input: { body: $body }) { success }
}`;

type JsonObject = Record<string, unknown>;

const OPEN_STATE_FILTER: JsonObject = { state: { type: { nin: ["completed", "canceled"] } } };

/**
 * Translates the contract filter into Linear's `IssueFilter`. Conditions are AND-ed, so a state
 * selection and the "hide completed" default can both apply. Custom views are fetched through
 * `customView.issues` instead and never reach this function.
 */
export function buildIssueFilter(filter: LinearIssueFilter): JsonObject {
  const conditions: JsonObject[] = [];
  if (filter.teamId !== undefined) conditions.push({ team: { id: { eq: filter.teamId } } });
  if (filter.projectId !== undefined)
    conditions.push({ project: { id: { eq: filter.projectId } } });
  if (filter.milestoneId !== undefined) {
    conditions.push({
      projectMilestone:
        filter.milestoneId === "none" ? { null: true } : { id: { eq: filter.milestoneId } },
    });
  }
  if (filter.assignee !== undefined) {
    conditions.push({
      assignee: filter.assignee === "me" ? { isMe: { eq: true } } : { id: { eq: filter.assignee } },
    });
  }
  if (filter.stateIds !== undefined && filter.stateIds.length > 0) {
    conditions.push({ state: { id: { in: [...filter.stateIds] } } });
  }
  if (filter.stateTypes !== undefined && filter.stateTypes.length > 0) {
    conditions.push({ state: { type: { in: [...filter.stateTypes] } } });
  }
  // Completed work is hidden unless asked for or the caller selected states explicitly.
  const explicitState = (filter.stateIds?.length ?? 0) > 0 || (filter.stateTypes?.length ?? 0) > 0;
  if (filter.includeCompleted !== true && !explicitState) conditions.push(OPEN_STATE_FILTER);
  if (filter.priorities !== undefined && filter.priorities.length > 0) {
    conditions.push({ priority: { in: [...filter.priorities] } });
  }
  if (filter.labelIds !== undefined && filter.labelIds.length > 0) {
    conditions.push({ labels: { some: { id: { in: [...filter.labelIds] } } } });
  }
  if (filter.cycleId !== undefined) conditions.push({ cycle: { id: { eq: filter.cycleId } } });
  if (filter.text !== undefined && filter.text.trim().length > 0) {
    conditions.push({ title: { containsIgnoreCase: filter.text.trim() } });
  }
  if (filter.issueIds !== undefined) conditions.push({ id: { in: [...filter.issueIds] } });
  return conditions.length === 0 ? {} : { and: conditions };
}
