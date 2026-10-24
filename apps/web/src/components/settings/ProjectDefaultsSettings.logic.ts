import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { resolveEffectiveDefaultModelSelection } from "../../modelSelection";
import {
  resolveDefaultProviderModelSelection,
  type ProviderInstanceEntry,
} from "../../providerInstances";

export interface DefaultModelSettingsPresentation {
  readonly selection: ModelSelection | null;
  readonly effortLocked: boolean;
  readonly note: string | null;
}

export function resolveDefaultModelSettingsPresentation(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly saved: ModelSelection | null | undefined;
}): DefaultModelSettingsPresentation {
  const saved = input.saved ?? null;
  const savedEntry = saved
    ? input.entries.find((entry) => entry.instanceId === saved.instanceId)
    : undefined;
  const resolved = resolveDefaultProviderModelSelection(input.providers, saved);
  const providerUnusable = saved !== null && !isUsableProviderEntry(savedEntry);
  const substituted =
    saved !== null && (resolved === null || resolved.instanceId !== saved.instanceId);

  if (saved && (providerUnusable || substituted)) {
    return {
      selection: saved,
      effortLocked: true,
      note: defaultModelProviderNote(savedEntry),
    };
  }

  return {
    selection: resolved
      ? resolveEffectiveDefaultModelSelection(input.settings, input.providers, resolved)
      : null,
    effortLocked: false,
    note: null,
  };
}

function isUsableProviderEntry(entry: ProviderInstanceEntry | undefined): boolean {
  return entry !== undefined && entry.enabled && entry.isAvailable;
}

function defaultModelProviderNote(entry: ProviderInstanceEntry | undefined): string {
  if (!entry) return "This provider is not available on this environment.";
  if (!entry.enabled) return `${entry.displayName} is turned off.`;
  return `${entry.displayName} is unavailable.`;
}
