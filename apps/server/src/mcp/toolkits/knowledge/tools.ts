import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectKnowledgeFactDetail,
  ProjectKnowledgeMutation,
  ProjectKnowledgeMutationResult,
  ProjectKnowledgeReadFactInput,
  ProjectKnowledgeStatus,
  ProjectKnowledgeStatusInput,
  ProjectKnowledgeListInput,
  ProjectKnowledgeListResult,
  ProjectKnowledgeReadSourceInput,
  ProjectKnowledgeSource,
  ProjectKnowledgeSearchInput,
  ProjectKnowledgeSearchResult,
  ProjectKnowledgeContext,
  ProjectKnowledgePreparedContext,
} from "@t3tools/contracts";
import { MEMORY_WRITING_RULES } from "@t3tools/provider-core/server/memoryWritingRules";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as ProjectKnowledge from "../../../project/knowledge/ProjectKnowledge.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ProjectKnowledge.ProjectKnowledge,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
export const KnowledgeToolkit = Toolkit.make(
  Tool.make("t3_knowledge_search", {
    ...shared,
    description:
      "Find prior project decisions, conventions, constraints or observations. Thread agents access only their project on this environment. Outside clients select via t3_project_list and t3_project_read. Verify message citations locally with t3_knowledge_read_source. Holographic and lexical ranking; reports when unavailable. Only include superseded/set-aside facts with includeSuperseded/includeSetAside for inspection. Reuse requestId on retry to count once.",
    parameters: Schema.Struct({
      ...ProjectKnowledgeSearchInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectKnowledgeSearchResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_list", {
    ...shared,
    description:
      "List this project's facts (outside clients select a project), independent of retrieval ranking. verdict=set_aside includes set-aside facts; status=forgotten lists forgotten facts. includeSuperseded includes superseded facts; sourceState=unavailable selects broken citations.",
    parameters: Schema.Struct({
      ...ProjectKnowledgeListInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectKnowledgeListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_read_fact", {
    ...shared,
    description:
      "Read a fact, recent revisions, feedback and supersession history, linked replacements and lexical duplicate/conflict hints.",
    parameters: Schema.Struct({
      ...ProjectKnowledgeReadFactInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectKnowledgeFactDetail,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_status", {
    ...shared,
    description:
      "Project memory health: counts by status/trust, facts below recall threshold, retrieval/feedback totals and unavailable sources.",
    parameters: Schema.Struct({
      ...ProjectKnowledgeStatusInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectKnowledgeStatus,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_read_source", {
    ...shared,
    description:
      "Read the exact canonical message behind a citation. Deleted, changed and out-of-project sources return unavailable without old excerpts.",
    parameters: Schema.Struct({
      ...ProjectKnowledgeReadSourceInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectKnowledgeSource,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_prepare_context", {
    ...shared,
    description:
      "Preview explicitly selected current project knowledge under a UTF-8 byte allowance. Returns references for the user to attach; it does not send a turn.",
    parameters: Schema.Struct({
      ...ProjectKnowledgeContext.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectKnowledgePreparedContext,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_knowledge_mutate", {
    ...shared,
    description:
      MEMORY_WRITING_RULES.join(" ") +
      " Search before adding or correcting. Create/edit/supersede require content, kind, entities, tags and sources (may be empty); create needs a new factId. Cite exact messages; only unsourced agent observations may omit citations. Caller origin is recorded. Agents cannot claim direct user assertions. Saves immediately for search and related turns. Origin is not proof. Reuse commandId on retries; updates need current revision. Prefer supersede to forget for changed facts: replacementFactId keeps old content out of recall. Writes flag duplicates/conflicts. Only users restore set-aside or superseded facts; forget is permanent. Feedback helpful: true if useful, false if misleading, irrelevant if off-task.",
    parameters: Schema.Struct({
      mutation: ProjectKnowledgeMutation,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectKnowledgeMutationResult,
  }).annotate(Tool.Destructive, true),
);
