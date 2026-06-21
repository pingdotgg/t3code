import type {
  ModelSelection,
  OrchestrationV2ProviderCapabilities,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";

import type { ProviderContinuationIdentity } from "../provider/ProviderDriver.ts";

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

  const modelChanged = current.modelSelection.model !== target.modelSelection.model;
  if (modelChanged) {
    return target.capabilities.sessions.supportsModelSwitchInSession
      ? { type: "switch_model_in_session" }
      : { type: "restart_and_resume" };
  }

  // Interaction mode is turn-scoped and is applied when the next turn starts.
  return { type: "reuse" };
}
