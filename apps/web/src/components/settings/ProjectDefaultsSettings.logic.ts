import type { ModelSelection, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { resolveEffectiveDefaultModelSelection } from "../../modelSelection";
import {
  resolveDefaultProviderModelSelection,
  resolveProjectDefaultProviderModelSelection,
  type ProviderInstanceEntry,
} from "../../providerInstances";

export interface DefaultModelSettingsPresentation {
  readonly selection: ModelSelection | null;
  /** Set when the saved model's provider cannot run; effort stays hidden until it can. */
  readonly providerNote: string | null;
}

export function resolveDefaultModelSettingsPresentation(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly projectId: ProjectId | null;
}): DefaultModelSettingsPresentation {
  const saved = input.settings.defaultModelSelection;
  if (saved === null) {
    const automatic = resolveProjectDefaultProviderModelSelection(
      input.providers,
      input.settings,
      input.projectId,
    );
    return {
      selection: automatic
        ? resolveEffectiveDefaultModelSelection(input.settings, input.providers, automatic)
        : null,
      providerNote: null,
    };
  }

  const savedEntry = input.entries.find((entry) => entry.instanceId === saved.instanceId);
  const resolved = resolveDefaultProviderModelSelection(input.providers, saved);
  // Settings can turn a provider off before the server snapshot catches up, so check both.
  if (
    !savedEntry?.enabled ||
    !savedEntry.isAvailable ||
    resolved?.instanceId !== saved.instanceId
  ) {
    return { selection: saved, providerNote: providerNote(savedEntry) };
  }
  return {
    selection: resolveEffectiveDefaultModelSelection(input.settings, input.providers, resolved),
    providerNote: null,
  };
}

function providerNote(entry: ProviderInstanceEntry | undefined): string {
  if (!entry) return "This provider is not available on this environment.";
  if (!entry.enabled) return `${entry.displayName} is turned off.`;
  return `${entry.displayName} is unavailable.`;
}
