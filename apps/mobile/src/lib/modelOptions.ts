import type {
  ModelCapabilities,
  ModelSelection,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
  modelSelectionsEqual,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isDefault: boolean;
  readonly isLegacy: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

export function threadShellHasStarted(
  thread: Pick<EnvironmentThreadShell, "itemCount" | "latestRun" | "runtime"> | null | undefined,
): boolean {
  return Boolean(thread && (thread.latestRun !== null || thread.itemCount > 0 || thread.runtime));
}

/**
 * Providers that cannot change models mid-thread bind option values the same
 * way (Grok reasoning effort is applied as an agent spawn flag at session
 * start and a loaded session keeps its original value), so a started thread
 * cannot apply a new option selection on that provider instance. Mirrors the
 * web composer's `isStartedThreadOptionChangeBlocked`. Cross-provider handoff
 * drafts use a different instance id and stay editable.
 */
export function startedThreadOptionChangeBlocked(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly threadHasStarted: boolean;
  readonly threadRuntime: { readonly providerInstanceId: string } | null | undefined;
  readonly selectionInstanceId: string;
}): boolean {
  if (!input.threadHasStarted) {
    return false;
  }
  const lockedInstanceId = input.threadRuntime?.providerInstanceId ?? input.selectionInstanceId;
  if (lockedInstanceId !== input.selectionInstanceId) {
    return false;
  }
  const provider = input.config?.providers.find(
    (snapshot) => snapshot.instanceId === input.selectionInstanceId,
  );
  return provider?.requiresNewThreadForModelChange === true;
}

/**
 * Same-instance model/option changes are rejected on a session-bound started
 * thread. A draft that targets another provider instance is handoff and must
 * not be blocked.
 */
export function isSameInstanceSessionBoundChangeBlocked(input: {
  readonly optionChangeBlocked: boolean;
  readonly committedInstanceId: string;
  readonly requestedInstanceId: string;
}): boolean {
  return input.optionChangeBlocked && input.requestedInstanceId === input.committedInstanceId;
}

/**
 * Decide how a model-menu selection should update composer draft state on a
 * started session-bound thread.
 *
 * - Cross-provider (different instance) handoff remains allowed.
 * - Reselecting the committed instance and model restores the exact committed
 *   selection so a handoff draft is cancelled and applied effort survives menu
 *   normalization that may supply default options.
 * - A different model on the same committed instance is rejected.
 */
export type SessionBoundModelSelectionUpdate =
  | { readonly type: "apply"; readonly selection: ModelSelection }
  | { readonly type: "restore_committed"; readonly selection: ModelSelection }
  | { readonly type: "reject_model_change" };

export function resolveSessionBoundModelSelectionUpdate(input: {
  readonly optionChangeBlocked: boolean;
  readonly committed: ModelSelection;
  readonly requested: ModelSelection;
}): SessionBoundModelSelectionUpdate {
  if (!input.optionChangeBlocked) {
    return { type: "apply", selection: input.requested };
  }
  if (input.requested.instanceId !== input.committed.instanceId) {
    return { type: "apply", selection: input.requested };
  }
  if (input.requested.model !== input.committed.model) {
    return { type: "reject_model_change" };
  }
  // Same instance + same model: always pin to the exact committed selection.
  // Menu normalization may have replaced applied effort with defaults; a prior
  // cross-provider draft is also replaced so the handoff is cancelled.
  return { type: "restore_committed", selection: input.committed };
}

/**
 * On a started session-bound thread, same-instance and same-model display uses
 * the committed modelSelection. Handoff and legacy model-change drafts remain
 * visible so send can handle them explicitly instead of silently substituting
 * the committed model. Draft runtime/interaction settings stay independent.
 */
export function resolveEffectiveModelSelection(input: {
  readonly draftModelSelection: ModelSelection | null | undefined;
  readonly committedModelSelection: ModelSelection;
  readonly optionChangeBlocked: boolean;
}): ModelSelection {
  const draft = input.draftModelSelection;
  if (
    input.optionChangeBlocked &&
    (draft == null ||
      (draft.instanceId === input.committedModelSelection.instanceId &&
        draft.model === input.committedModelSelection.model))
  ) {
    return input.committedModelSelection;
  }
  return draft ?? input.committedModelSelection;
}

/**
 * Resolve a durable outbox entry's model selection against the committed
 * thread selection using the same session-bound decision as live send. Stale
 * same-instance model or effort changes pin to committed so settings sync does
 * not retry a permanent rejection; cross-provider handoff drafts remain intact.
 */
export function resolveOutboxModelSelection(input: {
  readonly config: T3ServerConfig | null | undefined;
  readonly threadHasStarted: boolean;
  readonly threadRuntime: { readonly providerInstanceId: string } | null | undefined;
  readonly committedModelSelection: ModelSelection;
  readonly queuedModelSelection: ModelSelection | null | undefined;
}): ModelSelection {
  const optionChangeBlocked = startedThreadOptionChangeBlocked({
    config: input.config,
    threadHasStarted: input.threadHasStarted,
    threadRuntime: input.threadRuntime,
    selectionInstanceId: input.committedModelSelection.instanceId,
  });
  const decision = resolveSessionBoundModelSelectionUpdate({
    optionChangeBlocked,
    committed: input.committedModelSelection,
    requested: input.queuedModelSelection ?? input.committedModelSelection,
  });
  return decision.type === "reject_model_change"
    ? input.committedModelSelection
    : decision.selection;
}

/**
 * Delivery-time outbox selection: pick the queued message's environment from
 * the multi-environment config map, then pin stale same-instance spawn-bound
 * options to committed. Cross-provider handoff drafts remain intact. A missing
 * environment config defers only a conflicting same-instance selection; other
 * deliveries do not need provider lock metadata.
 */
export function resolveOutboxModelSelectionForEnvironment(input: {
  readonly serverConfigsByEnvironment: ReadonlyMap<string, T3ServerConfig>;
  readonly environmentId: string;
  readonly threadHasStarted: boolean;
  readonly threadRuntime: { readonly providerInstanceId: string } | null | undefined;
  readonly committedModelSelection: ModelSelection;
  readonly queuedModelSelection: ModelSelection | null | undefined;
}): ModelSelection | null {
  const config = input.serverConfigsByEnvironment.get(input.environmentId);
  if (config === undefined) {
    const queued = input.queuedModelSelection ?? input.committedModelSelection;
    const lockedInstanceId =
      input.threadRuntime?.providerInstanceId ?? input.committedModelSelection.instanceId;
    if (
      !input.threadHasStarted ||
      lockedInstanceId !== input.committedModelSelection.instanceId ||
      queued.instanceId !== input.committedModelSelection.instanceId ||
      modelSelectionsEqual(queued, input.committedModelSelection)
    ) {
      return queued;
    }
    return null;
  }
  return resolveOutboxModelSelection({
    config,
    threadHasStarted: input.threadHasStarted,
    threadRuntime: input.threadRuntime,
    committedModelSelection: input.committedModelSelection,
    queuedModelSelection: input.queuedModelSelection,
  });
}

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  return provider.instanceId;
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

/**
 * A stored model selection is only usable when its provider instance is
 * currently enabled, installed, and authenticated on the server. Returns the
 * selection unchanged when usable, otherwise `null` so callers fall through to
 * the server's default model. A missing config (environment offline) cannot be
 * validated, so stored selections pass through untouched.
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
  return provider &&
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated"
    ? selection
    : null;
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
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

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const providerLabel = fallbackModelSelection.instanceId;
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: fallbackModelSelection.instanceId,
        isDefault: false,
        isLegacy: false,
        capabilities: null,
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
