import type { ModelSelection, OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { getModelSelectionOptionValue } from "@t3tools/shared/model";

export interface ProviderSelectionTransitionInput {
  readonly current: ModelSelection;
  readonly target: ModelSelection;
  readonly sessionCapabilities: OrchestrationV2ProviderCapabilities;
  /**
   * Option ids bound at process spawn (e.g. Grok reasoning effort). When set,
   * the orchestrator consumes this provider classification before metadata or
   * dispatch. Adapter-level pinning also protects direct adapter callers.
   */
  readonly spawnOptionIds?: ReadonlyArray<string>;
  /** Resolve provider defaults so absent and explicit equivalent values match. */
  readonly resolveSpawnOptionValue?: SpawnOptionValueResolver;
}

export type SpawnOptionValueResolver = (
  selection: ModelSelection,
  optionId: string,
) => string | boolean | undefined;

/**
 * Provider-owned classification of how a complete selection can be applied.
 * The orchestrator remains responsible for attempts and resource lifecycle.
 */
export type ProviderSelectionTransitionPlan =
  | { readonly type: "apply_on_next_turn" }
  | { readonly type: "restart_session" }
  | { readonly type: "create_with_handoff" }
  | { readonly type: "reject"; readonly reason: string };

export function turnScopedSelectionTransition(): ProviderSelectionTransitionPlan {
  return { type: "apply_on_next_turn" };
}

/** ACP models require a negotiated model/config mutation capability. */
export function acpSelectionTransition(
  input: ProviderSelectionTransitionInput,
): ProviderSelectionTransitionPlan {
  if (
    input.current.model !== input.target.model &&
    !input.sessionCapabilities.sessions.supportsModelSwitchInSession
  ) {
    return {
      type: "reject",
      reason: "The active ACP session does not expose a model-switch capability.",
    };
  }

  const spawnOptionIds = input.spawnOptionIds ?? [];
  const resolveSpawnOptionValue = input.resolveSpawnOptionValue ?? getModelSelectionOptionValue;
  for (const optionId of spawnOptionIds) {
    const targetExplicitlySelectsOption =
      getModelSelectionOptionValue(input.target, optionId) !== undefined;
    if (input.current.model !== input.target.model && !targetExplicitlySelectsOption) {
      continue;
    }
    const currentValue = resolveSpawnOptionValue(input.current, optionId);
    const targetValue = resolveSpawnOptionValue(input.target, optionId);
    if (currentValue !== targetValue) {
      return {
        type: "reject",
        reason: `The active ACP session cannot change spawn-bound option "${optionId}" after start.`,
      };
    }
  }

  return { type: "apply_on_next_turn" };
}
