import {
  ClientSettingsSchema,
  type ClientSettingsPatch,
  type EnvironmentId,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import * as Equal from "effect/Equal";

import type { ResolvedSettingsScope } from "./settingsScope";

export type ScopedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

interface ScopedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: { readonly settings: ServerSettings } | null;
}

const SERVER_KEYS = new Set<string>(Object.keys(ServerSettings.fields));
const CLIENT_KEYS = new Set<string>(Object.keys(ClientSettingsSchema.fields));

/** The representative supplies display values, never the set of write targets. */
export function selectScopedSettingsEnvironments<T extends ScopedSettingsEnvironment>(
  scope: ResolvedSettingsScope,
  available: readonly T[],
  primaryEnvironmentId: EnvironmentId | null,
) {
  const selectedIds = new Set(scope.environmentIds);
  const environments = available.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const connectedEnvironments = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const environment =
    connectedEnvironments.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0] ??
    null;
  return { environments, connectedEnvironments, environment };
}

export function scopedSettingsAreMixed(
  environments: readonly ScopedSettingsEnvironment[],
  keys: readonly (keyof ServerSettings)[],
): boolean {
  const settings = environments.flatMap((environment) =>
    environment.connection.phase === "connected" && environment.serverConfig !== null
      ? [environment.serverConfig.settings]
      : [],
  );
  const first = settings[0];
  return (
    first !== undefined &&
    settings.some((candidate) => keys.some((key) => !Equal.equals(first[key], candidate[key])))
  );
}

/** Generic settings edits cannot create project overrides or broaden a named environment. */
export function planScopedSettingsPatch(
  scope: ResolvedSettingsScope,
  environments: readonly ScopedSettingsEnvironment[],
  patch: ScopedSettingsPatch,
) {
  const clientPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => scope.kind === "device" && CLIENT_KEYS.has(key)),
  ) as ClientSettingsPatch;
  const serverPatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => SERVER_KEYS.has(key)),
  ) as ServerSettingsPatch;
  const canWriteServer = scope.kind === "all" || scope.kind === "environment";
  const { connectedEnvironments } = selectScopedSettingsEnvironments(scope, environments, null);
  const serverWrites =
    canWriteServer && Object.keys(serverPatch).length > 0
      ? connectedEnvironments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          patch: serverPatch,
        }))
      : [];
  const hasClientWrite = Object.keys(clientPatch).length > 0;
  const hasWrite = hasClientWrite || serverWrites.length > 0;
  const unavailableReason =
    hasWrite || Object.keys(patch).length === 0
      ? null
      : scope.kind === "unavailable"
        ? scope.message
        : scope.kind === "project" || scope.kind === "checkout"
          ? "This setting does not support project overrides. Choose an environment or this device."
          : Object.keys(serverPatch).length === 0
            ? "Select This device to change this preference."
            : scope.kind === "device"
              ? "Select an environment to change this setting."
              : `Connect ${scope.kind === "environment" ? scope.label : "an environment"} to save this setting.`;
  return { clientPatch, hasClientWrite, serverWrites, unavailableReason };
}

/** Wait for every target so a failed environment does not hide successful or later writes. */
export async function persistScopedSettingsPatch(
  plan: ReturnType<typeof planScopedSettingsPatch>,
  persistServer: (input: {
    environmentId: EnvironmentId;
    input: { patch: ServerSettingsPatch };
  }) => Promise<{ readonly _tag: "Success" | "Failure" }>,
  persistClient: (patch: ClientSettingsPatch) => void,
) {
  if (plan.hasClientWrite) persistClient(plan.clientPatch);
  const results = await Promise.allSettled(
    plan.serverWrites.map(({ environmentId, patch }) =>
      persistServer({ environmentId, input: { patch } }),
    ),
  );
  const failedEnvironments = plan.serverWrites.filter((_, index) => {
    const result = results[index];
    return result?.status !== "fulfilled" || result.value._tag === "Failure";
  });
  return {
    failedEnvironments,
    savedEnvironmentCount: plan.serverWrites.length - failedEnvironments.length,
  };
}
