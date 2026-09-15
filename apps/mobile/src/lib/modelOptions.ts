import type { MenuAction } from "@react-native-menu/menu";
import { resolveProviderModelPolicy } from "@t3tools/contracts";
import type {
  ModelCapabilities,
  ModelSelection,
  RuntimeMode,
  ServerProvider,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import { resolveProviderModelOptions } from "@t3tools/client-runtime/providerModelOptions";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly providerIconUrl?: string | undefined;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly isUnavailable?: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly modelPolicy?: ServerProvider["modelPolicy"];
  readonly fusion?: ServerProvider["models"][number]["fusion"];
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  if (provider.driver === "pi") return "Pi";
  return provider.instanceId;
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
  modelPolicy: ServerProvider["modelPolicy"],
): ModelSelection {
  const { selections: options } = resolveProviderModelOptions(
    capabilities,
    selection.options,
    modelPolicy,
  );
  if (options === selection.options) return selection;
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/** Explain how to recover a known account-model selection that is unavailable. */
export function getModelSelectionUnavailableReason(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): string | null {
  if (!config || !selection) {
    return null;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const instanceConfig = config.settings?.providerInstances[selection.instanceId];
  if (
    resolveProviderModelPolicy(provider ?? instanceConfig).catalogScope === "instance" &&
    (!provider ||
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable" ||
      !provider.models.some(
        (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
      ))
  ) {
    const name = provider?.displayName ?? instanceConfig?.displayName;
    const subject = name ? `${name} model` : "Model";
    return `${subject} unavailable. Set up this provider on web or desktop, or choose another model.`;
  }
  return null;
}

export function isModelSelectionUnavailable(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): boolean {
  return getModelSelectionUnavailableReason(config, selection) !== null;
}

/**
 * Keep selections marked for preservation when setup or catalog changes make them
 * unavailable. Other providers fall through to the server default when they
 * are disabled, missing, or signed out. Without config, keep stored selections.
 */
export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (
    resolveProviderModelPolicy(provider ?? config.settings?.providerInstances[selection.instanceId])
      .preserveUnavailableModels
  ) {
    return selection;
  }
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

/**
 * Reject legacy models for implicit defaults, except preserved selections,
 * which must not silently change after a catalog update. Explicit picks in
 * the settings sheet are unaffected.
 */
export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find(
    (candidate) => candidate.slug === usable.model || candidate.aliases?.includes(usable.model),
  );
  return !resolveProviderModelPolicy(provider).preserveUnavailableModels && model?.isLegacy === true
    ? null
    : usable;
}

export function resolveNewTaskModelSelection(input: {
  readonly draftSelection: ModelSelection | null;
  readonly projectDefaultSelection: ModelSelection | null;
  readonly stickySelection: ModelSelection | null;
  readonly modelOptions: ReadonlyArray<ModelOption>;
}): ModelSelection | null {
  return (
    input.draftSelection ??
    input.projectDefaultSelection ??
    input.stickySelection ??
    input.modelOptions.find((option) => option.isDefault && !option.isUnavailable)?.selection ??
    input.modelOptions.find((option) => !option.isUnavailable)?.selection ??
    null
  );
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable"
    ) {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.fusion ? "Fusion" : model.name,
        subtitle: model.fusion
          ? `${model.fusion.lead.name} + ${model.fusion.sidekick.name}`
          : (model.subProvider ?? ""),
        fusion: model.fusion,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        ...(provider.supportedRuntimeModes === undefined
          ? {}
          : { supportedRuntimeModes: provider.supportedRuntimeModes }),
        ...(provider.iconUrl ? { providerIconUrl: provider.iconUrl } : {}),
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        capabilities: model.capabilities,
        modelPolicy: resolveProviderModelPolicy(provider),
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
          provider.modelPolicy,
        ),
      });
    }
  }

  if (fallbackModelSelection) {
    const provider = config?.providers.find(
      (candidate) => candidate.instanceId === fallbackModelSelection.instanceId,
    );
    const model =
      provider?.models.find((candidate) => candidate.slug === fallbackModelSelection.model) ??
      provider?.models.find((candidate) =>
        candidate.aliases?.includes(fallbackModelSelection.model),
      );
    const key = `${fallbackModelSelection.instanceId}:${model?.slug ?? fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(
          fallbackModelSelection,
          existing.capabilities,
          existing.modelPolicy,
        ),
      });
    } else {
      const instanceConfig = config?.settings?.providerInstances[fallbackModelSelection.instanceId];
      const providerDriver =
        provider?.driver ?? instanceConfig?.driver ?? fallbackModelSelection.instanceId;
      const providerLabel = providerDisplayLabel({
        driver: providerDriver,
        displayName: provider?.displayName ?? instanceConfig?.displayName,
        instanceId: fallbackModelSelection.instanceId,
      });
      options.set(key, {
        key,
        label: model?.fusion ? "Fusion" : (model?.name ?? fallbackModelSelection.model),
        subtitle: model?.fusion
          ? `${model.fusion.lead.name} + ${model.fusion.sidekick.name}`
          : (model?.subProvider ?? ""),
        fusion: model?.fusion,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver,
        isDefault: false,
        isLegacy: model?.isLegacy === true,
        ...(isModelSelectionUnavailable(config, fallbackModelSelection)
          ? { isUnavailable: true }
          : {}),
        capabilities: model?.capabilities ?? null,
        modelPolicy: resolveProviderModelPolicy(provider ?? instanceConfig),
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}

function modelMenuAction(option: ModelOption, selectedModel: ModelSelection | null): MenuAction {
  return {
    id: `model:${option.key}`,
    title: option.label,
    state:
      option.selection.instanceId === selectedModel?.instanceId &&
      option.selection.model === selectedModel.model
        ? "on"
        : undefined,
  };
}

export function buildModelMenuActions(
  groups: ReadonlyArray<ProviderGroup>,
  selectedModel: ModelSelection | null,
): MenuAction[] {
  return groups.flatMap((group) => {
    const currentModels = group.models.filter((model) => !model.isLegacy);
    const legacyModels = group.models.filter((model) => model.isLegacy);
    const selected = group.models.find(
      (model) =>
        model.selection.instanceId === selectedModel?.instanceId &&
        model.selection.model === selectedModel.model,
    );

    return [
      ...(currentModels.length > 0
        ? [
            {
              id: `provider:${group.providerKey}`,
              title: group.providerLabel,
              subtitle: selected && !selected.isLegacy ? selected.label : undefined,
              subactions: currentModels.map((option) => modelMenuAction(option, selectedModel)),
            },
          ]
        : []),
      ...(legacyModels.length > 0
        ? [
            {
              id: `legacy-models:${group.providerKey}`,
              title: `${group.providerLabel} legacy models`,
              subtitle: selected?.isLegacy ? selected.label : undefined,
              subactions: legacyModels.map((option) => modelMenuAction(option, selectedModel)),
            },
          ]
        : []),
    ];
  });
}
