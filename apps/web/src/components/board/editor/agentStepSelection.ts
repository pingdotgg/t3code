import type { ProviderOptionSelection } from "@t3tools/contracts";

import type { WorkflowStepEncoded } from "./WorkflowEditor";

/**
 * The encoded `agent` shape carried by an agent step in the workflow editor.
 * Options are the canonical array of provider option selections (effort,
 * thinking, fast mode, …) — the same shape the chat composer dispatches.
 */
export type AgentSelectionEncoded = Extract<
  WorkflowStepEncoded,
  { readonly type: "agent" }
>["agent"];

/**
 * Apply an instance + model change from the provider/model picker, preserving
 * any existing option selections. The effort picker only surfaces options valid
 * for the active model, and the provider ignores unknown option ids, so stale
 * selections after a model switch are harmless rather than something to discard.
 */
export function agentSelectionWithInstanceModel(
  agent: AgentSelectionEncoded,
  instance: string,
  model: string,
): AgentSelectionEncoded {
  return { ...agent, instance, model };
}

/**
 * Apply an effort/traits change. An empty or absent selection drops the
 * `options` key entirely so the persisted definition stays minimal and matches
 * the "no options" shape rather than persisting an empty array.
 */
export function agentSelectionWithOptions(
  agent: AgentSelectionEncoded,
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): AgentSelectionEncoded {
  if (options === undefined || options.length === 0) {
    const { options: _dropped, ...rest } = agent;
    return rest;
  }
  return { ...agent, options };
}

export type StepRetryEncoded = NonNullable<
  Extract<WorkflowStepEncoded, { readonly type: "agent" }>["retry"]
>;

/**
 * Apply a retry attempt-count change. `undefined` disables retry entirely
 * (drops the key); enabling retry preserves any existing escalation.
 */
export function retryWithMaxAttempts(
  retry: StepRetryEncoded | undefined,
  maxAttempts: number | undefined,
): StepRetryEncoded | undefined {
  if (maxAttempts === undefined) {
    return undefined;
  }
  return { ...retry, maxAttempts };
}

/**
 * Toggle escalation on a retry policy. Enabling seeds the escalation with the
 * step's current agent so the picker starts from a concrete selection.
 */
export function retryWithEscalation(
  retry: StepRetryEncoded,
  escalate: StepRetryEncoded["escalate"],
): StepRetryEncoded {
  if (escalate === undefined) {
    const { escalate: _dropped, ...rest } = retry;
    return rest;
  }
  return { ...retry, escalate };
}

/**
 * Apply an effort/traits change to the escalation selection, dropping empty
 * option arrays the same way `agentSelectionWithOptions` does.
 */
export function escalationWithOptions(
  escalate: NonNullable<StepRetryEncoded["escalate"]>,
  options: Parameters<typeof agentSelectionWithOptions>[1],
): NonNullable<StepRetryEncoded["escalate"]> {
  if (options === undefined || options.length === 0) {
    const { options: _dropped, ...rest } = escalate;
    return rest;
  }
  return { ...escalate, options };
}
