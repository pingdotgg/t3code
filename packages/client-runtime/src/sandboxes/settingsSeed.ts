import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  isManagedDriverAllowed,
  isManagedSettingPath,
  type ManagedPolicySummary,
  type ProjectScopedServerSettingKey,
  type ProviderInstanceMutation,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

const MODEL_SELECTION_KEYS = [
  "defaultModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
] as const satisfies ReadonlyArray<ProjectScopedServerSettingKey>;

const PI_DRIVER = ProviderDriverKind.make("pi");
const PI_INSTANCE_ID = defaultInstanceIdForDriver(PI_DRIVER);

export interface SandboxSettingsSeed {
  readonly patch: ServerSettingsPatch;
  readonly providerInstanceMutation?: ProviderInstanceMutation;
}

/**
 * Each project-scoped key the user changed here while the new Sandbox has the default, never
 * overwriting its own choices; model selections only for provider instances it has turned on. Pi
 * is off until turned on, so an Agent with agentctl's Pi harness gets it unless it has a Pi entry.
 */
export function sandboxSettingsSeed(input: {
  readonly local: ServerSettings;
  readonly sandbox: ServerSettings;
  /** The provider instances the Sandbox has turned on. */
  readonly sandboxProviderInstanceIds: ReadonlySet<string>;
  readonly harnesses: ReadonlyArray<string>;
  /** The server refuses a whole update that touches anything its policy locks or disallows. */
  readonly sandboxPolicy?: ManagedPolicySummary;
}): SandboxSettingsSeed {
  const enablePi =
    input.harnesses.includes("pi") &&
    !Object.hasOwn(input.sandbox.providerInstances, PI_INSTANCE_ID) &&
    isManagedDriverAllowed(input.sandboxPolicy, PI_DRIVER);
  const providerInstanceIds = enablePi
    ? new Set([...input.sandboxProviderInstanceIds, PI_INSTANCE_ID])
    : input.sandboxProviderInstanceIds;
  const patch: Record<string, unknown> = {};
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    const value = input.local[key];
    if (Equal.equals(value, DEFAULT_SERVER_SETTINGS[key])) continue;
    if (!Equal.equals(input.sandbox[key], DEFAULT_SERVER_SETTINGS[key])) continue;
    if (isManagedSettingPath(input.sandboxPolicy, key)) continue;
    if ((MODEL_SELECTION_KEYS as ReadonlyArray<string>).includes(key)) {
      const selection = input.local[key as (typeof MODEL_SELECTION_KEYS)[number]];
      if (selection !== null && !providerInstanceIds.has(String(selection.instanceId))) {
        continue;
      }
    }
    patch[key] = value;
  }
  // Not project-scoped, but this computer can only link a Sandbox that has it on.
  if (
    input.local.linkedEnvironmentsEnabled &&
    !input.sandbox.linkedEnvironmentsEnabled &&
    !isManagedSettingPath(input.sandboxPolicy, "linkedEnvironmentsEnabled")
  ) {
    patch.linkedEnvironmentsEnabled = true;
  }
  return {
    patch: patch as ServerSettingsPatch,
    ...(enablePi
      ? {
          providerInstanceMutation: {
            // The server refuses to create over an entry, so a Pi choice made in the
            // Sandbox since its settings were read is kept.
            operation: "create",
            instanceId: PI_INSTANCE_ID,
            instance: { driver: PI_DRIVER, enabled: true },
          },
        }
      : {}),
  };
}
