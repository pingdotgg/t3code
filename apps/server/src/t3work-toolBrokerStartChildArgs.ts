import { type ModelSelection, type ProviderInteractionMode } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";

export type T3workStartChildKickoffMode = "plan" | "interactive" | "autopilot";
export type T3workStartChildReasoningEffort = "low" | "medium" | "high";
export type T3workStartChildExecutionScope = "metarepo" | "repository";

export type T3workStartChildArgs = {
  readonly name: string;
  readonly executionScope: T3workStartChildExecutionScope;
  readonly ticketId?: string;
  readonly kickoffPrompt?: string;
  readonly kickoffMode?: T3workStartChildKickoffMode;
  readonly model?: string;
  readonly reasoningEffort?: T3workStartChildReasoningEffort;
  readonly repoFullName?: string;
  readonly repoRef?: string;
};

type T3workStartChildArgsResult =
  | { readonly ok: true; readonly value: T3workStartChildArgs }
  | { readonly ok: false; readonly message: string };

const START_CHILD_KICKOFF_MODES = new Set<T3workStartChildKickoffMode>([
  "plan",
  "interactive",
  "autopilot",
]);
const START_CHILD_REASONING_EFFORTS = new Set<T3workStartChildReasoningEffort>([
  "low",
  "medium",
  "high",
]);
const START_CHILD_EXECUTION_SCOPES = new Set<T3workStartChildExecutionScope>([
  "metarepo",
  "repository",
]);

export const readStartChildArgs = (value: unknown): T3workStartChildArgsResult => {
  if (!value || typeof value !== "object" || globalThis.Array.isArray(value)) {
    return {
      ok: false,
      message: "t3work.thread.start_child requires an object with at least a non-empty 'name'.",
    };
  }

  const candidate = value as {
    readonly name?: unknown;
    readonly title?: unknown;
    readonly ticket_id?: unknown;
    readonly kickoff_prompt?: unknown;
    readonly kickoff_mode?: unknown;
    readonly execution_scope?: unknown;
    readonly model?: unknown;
    readonly reasoning_effort?: unknown;
    readonly repo_full_name?: unknown;
    readonly repo_ref?: unknown;
  };

  const rawName = typeof candidate.name === "string" ? candidate.name : candidate.title;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    return {
      ok: false,
      message: "t3work.thread.start_child requires a non-empty 'name' (or legacy 'title').",
    };
  }

  const name = rawName.trim();
  if (typeof candidate.execution_scope !== "string") {
    return {
      ok: false,
      message:
        "t3work.thread.start_child requires 'execution_scope' set to 'metarepo' or 'repository'.",
    };
  }
  const executionScope = candidate.execution_scope
    .trim()
    .toLowerCase() as T3workStartChildExecutionScope;
  if (!START_CHILD_EXECUTION_SCOPES.has(executionScope)) {
    return {
      ok: false,
      message:
        "t3work.thread.start_child 'execution_scope' must be exactly 'metarepo' or 'repository'. Use 'metarepo' for project planning/triage/synthesis and 'repository' for code, tests, debugging, review, or PR work.",
    };
  }

  const ticketId =
    typeof candidate.ticket_id === "string" && candidate.ticket_id.trim().length > 0
      ? candidate.ticket_id.trim()
      : undefined;
  const kickoffPrompt =
    typeof candidate.kickoff_prompt === "string" && candidate.kickoff_prompt.trim().length > 0
      ? candidate.kickoff_prompt.trim()
      : undefined;

  let kickoffMode: T3workStartChildKickoffMode | undefined;
  if (candidate.kickoff_mode !== undefined) {
    if (typeof candidate.kickoff_mode !== "string") {
      return {
        ok: false,
        message:
          "t3work.thread.start_child 'kickoff_mode' must be one of 'plan', 'interactive', or 'autopilot'.",
      };
    }
    const normalized = candidate.kickoff_mode.trim().toLowerCase() as T3workStartChildKickoffMode;
    if (!START_CHILD_KICKOFF_MODES.has(normalized)) {
      return {
        ok: false,
        message:
          "t3work.thread.start_child 'kickoff_mode' must be one of 'plan', 'interactive', or 'autopilot'.",
      };
    }
    kickoffMode = normalized;
  }

  let reasoningEffort: T3workStartChildReasoningEffort | undefined;
  if (candidate.reasoning_effort !== undefined) {
    if (typeof candidate.reasoning_effort !== "string") {
      return {
        ok: false,
        message:
          "t3work.thread.start_child 'reasoning_effort' must be one of 'low', 'medium', or 'high'.",
      };
    }
    const normalized = candidate.reasoning_effort
      .trim()
      .toLowerCase() as T3workStartChildReasoningEffort;
    if (!START_CHILD_REASONING_EFFORTS.has(normalized)) {
      return {
        ok: false,
        message:
          "t3work.thread.start_child 'reasoning_effort' must be one of 'low', 'medium', or 'high'.",
      };
    }
    reasoningEffort = normalized;
  }

  const model =
    typeof candidate.model === "string" && candidate.model.trim().length > 0
      ? candidate.model.trim()
      : undefined;
  const repoFullName =
    typeof candidate.repo_full_name === "string" && candidate.repo_full_name.trim().length > 0
      ? candidate.repo_full_name.trim()
      : undefined;
  const repoRef =
    typeof candidate.repo_ref === "string" && candidate.repo_ref.trim().length > 0
      ? candidate.repo_ref.trim()
      : undefined;

  if (executionScope === "repository" && !repoFullName) {
    return {
      ok: false,
      message:
        "t3work.thread.start_child with execution_scope='repository' requires 'repo_full_name' so the runtime can create a dedicated linked-repository worktree.",
    };
  }
  if (executionScope === "metarepo" && (repoFullName || repoRef)) {
    return {
      ok: false,
      message:
        "t3work.thread.start_child with execution_scope='metarepo' must not include 'repo_full_name' or 'repo_ref'; use execution_scope='repository' with 'repo_full_name' for repository work.",
    };
  }

  return {
    ok: true,
    value: {
      name,
      executionScope,
      ...(ticketId ? { ticketId } : {}),
      ...(kickoffPrompt ? { kickoffPrompt } : {}),
      ...(kickoffMode ? { kickoffMode } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(repoFullName ? { repoFullName } : {}),
      ...(repoRef ? { repoRef } : {}),
    },
  };
};

export const mapKickoffModeToInteractionMode = (
  kickoffMode: T3workStartChildKickoffMode | undefined,
): ProviderInteractionMode => (kickoffMode === "plan" ? "plan" : "default");

export const buildStartChildModelSelection = (
  baseModelSelection: ModelSelection,
  input: Pick<T3workStartChildArgs, "model" | "reasoningEffort">,
): ModelSelection => {
  const nextModel = input.model ?? baseModelSelection.model;
  const normalizedModel = resolveModelSlugForProvider(
    baseModelSelection.instanceId as never,
    nextModel,
  );
  const nextSelections = input.reasoningEffort
    ? [
        ...(baseModelSelection.options ?? []).filter(
          (selection) => selection.id !== "reasoningEffort",
        ),
        { id: "reasoningEffort", value: input.reasoningEffort } as const,
      ]
    : baseModelSelection.options;

  return {
    ...baseModelSelection,
    model: normalizedModel,
    ...(nextSelections ? { options: nextSelections } : {}),
  };
};

export const readModelSelectionReasoningEffort = (
  modelSelection: ModelSelection,
): string | undefined => getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
