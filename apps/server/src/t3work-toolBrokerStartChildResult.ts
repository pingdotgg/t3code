import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";

import type {
  T3workStartChildExecutionScope,
  T3workStartChildKickoffMode,
} from "./t3work-toolBrokerStartChildArgs.ts";

export function buildStartChildResult(input: {
  readonly projectId: string;
  readonly childThreadId: string;
  readonly name: string;
  readonly executionScope: T3workStartChildExecutionScope;
  readonly started: boolean;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  readonly model: string;
  readonly requestedModel?: string;
  readonly setupScriptStatus: "not-requested" | "no-script" | "started" | "failed";
  readonly requestedKickoffMode?: T3workStartChildKickoffMode;
  readonly reasoningEffort?: string;
  readonly repoFullName: string | null;
  readonly repoRef: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly setupScriptTerminalId: string | null;
  readonly startupError?: string;
}) {
  return {
    ok: true,
    project_id: input.projectId,
    project_session_id: input.childThreadId,
    name: input.name,
    execution_scope: input.executionScope,
    started: input.started,
    interaction_mode: input.interactionMode,
    runtime_mode: input.runtimeMode,
    model: input.model,
    ...(input.requestedModel && input.requestedModel !== input.model
      ? { model_normalized_from: input.requestedModel }
      : {}),
    setup_script_status: input.setupScriptStatus,
    navigate_to: { target: "project_session", project_session_id: input.childThreadId },
    ...(input.requestedKickoffMode ? { requested_kickoff_mode: input.requestedKickoffMode } : {}),
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
    ...(input.repoFullName ? { repo_full_name: input.repoFullName } : {}),
    ...(input.repoRef ? { repo_ref: input.repoRef } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.worktreePath ? { worktree_path: input.worktreePath } : {}),
    ...(input.setupScriptTerminalId
      ? { setup_script_terminal_id: input.setupScriptTerminalId }
      : {}),
    ...(input.startupError ? { startup_error: input.startupError } : {}),
  };
}
