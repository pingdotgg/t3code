import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";

import type {
  ModelCapabilities,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import { isProviderDriverKind, resolveProjectProviderInstanceEnabled } from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import { resolveProvidersForCwd } from "@t3tools/client-runtime/providerSkills";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly shortName?: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly providerIconUrl?: string | undefined;
  readonly providerBadge?: {
    readonly displayName: string;
    readonly accentColor?: string;
    readonly showBadge: boolean;
  };
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly isUnavailable?: boolean;
  readonly isHidden?: boolean;
  readonly canHide?: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
  readonly providerUpdateRequired?: ProviderUpdateRequired;
};

type ProviderUpdateRequired = Pick<
  T3ServerConfig["providers"][number],
  "driver" | "updateRequiredModels"
>;

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
  readonly updateRequired?: ProviderUpdateRequired;
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

function isProviderEnabledForProject(
  config: T3ServerConfig | null | undefined,
  provider:
    | { readonly instanceId: ModelSelection["instanceId"]; readonly enabled: boolean }
    | undefined,
  projectId: ProjectId | null,
): boolean {
  if (!provider) {
    return false;
  }
  return config?.settings
    ? resolveProjectProviderInstanceEnabled(config.settings, projectId, provider.instanceId)
    : provider.enabled;
}

function isProjectDisabledOverride(
  config: T3ServerConfig | null | undefined,
  instanceId: ModelSelection["instanceId"],
  projectId: ProjectId | null,
): boolean {
  if (!projectId || !config?.settings) {
    return false;
  }
  return (
    config.settings.projectSettingsOverrides[projectId]?.providerInstances?.[instanceId]
      ?.enabled === false
  );
}

