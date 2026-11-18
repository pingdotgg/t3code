import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { persistClientSettingsPatch, useMergedSettings } from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  createScopedSettingsWriter,
  pendingScopedWritesAtom,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  settlePendingScopedWrites,
  type ProjectOverrideEntry,
  type ScopedSettingsPatch,
} from "./scopedSettings";

const readSettings = (environmentId: EnvironmentId) =>
  readEnvironment(environmentId)?.serverConfig?.settings ?? null;
const writeScopedSettings = createScopedSettingsWriter(readSettings);

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
  return async (
    environments: Parameters<typeof writeScopedSettings>[0],
    planner: Parameters<typeof writeScopedSettings>[1],
    onFailed?: () => void,
  ): Promise<{ readonly saved: boolean; readonly message: string | null }> => {
    const plan = planner(environments);
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: m(msg("Setting not saved")),
        description: plan.unavailableReason,
      });
      onFailed?.();
      return { saved: false, message: plan.unavailableReason };
    }
    const save = {};
    const settle = (environmentId: EnvironmentId, saved?: ServerSettings) =>
      appAtomRegistry.update(pendingScopedWritesAtom, (writes) =>
        settlePendingScopedWrites(
          writes,
          { save, environmentId },
          (id) => readSettings(id) ?? undefined,
          saved,
        ),
      );
    appAtomRegistry.update(pendingScopedWritesAtom, (writes) => [
      ...writes,
      ...plan.serverWrites.map(({ environmentId, patch }) => ({ save, environmentId, patch })),
    ]);
    try {
      const { failedEnvironments, savedEnvironments, savedEnvironmentCount } =
        await writeScopedSettings(
          environments,
          planner,
          async (request) => {
            const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
              (scope) => !readEnvironmentScope(request.environmentId, scope),
            );
            const result = missing
              ? AsyncResult.failure(
                  Cause.fail(
                    new EnvironmentAuthorizationError({
                      requiredScope: missing,
                      message: m(msg("This connection lacks permission to change these settings.")),
                    }),
                  ),
                )
              : await persistServer(request).catch((error: unknown) => {
                  settle(request.environmentId);
                  throw error;
                });
            settle(request.environmentId, result._tag === "Success" ? result.value : undefined);
            return result;
          },
          persistClientSettingsPatch,
        );
      if (failedEnvironments.length === 0) return { saved: true, message: null };
      onFailed?.();
      const message = [
        ...failedEnvironments.map(({ label, message }) =>
          m(msg("Could not save on {label}: {message}", { label, message })),
        ),
        ...(savedEnvironmentCount > 0
          ? [
              m(
                msg("Saved on {environments}.", {
                  environments: savedEnvironments.map(({ label }) => label).join(", "),
                }),
              ),
            ]
          : []),
      ].join("\n");
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0
            ? m(msg("Setting saved on some environments"))
            : m(msg("Setting not saved")),
        description: message,
      });
      return { saved: false, message };
    } catch (error) {
      onFailed?.();
      const message =
        error instanceof Error ? error.message : m(msg("The save failed. Try again."));
      toastManager.add({
        type: "error",
        title: m(msg("Setting not saved")),
        description: message,
      });
      return { saved: false, message };
    }
  };
}

export function useUpdateScopedSettings() {
  const { scope, environments, deviceOnly } = useSettingsScope();
  const run = useRunScopedPlan();
  /** `onFailed` runs when any target rejects or drops the patch, so a draft can fall back. */
  return (patch: ScopedSettingsPatch, options?: { readonly onFailed?: () => void }) =>
    run(
      environments,
      (current) => planScopedSettingsPatch(scope, current, patch, { deviceOnly }),
      options?.onFailed,
    );
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    void run(context.environments, (current) =>
      planScopedSettingsClear(context.scope, current, keys),
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
    void run(context.environments, (current) => planProjectOverridesClear(current, entries, keys));
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
