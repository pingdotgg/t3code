import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScopedServerSettingKey,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { persistClientSettingsPatch, useMergedSettings } from "../../hooks/useSettings";
import { localizeModelSelection } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

const MODEL_SELECTION_KEYS = [
  "defaultModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "speechPostProcessingModelSelection",
] as const;

type ModelSelectionFields = {
  readonly [K in (typeof MODEL_SELECTION_KEYS)[number]]?: {
    readonly instanceId?: ProviderInstanceId;
  } | null;
};

function localizeModelSelections<T extends ModelSelectionFields>(
  settings: T,
  source: ReadonlyArray<ServerProvider>,
  target: ReadonlyArray<ServerProvider>,
): T {
  let next: T | null = null;
  for (const key of MODEL_SELECTION_KEYS) {
    const value = settings[key];
    const localized = value ? localizeModelSelection(value, source, target) : value;
    if (localized !== value) Object.assign((next ??= { ...settings }), { [key]: localized });
  }
  return next ?? settings;
}

/** Pickers show the scope target's instance ids; each environment stores its own. */
function useModelSelectionLocalizer() {
  const { target } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const shown = target ? providersByEnvironment.get(target.environmentId) : undefined;
  return {
    toEnvironment: <T extends ModelSelectionFields>(
      environmentId: EnvironmentId,
      settings: T,
    ): T => {
      const destination = providersByEnvironment.get(environmentId);
      return shown && destination
        ? localizeModelSelections(settings, shown, destination)
        : settings;
    },
    toShown: <T extends ModelSelectionFields>(environmentId: EnvironmentId, settings: T): T => {
      const source = providersByEnvironment.get(environmentId);
      return shown && source ? localizeModelSelections(settings, source, shown) : settings;
    },
  };
}

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  const { toShown } = useModelSelectionLocalizer();
  return scopedSettingsAreMixed(
    targets.map((candidate) => ({
      settings: toShown(candidate.environmentId, candidate.settings),
    })),
    keys,
  );
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return (plan: ReturnType<typeof planScopedSettingsPatch>, onFailed?: () => void) => {
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "Setting not saved",
        description: plan.unavailableReason,
      });
      onFailed?.();
      return;
    }
    void persistScopedSettingsPatch(
      plan,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        if (missing)
          return AsyncResult.failure(
            Cause.fail(
              new EnvironmentAuthorizationError({
                requiredScope: missing,
                message: "This connection lacks permission to change these settings.",
              }),
            ),
          );
        return persistServer(request);
      },
      persistClientSettingsPatch,
    ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
      if (failedEnvironments.length === 0) return;
      onFailed?.();
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0 ? "Setting saved on some environments" : "Setting not saved",
        description: [
          ...failedEnvironments.map(
            ({ label, message }) => `Could not save on ${label}: ${message}`,
          ),
          ...(savedEnvironmentCount > 0
            ? [`Saved on ${savedEnvironments.map(({ label }) => label).join(", ")}.`]
            : []),
        ].join("\n"),
      });
    });
  };
}

export function useUpdateScopedSettings() {
  const { scope, environments } = useSettingsScope();
  const run = useRunScopedPlan();
  const { toEnvironment } = useModelSelectionLocalizer();
  /** `onFailed` runs when any target rejects or drops the patch, so a draft can fall back. */
  return (patch: ScopedSettingsPatch, options?: { readonly onFailed?: () => void }) =>
    run(planScopedSettingsPatch(scope, environments, patch, toEnvironment), options?.onFailed);
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(planScopedSettingsClear(context.scope, context.environments, keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(planProjectOverridesClear(context.environments, entries, keys));
  };
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
