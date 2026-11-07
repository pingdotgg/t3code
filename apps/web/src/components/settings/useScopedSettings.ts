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
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { persistClientSettingsPatch, useMergedSettings } from "../../hooks/useSettings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  applyPendingScopedWrites,
  appendPendingScopedWrites,
  createScopedSettingsSaveQueue,
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  pendingScopedWriteApplies,
  pendingScopedWritesAtom,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type PendingScopedWrite,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

const enqueueProjectSave = createScopedSettingsSaveQueue();
function confirmedEnvironments(environments: ReturnType<typeof useSettingsScope>["environments"]) {
  return applyPendingScopedWrites(
    environments.map((environment) => ({
      ...environment,
      serverConfig:
        appAtomRegistry.get(serverEnvironment.configValueAtom(environment.environmentId)) ?? null,
    })),
    appAtomRegistry.get(pendingScopedWritesAtom).filter((write) => write.confirmed !== undefined),
  );
}

const savedSettings = (environmentId: PendingScopedWrite["environmentId"]) =>
  appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.settings;
const pendingConfigSubscriptions = new Map<PendingScopedWrite["environmentId"], () => void>();

function updatePendingScopedWrites(
  update: (writes: readonly PendingScopedWrite[]) => readonly PendingScopedWrite[],
) {
  appAtomRegistry.update(pendingScopedWritesAtom, (current) =>
    update(current).filter((write) =>
      pendingScopedWriteApplies(write, savedSettings(write.environmentId)),
    ),
  );
  const environments = new Set(
    appAtomRegistry.get(pendingScopedWritesAtom).map((write) => write.environmentId),
  );
  for (const [environmentId, unsubscribe] of pendingConfigSubscriptions) {
    if (environments.has(environmentId)) continue;
    unsubscribe();
    pendingConfigSubscriptions.delete(environmentId);
  }
  for (const environmentId of environments) {
    if (pendingConfigSubscriptions.has(environmentId)) continue;
    pendingConfigSubscriptions.set(
      environmentId,
      appAtomRegistry.subscribe(
        serverEnvironment.configValueAtom(environmentId),
        () => updatePendingScopedWrites((current) => current),
        { immediate: false },
      ),
    );
  }
}

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

function useRunScopedPlan() {
  const persistServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const persist = (plan: ReturnType<typeof planScopedSettingsPatch>, onFailed?: () => void) => {
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: "Setting not saved",
        description: plan.unavailableReason,
      });
      onFailed?.();
      return Promise.resolve();
    }
    const pending = plan.serverWrites.map(
      ({ environmentId, patch, previous }): PendingScopedWrite => ({
        environmentId,
        patch,
        savedOver: savedSettings(environmentId) ?? previous,
      }),
    );
    updatePendingScopedWrites((current) => appendPendingScopedWrites(current, pending));
    const settle = (
      target: Pick<PendingScopedWrite, "environmentId" | "patch">,
      confirmed?: ServerSettings,
    ) =>
      updatePendingScopedWrites((current) =>
        current.flatMap((write) => {
          if (write.environmentId !== target.environmentId || write.patch !== target.patch)
            return [write];
          return confirmed ? [{ ...write, confirmed }] : [];
        }),
      );
    return persistScopedSettingsPatch(
      plan,
      async (request) => {
        const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
          (scope) => !readEnvironmentScope(request.environmentId, scope),
        );
        const result = missing
          ? AsyncResult.failure(
              Cause.fail(
                new EnvironmentAuthorizationError({
                  requiredScope: missing,
                  message: "This connection lacks permission to change these settings.",
                }),
              ),
            )
          : await persistServer(request);
        settle(
          { environmentId: request.environmentId, patch: request.input.patch },
          result._tag === "Success" ? result.value : undefined,
        );
        return result;
      },
      persistClientSettingsPatch,
    )
      .then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
        for (const failed of failedEnvironments) settle(failed);
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
      })
      .catch(() => {
        for (const write of pending) settle(write);
      });
  };
  return (
    plan: () => ReturnType<typeof planScopedSettingsPatch>,
    projectWrite: boolean,
    onFailed?: () => void,
  ) => {
    // Project override entries replace whole objects, so dependent saves must plan after confirmation.
    const save = () => persist(plan(), onFailed);
    void (projectWrite ? enqueueProjectSave(save) : save());
  };
}

export function useUpdateScopedSettings() {
  const { scope, environments } = useSettingsScope();
  const run = useRunScopedPlan();
  /** `onFailed` runs when any target rejects or drops the patch, so a draft can fall back. */
  return (patch: ScopedSettingsPatch, options?: { readonly onFailed?: () => void }) =>
    run(
      () => planScopedSettingsPatch(scope, confirmedEnvironments(environments), patch),
      scope.kind === "project" || scope.kind === "checkout",
      options?.onFailed,
    );
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(
      () =>
        planScopedSettingsClear(context.scope, confirmedEnvironments(context.environments), keys),
      true,
    );
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
    run(
      () => planProjectOverridesClear(confirmedEnvironments(context.environments), entries, keys),
      true,
    );
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