function isDisabledForProject(
  config: T3ServerConfig | null | undefined,
  provider:
    | { readonly instanceId: ModelSelection["instanceId"]; readonly enabled: boolean }
    | undefined,
  instanceId: ModelSelection["instanceId"],
  projectId: ProjectId | null,
): boolean {
  if (isProjectDisabledOverride(config, instanceId, projectId)) {
    return true;
  }
  return provider !== undefined && !isProviderEnabledForProject(config, provider, projectId);
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  if (!selection.options?.length) {
    return { instanceId: selection.instanceId, model: selection.model };
  }
  const options = buildExplicitProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
    selection.options,
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/** The config as a project at `cwd` sees it, with that project's own provider models. */
export function serverConfigForCwd<C extends T3ServerConfig | null | undefined>(
  config: C,
  cwd: string | null,
): C {
  if (!config) return config;
  const providers = resolveProvidersForCwd(config.providers, cwd);
  return providers === config.providers ? config : { ...config, providers };
}

/** Require explicit projectId or null so omissions cannot bypass project provider disablement. */
export function isModelSelectionUnavailable(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
  projectId: ProjectId | null,
): boolean {
  if (!config || !selection) {
    return false;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (isDisabledForProject(config, provider, selection.instanceId, projectId)) {
    return true;
  }
  const driver =
    provider?.driver ?? config.settings?.providerInstances[selection.instanceId]?.driver;
  return (
    driver === "antigravity" &&
    (!provider ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      provider.availability === "unavailable" ||
      !provider.models.some((model) => model.slug === selection.model))
  );
}

export function describeUnavailableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection,
  projectId: ProjectId | null,
): { readonly title: string; readonly detail: string } {
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  return isDisabledForProject(config, provider, selection.instanceId, projectId)
    ? {
        title: "Model turned off for this project",
        detail: "Turn it back on from web or desktop, or choose another model.",
      }
    : {
        title: "Antigravity model unavailable",
        detail: "Set up Antigravity on web or desktop, or choose another model.",
      };
}

export function resolveSelectableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
  projectId: ProjectId | null,
): ModelSelection | null {
  if (!selection || !config) {
    return selection;
  }
  const provider = config.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  const driver =
    provider?.driver ?? config.settings?.providerInstances[selection.instanceId]?.driver;
  if (driver === "antigravity") {
    return isProjectDisabledOverride(config, selection.instanceId, projectId) ? null : selection;
  }
  return provider &&
    isProviderEnabledForProject(config, provider, projectId) &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

export function resolveDefaultableModelSelection(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null,
  projectId: ProjectId | null,
): ModelSelection | null {
  const usable = resolveSelectableModelSelection(config, selection, projectId);
  if (!usable || !config) {
    return usable;
  }
  const provider = config.providers.find((candidate) => candidate.instanceId === usable.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === usable.model);
  return provider?.driver !== "antigravity" && model?.isLegacy === true ? null : usable;
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
  providerInstanceId: ModelSelection["instanceId"] | undefined,
  projectId: ProjectId | null,
  includeHidden = false,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();
  const lockedProvider = config?.providers.find(
    (provider) => provider.instanceId === providerInstanceId,
  );
  const matchesLockedProvider = (provider: T3ServerConfig["providers"][number]) => {
    if (providerInstanceId === undefined || provider.instanceId === providerInstanceId) return true;
    if (!lockedProvider || provider.driver !== lockedProvider.driver) return false;
    const groupKey = lockedProvider.continuation?.groupKey;
    if (groupKey) return provider.continuation?.groupKey === groupKey;
    return provider.driver !== "antigravity";
  };
  const registryAgentId = (instanceId: ModelSelection["instanceId"]) => {
    const configValue = config?.settings?.providerInstances[instanceId]?.config;
    if (configValue === null || typeof configValue !== "object") return undefined;
    const agentId = "agentId" in configValue ? configValue.agentId : undefined;
    return "source" in configValue && configValue.source === "local"
      ? undefined
      : typeof agentId === "string"
        ? agentId.trim() || undefined
        : undefined;
  };
  const badgeEntries = (config?.providers ?? []).map((provider) => ({
    driverKind: provider.driver,
    enabled: provider.enabled,
    acpRegistryAgentId: registryAgentId(provider.instanceId),
  }));
  const providerBadgeFor = (instanceId: ModelSelection["instanceId"]) => {
    const snapshot = config?.providers.find((provider) => provider.instanceId === instanceId);
    const instance = config?.settings?.providerInstances[instanceId];
    const driver = snapshot?.driver ?? instance?.driver;
    if (!driver) return undefined;
    const accentColor = normalizeProviderAccentColor(
      snapshot?.accentColor ?? instance?.accentColor,
    );
    return {
      displayName: resolveProviderInstanceDisplayName({
        instanceId,
        driver,
        displayName: snapshot?.displayName ?? instance?.displayName,
      }),
      ...(accentColor ? { accentColor } : {}),
      showBadge: shouldShowInstanceBadge(
        {
          driverKind: driver,
          accentColor,
          acpRegistryAgentId: registryAgentId(instanceId),
          enabled: snapshot?.enabled ?? instance?.enabled ?? false,
        },
        badgeEntries,
      ),
    };
  };

  for (const provider of config?.providers ?? []) {
    if (
      !matchesLockedProvider(provider) ||
      !isProviderEnabledForProject(config, provider, projectId) ||
      !provider.installed ||
      provider.auth.status === "unauthenticated" ||
      (provider.driver === "antigravity" && provider.availability === "unavailable")
    ) {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    const providerBadge = providerBadgeFor(provider.instanceId);
    const updateRequired = provider.updateRequiredModels?.length
      ? { driver: provider.driver, updateRequiredModels: provider.updateRequiredModels }
      : undefined;
    const preferences = config?.settings?.providerModelPreferences?.[provider.instanceId];
    const hiddenModels = new Set(preferences?.hiddenModels ?? []);
    const order = new Map((preferences?.modelOrder ?? []).map((slug, index) => [slug, index]));
    const models = provider.models.filter(
      (model) => includeHidden || model.isCustom || !hiddenModels.has(model.slug),
    );
    if (order.size > 0)
      models.sort((a, b) => (order.get(a.slug) ?? Infinity) - (order.get(b.slug) ?? Infinity));
    for (const model of models) {
      const key = `${provider.instanceId}:${model.slug}`;
      const shortName = resolveModelShortName(model, provider.driver);
      options.set(key, {
        key,
        label: model.name,
        ...(shortName ? { shortName } : {}),
        subtitle: model.subProvider ?? "",
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        providerBadge,
        ...(provider.supportedRuntimeModes === undefined
          ? {}
          : { supportedRuntimeModes: provider.supportedRuntimeModes }),
        ...(provider.iconUrl ? { providerIconUrl: provider.iconUrl } : {}),
        isHidden: !model.isCustom && hiddenModels.has(model.slug),
        canHide: !model.isCustom,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        ...(updateRequired ? { providerUpdateRequired: updateRequired } : {}),
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (
    fallbackModelSelection &&
    (providerInstanceId === undefined ||
      fallbackModelSelection.instanceId === providerInstanceId) &&
    (!config?.settings?.providerModelPreferences?.[
      fallbackModelSelection.instanceId
    ]?.hiddenModels.includes(fallbackModelSelection.model) ||
      config?.providers
        .find((provider) => provider.instanceId === fallbackModelSelection.instanceId)
        ?.models.find((model) => model.slug === fallbackModelSelection.model)?.isCustom)
  ) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection:
          existing.providerDriver === "antigravity"
            ? fallbackModelSelection
            : normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const provider = config?.providers.find(
        (candidate) => candidate.instanceId === fallbackModelSelection.instanceId,
      );
      const instanceConfig = config?.settings?.providerInstances[fallbackModelSelection.instanceId];
      const model = provider?.models.find(
        (candidate) => candidate.slug === fallbackModelSelection.model,
      );
      const providerDriver =
        provider?.driver ?? instanceConfig?.driver ?? fallbackModelSelection.instanceId;
      const providerLabel = providerDisplayLabel({
        driver: providerDriver,
        displayName: provider?.displayName ?? instanceConfig?.displayName,
        instanceId: fallbackModelSelection.instanceId,
      });
      const shortName = model
        ? resolveModelShortName(model, isProviderDriverKind(providerDriver) ? providerDriver : null)
        : undefined;
      options.set(key, {
        key,
        label: model?.name ?? fallbackModelSelection.model,
        ...(shortName ? { shortName } : {}),
        subtitle: model?.subProvider ?? "",
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver,
        providerBadge: providerBadgeFor(fallbackModelSelection.instanceId),
        isDefault: false,
        isLegacy: model?.isLegacy === true,
        ...(isModelSelectionUnavailable(config, fallbackModelSelection, projectId) ||
        (provider !== undefined && !isProviderEnabledForProject(config, provider, projectId)) ||
        provider?.updateRequiredModels?.some((gated) => gated.slug === fallbackModelSelection.model)
          ? { isUnavailable: true }
          : {}),
        capabilities: model?.capabilities ?? null,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<
    string,
    {
      providerLabel: string;
      models: ModelOption[];
      updateRequired: ProviderUpdateRequired | undefined;
    }
  >();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
      existing.updateRequired ??= option.providerUpdateRequired;
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
        updateRequired: option.providerUpdateRequired,
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
    ...(group.updateRequired ? { updateRequired: group.updateRequired } : {}),
  }));
}
