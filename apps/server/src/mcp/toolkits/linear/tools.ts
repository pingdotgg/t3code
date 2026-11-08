import * as L from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { LinearService } from "../../../linear/LinearService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([L.LinearError, L.OrchestratorMcpFailure, L.McpCapabilityUnavailableError]),
  failureMode: "return" as const,
  dependencies: [LinearService, McpInvocationContext.McpInvocationContext, ThreadManagementService],
};
const WorkspaceTool = Tool.make("linear_workspace", {
  ...shared,
  description:
    "Read the connected Linear organization, viewer, teams, users and project statuses. Uses the environment\u2019s configured API key; never returns credentials.",
  parameters: Schema.Struct({ environmentId: L.OrchestratorMcpEnvironmentTarget }),
  success: L.LinearWorkspace,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const TeamTool = Tool.make("linear_team", {
  ...shared,
  description:
    "Read a Linear team\u2019s available workflow states, labels, cycles and projects before assigning these fields.",
  parameters: Schema.Struct({
    ...L.LinearIdInput.fields,
    environmentId: L.OrchestratorMcpEnvironmentTarget,
  }),
  success: L.LinearTeamContext,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const IssuesTool = Tool.make("linear_issues", {
  ...shared,
  description:
    "Search and filter Linear issues. Use view mine, created or subscribed for the current user. Pages contain up to 50 issues; follow pageInfo.endCursor with after until hasNextPage is false.",
  parameters: Schema.Struct({
    ...L.LinearIssuesInput.fields,
    environmentId: L.OrchestratorMcpEnvironmentTarget,
  }),
  success: L.LinearIssuePage,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const IssueTool = Tool.make("linear_issue", {
  ...shared,
  description:
    "Read a Linear issue by UUID or identifier such as ENG-42, including Markdown, comments, subissues, relations and attachments. Use linear_comments to continue comments.",
  parameters: Schema.Struct({
    ...L.LinearIdInput.fields,
    environmentId: L.OrchestratorMcpEnvironmentTarget,
  }),
  success: L.LinearIssueDetail,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const CommentsTool = Tool.make("linear_comments", {
  ...shared,
  description:
    "Read the next page of a Linear issue\u2019s discussion. Pass the issue UUID and the previous endCursor as after.",
  parameters: Schema.Struct({
    ...L.LinearCommentsInput.fields,
    environmentId: L.OrchestratorMcpEnvironmentTarget,
  }),
  success: L.LinearCommentsPage,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const ProjectsTool = Tool.make("linear_projects", {
  ...shared,
  description:
    "List Linear projects, optionally filtered by team. Continue with after while hasNextPage is true.",
  parameters: Schema.Struct({
    ...L.LinearProjectsInput.fields,
    environmentId: L.OrchestratorMcpEnvironmentTarget,
  }),
  success: L.LinearProjectPage,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const ProjectTool = Tool.make("linear_project", {
  ...shared,
  description:
    "Read a Linear project\u2019s overview, dates, status, milestones and documents by UUID.",
  parameters: Schema.Struct({
    ...L.LinearIdInput.fields,
    environmentId: L.OrchestratorMcpEnvironmentTarget,
  }),
  success: L.LinearProjectDetail,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const DocumentsTool = Tool.make("linear_documents", {
  ...shared,
  description:
    "List Linear documents, optionally by team or project. Follow pageInfo with after for all pages.",
  parameters: Schema.Struct({
    ...L.LinearDocumentsInput.fields,
    environmentId: L.OrchestratorMcpEnvironmentTarget,
  }),
  success: L.LinearDocumentPage,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const DocumentTool = Tool.make("linear_document", {
  ...shared,
  description:
    "Read a Linear document\u2019s Markdown by UUID. Create and edit documents with linear_mutate.",
  parameters: Schema.Struct({
    ...L.LinearIdInput.fields,
    environmentId: L.OrchestratorMcpEnvironmentTarget,
  }),
  success: L.LinearDocument,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const InboxTool = Tool.make("linear_inbox", {
  ...shared,
  description:
    "Read the current Linear user\u2019s notifications. Continue with after even when a filtered page is empty but hasNextPage is true.",
  parameters: Schema.Struct({
    ...L.LinearInboxInput.fields,
    environmentId: L.OrchestratorMcpEnvironmentTarget,
  }),
  success: L.LinearInboxPage,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);
const MutateTool = Tool.make("linear_mutate", {
  ...shared,
  description:
    "Apply one explicitly requested Linear change: issues, comments, projects, documents, cycles, relations, attachments or inbox. Read the issue and team context first. Omitted fields stay unchanged; null clears nullable fields. Create uses UUIDs for team, state, user, project and cycle; parentId and relatedIssueId also accept issue identifiers. Writes are never automatically retried: if a network error leaves the outcome uncertain, read before retrying to avoid duplicates. Credentials are managed in the Linear connection settings, never in this tool.",
  parameters: Schema.Struct({
    environmentId: L.OrchestratorMcpEnvironmentTarget,
    change: L.LinearMutationInput,
  }),
  success: L.LinearMutationResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);
export const LinearToolkit = Toolkit.make(
  WorkspaceTool,
  TeamTool,
  IssuesTool,
  IssueTool,
  CommentsTool,
  ProjectsTool,
  ProjectTool,
  DocumentTool,
  DocumentsTool,
  InboxTool,
  MutateTool,
);
