import {
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as Effect from "effect/Effect";

/** How much a runtime mode allows, narrowest first. */
export function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

/** How much an interaction mode allows: plan, then default. */
export function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

/**
 * The mode a child runs at: the one asked for, never broader than its parent's.
 * An inherited mode the target provider does not offer steps down to the
 * broadest one it does; an explicitly requested one is refused instead.
 */
export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: {
    readonly modelSelection: ModelSelection;
    readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  },
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const resolved = inherited ? parentMode : requested;
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "runtime_mode_escalation_denied",
        message: `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
      }),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  if (!inherited) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Provider ${target?.modelSelection.instanceId} does not offer runtime mode ${resolved}, so it would run as approval-required. Use one of: ${supported.join(", ")}.`,
      }),
    );
  }
  return Effect.succeed(
    supported
      .filter((mode) => runtimeModeRank(mode) <= runtimeModeRank(resolved))
      .toSorted((left, right) => runtimeModeRank(right) - runtimeModeRank(left))[0] ??
      "approval-required",
  );
}

/** The same, for interaction modes. */
export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "interaction_mode_escalation_denied",
          message: `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        }),
      )
    : Effect.succeed(resolved);
}

/**
 * An agent's own session mode can skip the approvals a runtime mode asks for, and T3 cannot rank
 * it against one. So only a full-access caller may pick one. `held` is the selection the caller
 * already runs with or the thread already has; repeating it grants nothing new.
 */
export function refuseAgentModePick(input: {
  readonly callerRuntimeMode: RuntimeMode;
  readonly picked: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly held: ReadonlyArray<ProviderOptionSelection> | undefined;
}): Effect.Effect<void, OrchestratorMcpFailure> {
  if (input.callerRuntimeMode === "full-access") return Effect.void;
  const pick = input.picked?.find(
    (selection) =>
      // The adapter applies the synthetic mode id whether or not the probe advertised it.
      (selection.id === ACP_SESSION_MODE_OPTION_ID ||
        input.descriptors.some(
          (descriptor) => descriptor.id === selection.id && descriptor.role === "mode",
        )) &&
      !input.held?.some((held) => held.id === selection.id && held.value === selection.value),
  );
  return pick === undefined
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "runtime_mode_escalation_denied",
          message: `Option ${pick.id} sets the agent's own mode, which T3 cannot hold to ${input.callerRuntimeMode}. Only a full-access caller may set it; leave it out.`,
        }),
      );
}

/** Every option a provider instance advertises, across its models. */
export const providerOptionDescriptors = (
  provider:
    | {
        readonly models: ReadonlyArray<{
          readonly capabilities?:
            | { readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor> | undefined }
            | null
            | undefined;
        }>;
      }
    | undefined,
): ReadonlyArray<ProviderOptionDescriptor> =>
  provider?.models.flatMap((model) => model.capabilities?.optionDescriptors ?? []) ?? [];

/** The task as its child receives it, with the role the caller asked for. */
export function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}
