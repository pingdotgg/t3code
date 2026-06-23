import type {
  ModelSelection,
  OrchestrationV2ProviderCapabilities,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

import type { ProviderContinuationIdentity } from "../provider/ProviderDriver.ts";
import type { ProviderSelectionTransitionPlan } from "./ProviderSelectionTransition.ts";

export type ProviderSessionTransition =
  | { readonly type: "reuse" }
  | { readonly type: "switch_model_in_session" }
  | { readonly type: "restart_and_resume" }
  | { readonly type: "create_with_handoff" }
  | { readonly type: "reject"; readonly reason: string };

export interface ProviderSessionTransitionState {
  readonly driver: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspace: string;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
}

export interface ProviderSessionTransitionTarget extends ProviderSessionTransitionState {
  readonly available: boolean;
}

export function decideProviderSessionTransition(input: {
  readonly current: ProviderSessionTransitionState | null;
  readonly target: ProviderSessionTransitionTarget;
  readonly selectionTransition?: ProviderSelectionTransitionPlan;
}): ProviderSessionTransition {
  if (!input.target.available) {
    return { type: "reject", reason: "The target provider instance is unavailable." };
  }
  if (input.current === null) {
    return { type: "create_with_handoff" };
  }

  const current = input.current;
  const target = input.target;
  const continuationCompatible =
    current.continuationIdentity.driverKind === target.continuationIdentity.driverKind &&
    current.continuationIdentity.continuationKey === target.continuationIdentity.continuationKey;
  if (!continuationCompatible || current.driver !== target.driver) {
    return { type: "create_with_handoff" };
  }

  const instanceChanged = current.modelSelection.instanceId !== target.modelSelection.instanceId;
  const runtimeChanged = current.runtimeMode !== target.runtimeMode;
  const workspaceChanged = current.workspace !== target.workspace;
  if (instanceChanged || runtimeChanged || workspaceChanged) {
    return { type: "restart_and_resume" };
  }

  const selectionChanged = !modelSelectionsEqual(current.modelSelection, target.modelSelection);
  if (selectionChanged) {
    switch (input.selectionTransition?.type) {
      case "apply_on_next_turn":
        return { type: "switch_model_in_session" };
      case "restart_session":
        return { type: "restart_and_resume" };
      case "create_with_handoff":
        return { type: "create_with_handoff" };
      case "reject":
        return { type: "reject", reason: input.selectionTransition.reason };
      case undefined:
        return {
          type: "reject",
          reason: "The provider adapter did not classify the selection change.",
        };
    }
  }

  // Interaction mode is turn-scoped and is applied when the next turn starts.
  return { type: "reuse" };
}
