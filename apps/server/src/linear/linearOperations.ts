import * as Schema from "effect/Schema";
import { stableLinearMarkdown } from "./linearMarkdown.ts";
import * as L from "@t3tools/contracts";

export const personFields = "id name avatarUrl";
export const teamFields = "id key name";
export const stateFields = "id name color type";
export const cycleFields = "id name number startsAt endsAt";
export const pageFields = "pageInfo { hasNextPage endCursor }";
export const projectFields = `id name description url status { ${stateFields} } lead { ${personFields} } startDate targetDate`;
export const issueFields = `id identifier title url priority priorityLabel updatedAt dueDate estimate
  state { ${stateFields} } team { ${teamFields} } assignee { ${personFields} }
  project { id name } cycle { ${cycleFields} } labels { nodes { id name color } }`;
export const commentFields = `id body createdAt updatedAt user { ${personFields} }`;
export const documentSummaryFields = "id title updatedAt url";
export const documentFields = "id title content updatedAt url";
export const issueDetailFields = `${issueFields} description branchName archivedAt creator { ${personFields} }
  parent { id identifier title } children(first:50) { nodes { ${issueFields} } ${pageFields} }
  comments(first:50) { nodes { ${commentFields} } ${pageFields} }
  attachments(first:100) { nodes { id title url } }
  relations(first:100) { nodes { id type relatedIssue { id identifier title } } }
  inverseRelations(first:100) { nodes { id type issue { id identifier title } } }`;

export function linearIssueFilter(input: typeof L.LinearIssuesInput.Type, viewerId: string) {
  return {
    ...(input.parentId ? { parent: { id: { eq: input.parentId } } } : {}),
    ...(input.teamId ? { team: { id: { eq: input.teamId } } } : {}),
    ...(input.projectId ? { project: { id: { eq: input.projectId } } } : {}),
    ...(input.cycleId ? { cycle: { id: { eq: input.cycleId } } } : {}),
    ...(input.labelId ? { labels: { id: { eq: input.labelId } } } : {}),
    ...(input.priority !== undefined ? { priority: { eq: input.priority } } : {}),
    ...(input.assigneeId || input.view === "mine"
      ? { assignee: { id: { eq: input.assigneeId || viewerId } } }
      : {}),
    ...(input.view === "created" ? { creator: { id: { eq: viewerId } } } : {}),
    ...(input.view === "subscribed" ? { subscribers: { id: { eq: viewerId } } } : {}),
    ...(input.stateId
      ? { state: { id: { eq: input.stateId } } }
      : input.view === "active"
        ? { state: { type: { in: ["unstarted", "started"] } } }
        : input.view === "backlog" || input.view === "triage"
          ? { state: { type: { eq: input.view } } }
          : {}),
  };
}

const mutationEntities = {
  issueCreate: ["IssueCreateInput", "issue"],
  issueUpdate: ["IssueUpdateInput", "issue"],
  commentCreate: ["CommentCreateInput", "comment"],
  commentUpdate: ["CommentUpdateInput", "comment"],
  projectCreate: ["ProjectCreateInput", "project"],
  projectUpdate: ["ProjectUpdateInput", "project"],
  documentCreate: ["DocumentCreateInput", "document"],
  documentUpdate: ["DocumentUpdateInput", "document"],
  notificationUpdate: ["NotificationUpdateInput", "notification"],
  issueRelationCreate: ["IssueRelationCreateInput", "issueRelation"],
  attachmentCreate: ["AttachmentCreateInput", "attachment"],
  projectMilestoneCreate: ["ProjectMilestoneCreateInput", "projectMilestone"],
  projectMilestoneUpdate: ["ProjectMilestoneUpdateInput", "projectMilestone"],
  cycleCreate: ["CycleCreateInput", "cycle"],
  cycleUpdate: ["CycleUpdateInput", "cycle"],
} as const;
function stableInput<T extends object>(input: T): T {
  return {
    ...input,
    ...("description" in input && typeof input.description === "string"
      ? { description: stableLinearMarkdown(input.description) }
      : {}),
    ...("body" in input && typeof input.body === "string"
      ? { body: stableLinearMarkdown(input.body) }
      : {}),
    ...("content" in input && typeof input.content === "string"
      ? { content: stableLinearMarkdown(input.content) }
      : {}),
    ...("url" in input && typeof input.url === "string"
      ? { url: stableLinearMarkdown(input.url) }
      : {}),
  };
}
export function linearMutation(input: L.LinearMutationInput) {
  if ("input" in input) {
    const [type, entity] = mutationEntities[input.kind];
    const update = "id" in input;
    return {
      query: `mutation LinearMutation($input:${type}!${update ? ",$id:String!" : ""}) { result:${input.kind}(input:$input${update ? ",id:$id" : ""}) { success entity:${entity} { id } } }`,
      variables: { input: stableInput(input.input), ...(update ? { id: input.id } : {}) },
    };
  }
  return {
    query: `mutation LinearMutation($id:String!) { result:${input.kind}(id:$id) { success } }`,
    variables: { id: input.id },
  };
}
export const MutationAnswer = Schema.Struct({
  success: Schema.Boolean,
  entity: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
});
