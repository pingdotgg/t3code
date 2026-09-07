/**
 * Shared server settings.
 *
 * Every server keeps its own `settings.json`, but some keys are user
 * preferences that only live on the server because the server has to act on
 * them (auto-settlement runs with no client attached). A user does not want
 * those to differ per machine. Clients write these keys to every shared-settings
 * sync target, and warn when another target still holds a different value so
 * the user can push their current value out.
 */
import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Struct from "effect/Struct";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

/** Server keys that hold a user preference rather than machine config. */
const SHARED_SERVER_SETTING_KEYS = [
  "continueThreadsAfterServerUpdate",
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "newWorktreesStartFromOrigin",
  "sourceControlWritingStyle",
] as const satisfies ReadonlyArray<keyof ServerSettings & keyof ServerSettingsPatch>;

export type SharedServerSettingKey = (typeof SHARED_SERVER_SETTING_KEYS)[number];

export const sharedServerSettingLabels: Record<SharedServerSettingKey, string> = {
  continueThreadsAfterServerUpdate: "Continue threads after server updates",
  sidebarAutoSettleAfterDays: "Auto-settle inactive threads",
  sidebarAutoSettleOnMerge: "Auto-settle merged threads",
  newWorktreesStartFromOrigin: "Start new worktrees from origin",
  sourceControlWritingStyle: "Source control writing style",
};

export function formatSharedServerSettingValue(
  key: SharedServerSettingKey,
  value: ServerSettings[SharedServerSettingKey],
): string {
  if (value === null) return "Off";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "object") {
    const modes = {
      conventional_commits: "Conventional commits",
      custom: "Custom",
      repo_conventions: "Repository conventions",
    };
    return `${modes[value.mode]}\nCustom instructions: ${value.customInstructions || "None"}\nFollow change request templates: ${value.followChangeRequestTemplates ? "On" : "Off"}`;
  }
  if (key === "sidebarAutoSettleAfterDays") return `After ${value} ${value === 1 ? "day" : "days"}`;
  return String(value);
}

export interface SharedSettingsMismatch {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly differences: ReadonlyArray<{
    readonly key: SharedServerSettingKey;
    readonly currentValue: ServerSettings[SharedServerSettingKey];
    readonly incomingValue: ServerSettings[SharedServerSettingKey];
  }>;
}

const SHARED_KEY_SET = new Set<string>(SHARED_SERVER_SETTING_KEYS);

/** Split a server patch into the keys every environment should receive and the primary-only rest. */
export function splitSharedServerPatch(patch: ServerSettingsPatch): {
  sharedPatch: ServerSettingsPatch;
  localPatch: ServerSettingsPatch;
} {
  const sharedPatch: Record<string, unknown> = {};
  const localPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SHARED_KEY_SET.has(key)) {
      sharedPatch[key] = value;
    } else {
      localPatch[key] = value;
    }
  }
  return {
    sharedPatch: sharedPatch as ServerSettingsPatch,
    localPatch: localPatch as ServerSettingsPatch,
  };
}

/** Omit restart recovery on servers that cannot persist its preference. */
export function filterSharedServerPatch(
  patch: ServerSettingsPatch,
  capabilities: Pick<ExecutionEnvironmentCapabilities, "threadRestartContinuation"> | undefined,
): ServerSettingsPatch {
  return capabilities?.threadRestartContinuation === true
    ? patch
    : Struct.omit(patch, ["continueThreadsAfterServerUpdate"]);
}

/** The shared subset supported by one environment. */
export function pickSharedServerSettings(
  settings: ServerSettings,
  capabilities?: Pick<ExecutionEnvironmentCapabilities, "threadRestartContinuation">,
): ServerSettingsPatch {
  return filterSharedServerPatch(Struct.pick(settings, SHARED_SERVER_SETTING_KEYS), capabilities);
}

/**
 * Whether an environment can participate in shared-settings sync right now.
 * Auto-settlement establishes baseline support; newer preferences are filtered separately.
 */
export function supportsSharedSettingsSync(environment: {
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: Pick<ExecutionEnvironmentCapabilities, "threadAutoSettlement">;
    };
  } | null;
}): boolean {
  return (
    environment.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.threadAutoSettlement === true
  );
}

export interface SharedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly syncEligible: boolean;
  readonly settings: ServerSettings | null;
  readonly capabilities?:
    | Pick<ExecutionEnvironmentCapabilities, "threadRestartContinuation">
    | undefined;
}

/**
 * Shared-settings sync targets whose values differ from the primary
 * environment's. Other environments are skipped: nothing can be read from or
 * written to them, or their server lacks baseline shared-settings support. With no
 * primary settings loaded there is nothing to compare against, so nothing is
 * reported. Callers must pass the real loaded settings, never a default
 * fallback, or "apply to all" would push defaults over real values.
 */
export function findSharedSettingsMismatches(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly primarySettings: ServerSettings | null;
  readonly primaryCapabilities?:
    | Pick<ExecutionEnvironmentCapabilities, "threadRestartContinuation">
    | undefined;
  readonly environments: ReadonlyArray<SharedSettingsEnvironment>;
}): ReadonlyArray<SharedSettingsMismatch> {
  if (input.primaryEnvironmentId === null || input.primarySettings === null) {
    return [];
  }
  const loadedPrimarySettings = input.primarySettings;
  const primarySettings = pickSharedServerSettings(
    loadedPrimarySettings,
    input.primaryCapabilities,
  );
  return input.environments.flatMap((environment) => {
    if (
      environment.environmentId === input.primaryEnvironmentId ||
      !environment.syncEligible ||
      environment.settings === null
    ) {
      return [];
    }
    const expected = filterSharedServerPatch(primarySettings, environment.capabilities);
    const loadedSettings = environment.settings;
    const actual = filterSharedServerPatch(
      pickSharedServerSettings(environment.settings, environment.capabilities),
      input.primaryCapabilities,
    );
    const differences = SHARED_SERVER_SETTING_KEYS.flatMap((key) => {
      const currentValue = actual[key];
      const incomingValue = expected[key];
      return currentValue === undefined ||
        incomingValue === undefined ||
        Equal.equals(currentValue, incomingValue)
        ? []
        : [{ key, currentValue: loadedSettings[key], incomingValue: loadedPrimarySettings[key] }];
    });
    return differences.length === 0
      ? []
      : [{ environmentId: environment.environmentId, label: environment.label, differences }];
  });
}
