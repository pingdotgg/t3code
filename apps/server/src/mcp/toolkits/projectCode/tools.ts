import {
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectCodeQueryInput,
  ProjectCodeQueryResult,
  ProjectFileHistoryInput,
  ProjectFileHistoryResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as CodeIntelligence from "../../../project/knowledge/CodeIntelligence.ts";
import * as FileHistory from "../../../project/knowledge/FileHistory.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const ProjectCodeToolkit = Toolkit.make(
  Tool.make("t3_project_code_query", {
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    dependencies: [
      CodeIntelligence.CodeIntelligence,
      ThreadManagement.ThreadManagementService,
      McpInvocationContext.McpInvocationContext,
    ],
    description:
      "Query the project's multilingual code graph before broad reads. Resolve projectId with t3_project_list and t3_project_read; threadId selects its registered worktree. Operations: bounded search, symbols, callers/callees, references, dependencies, impact, tests (reaching test files), affected (changed declarations, callers, reaching tests), status and freshness (compare checkout without indexing). Check digests, coverage, unresolved refs and edge evidence. Inspect source for partial/stale coverage, ambiguous selections or heuristic edges: static candidates aren't runtime proof.",
    parameters: Schema.Struct({
      ...ProjectCodeQueryInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectCodeQueryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_project_file_history", {
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    dependencies: [
      FileHistory.FileHistory,
      ThreadManagement.ThreadManagementService,
      McpInvocationContext.McpInvocationContext,
    ],
    description:
      "List threads with this project-relative path in a turn checkpoint, newest first. Checkpoints include all workspace changes since the last checkpoint, even from people or other threads; presence is not authorship.",
    parameters: Schema.Struct({
      ...ProjectFileHistoryInput.fields,
      environmentId: OrchestratorMcpEnvironmentTarget,
    }),
    success: ProjectFileHistoryResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
