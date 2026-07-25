/**
 * Labels for the model behind an assistant message.
 *
 * A thread can change model and effort between turns, so each assistant message
 * records what produced it. This turns that record into display strings, using
 * the live provider snapshot for model names and effort labels.
 *
 * @module messageResponder
 */
import type {
  ModelSelection,
  OrchestrationMessageResponder,
  ProviderDriverKind,
  ServerProviderModel,
} from "@t3tools/contracts";

import { AUTO_EFFORT_LABEL, isEffortOptionDescriptor } from "./autoEffort.ts";
import { getProviderOptionDescriptors, getProviderOptionStringSelectionValue } from "./model.ts";

export interface MessageResponderProvider {
  readonly instanceId: string;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly accentColor?: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

export interface MessageResponderDisplay {
  /** Model display name, falling back to its slug. */
  readonly model: string;
  /** Effort label, or `Auto (High)` when the reviewer picked it. */
  readonly effort: string | null;
  /** Driver behind the message, for the provider logo. Null once uninstalled. */
  readonly driver: ProviderDriverKind | null;
  readonly providerName: string;
  readonly accentColor: string | undefined;
}

function effortLabel(
  model: ServerProviderModel | undefined,
  modelSelection: ModelSelection,
): string | null {
  const caps = model?.capabilities;
  if (!caps) {
    return null;
  }
  for (const descriptor of getProviderOptionDescriptors({ caps })) {
    if (!isEffortOptionDescriptor(descriptor)) {
      continue;
    }
    const value = getProviderOptionStringSelectionValue(modelSelection.options, descriptor.id);
    if (value === undefined) {
      return null;
    }
    return descriptor.options.find((option) => option.id === value)?.label ?? value;
  }
  return null;
}

/**
 * Describe the model and effort an assistant message was produced with.
 *
 * Returns `null` for messages recorded before this was tracked, so callers can
 * skip rendering rather than show a placeholder.
 */
export function describeMessageResponder(input: {
  readonly responder: OrchestrationMessageResponder | null | undefined;
  readonly providers: ReadonlyArray<MessageResponderProvider>;
}): MessageResponderDisplay | null {
  const responder = input.responder;
  if (!responder) {
    return null;
  }
  const { modelSelection } = responder;
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === modelSelection.instanceId,
  );
  const model = provider?.models.find((candidate) => candidate.slug === modelSelection.model);
  const effort = effortLabel(model, modelSelection);
  return {
    model: model?.name ?? modelSelection.model,
    effort:
      responder.autoEffort === true
        ? effort === null
          ? AUTO_EFFORT_LABEL
          : `${AUTO_EFFORT_LABEL} (${effort})`
        : effort,
    driver: provider?.driver ?? null,
    providerName: provider?.displayName ?? modelSelection.instanceId,
    accentColor: provider?.accentColor,
  };
}
