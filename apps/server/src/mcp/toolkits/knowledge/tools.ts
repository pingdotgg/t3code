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
      "Use when a task depends on prior project decisions, conventions, constraints, or agent observations. Resolve projectId from the selected environment's registered projects with t3_project_list and t3_project_read using the same environmentId. Recall is on demand; facts are not automatically added to the prompt. Read returned message citations with t3_knowledge_read_source in that same environment before relying on them. Facts use holographic and lexical ranking. Unavailable ranking is explicit. Superseded facts are excluded unless includeSuperseded is set. Reuse requestId for retries so retrieval is counted once.",
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
      "List saved project facts, or forgotten facts when requested. Superseded facts are excluded unless includeSuperseded is set; sourceState unavailable lists only facts whose citations no longer resolve. This works independently of the retrieval kernel.",
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
      "Read one project fact with its recent revision, feedback and supersession history, linked superseding facts, and possible duplicates or conflicts found by lexical similarity.",
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
      "Summarize project memory health: fact counts by status, trust bands, facts below the default recall threshold, retrieval and feedback totals, and facts whose sources are unavailable.",
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
      "Create or edit project knowledge, supersede a fact with a replacement, forget a fact, or give trust feedback. When a fact comes from a conversation message, attach that exact message citation. Leave sources empty only for an agent observation with no message source; its origin is recorded from this authenticated caller. Facts are saved immediately and can be recalled by search, but are not automatically added to the prompt. Saving records a claim with its origin, not proof that it is true. Agents cannot claim direct user assertions. Reuse commandId when retrying. Updates require the current revision. Supersede creates replacementFactId and keeps the old fact's content but removes it from recall; prefer it over forget when knowledge changed. Created, edited and replacement facts return hints naming possible duplicates or conflicts to review. Forgotten facts cannot be restored.",
    parameters: Schema.Struct({
      mutation: ProjectKnowledgeMutation,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectKnowledgeMutationResult,
  }).annotate(Tool.Destructive, true),
);
