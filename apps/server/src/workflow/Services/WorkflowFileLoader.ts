import type { BoardId, ProjectId, WorkflowDefinition } from "@t3tools/contracts";
import { WorkflowRpcError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { LintError } from "../workflowFile.ts";

export interface WorkflowFilePortShape {
  readonly readFileString: (filePath: string) => Effect.Effect<string, WorkflowRpcError>;
  readonly instructionFileExists: (input: {
    readonly repoRoot: string;
    readonly repoRelativePath: string;
  }) => Effect.Effect<boolean, WorkflowRpcError>;
}

export class WorkflowFilePort extends Context.Service<WorkflowFilePort, WorkflowFilePortShape>()(
  "t3/workflow/Services/WorkflowFileLoader/WorkflowFilePort",
) {}

export interface WorkflowProviderInstancePortShape {
  readonly providerInstanceExists: (instanceId: string) => Effect.Effect<boolean, WorkflowRpcError>;
  // Whether the instance's provider adapter supports resuming its own session
  // across turns/steps (Codex/Claude/Grok/Cursor do; OpenCode does not). Backs
  // the `continueSession` lint capability gate. Unknown instances resolve false.
  readonly providerInstanceSupportsResume: (
    instanceId: string,
  ) => Effect.Effect<boolean, WorkflowRpcError>;
}

export class WorkflowProviderInstancePort extends Context.Service<
  WorkflowProviderInstancePort,
  WorkflowProviderInstancePortShape
>()("t3/workflow/Services/WorkflowFileLoader/WorkflowProviderInstancePort") {}

export interface WorkflowFileLoaderShape {
  readonly lintDefinition: (input: {
    readonly definition: WorkflowDefinition;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<ReadonlyArray<LintError>, WorkflowRpcError>;
  readonly loadAndRegister: (input: {
    readonly boardId: BoardId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly relativePath: string;
    // "strict" (default) runs the full provider/instruction lint and fails on
    // any error. "skip" bypasses that strict lint — used by import, which has
    // already linted and intentionally tolerates env-bound (unknown provider
    // instance / missing instruction file) findings as warnings. The permissive
    // lint inside BoardRegistry.register still runs in both modes.
    readonly lintMode?: "strict" | "skip";
  }) => Effect.Effect<BoardId, WorkflowRpcError>;
}

export class WorkflowFileLoader extends Context.Service<
  WorkflowFileLoader,
  WorkflowFileLoaderShape
>()("t3/workflow/Services/WorkflowFileLoader") {}
