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
export const SHARED_SERVER_SETTING_KEYS = [
  "sidebarAutoSettleAfterDays",
  "sidebarAutoSettleOnMerge",
  "defaultThreadEnvMode",
  "newWorktreesStartFromOrigin",
  "sourceControlWritingStyle",
] as const satisfies ReadonlyArray<keyof ServerSettings & keyof ServerSettingsPatch>;

export type SharedServerSettingKey = (typeof SHARED_SERVER_SETTING_KEYS)[number];

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

/** The shared subset of one environment's settings, as a patch that can be written elsewhere. */
export function pickSharedServerSettings(settings: ServerSettings): ServerSettingsPatch {
  return Struct.pick(settings, SHARED_SERVER_SETTING_KEYS);
}

/**
 * Whether an environment can participate in shared-settings sync right now.
 * Auto-settlement is the newest feature backed by a shared key, so a server
 * advertising `threadAutoSettlement` can hold every shared key.
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
}

/**
 * Shared-settings sync targets whose values differ from the primary
 * environment's. Other environments are skipped: nothing can be read from or
 * written to them, or their server cannot hold every shared key. With no
 * primary settings loaded there is nothing to compare against, so nothing is
 * reported. Callers must pass the real loaded settings, never a default
 * fallback, or "apply to all" would push defaults over real values.
 */
export function findSharedSettingsMismatches(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly primarySettings: ServerSettings | null;
  readonly environments: ReadonlyArray<SharedSettingsEnvironment>;
}): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }> {
  if (input.primaryEnvironmentId === null || input.primarySettings === null) {
    return [];
  }
  const expected = pickSharedServerSettings(input.primarySettings);
  return input.environments.flatMap((environment) => {
    if (
      environment.environmentId === input.primaryEnvironmentId ||
      !environment.syncEligible ||
      environment.settings === null
    ) {
      return [];
    }
    const actual = pickSharedServerSettings(environment.settings);
    return Equal.equals(actual, expected)
      ? []
      : [{ environmentId: environment.environmentId, label: environment.label }];
  });
}
