import {
  DEFAULT_SERVER_SETTINGS,
  isManagedSettingPath,
  isNullableProjectSettingsOverride,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type EnvironmentId,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@lathe/contracts";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
} from "@lathe/shared/projectSettings";

import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import type { SettingsTarget } from "./settings-environment-filter";

/** Environment settings plus the keys a project can override without an environment value. */
export type MobileScopedSettingsPatch = ServerSettingsPatch &
  Partial<
    Pick<ProjectSettingsOverrides, Exclude<ProjectScopedServerSettingKey, keyof ServerSettings>>
  >;

// Override-only keys, such as the GitHub account, have no environment write to land in.
const PROJECT_ONLY_KEYS = new Set<string>(
  PROJECT_SCOPED_SERVER_SETTING_KEYS.filter((key) => !(key in DEFAULT_SERVER_SETTINGS)),
);

export interface ScopedMobileSettingsTarget {
  readonly environment: SettingsTarget;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings;
  readonly sources: ReturnType<typeof resolveProjectSettings>["sources"];
}

/**
 * "Managed by <organization>." when any target's policy locks `path`: the server refuses the
 * whole write then, so the control is managed for the selection.
 */
export function managedSettingReason(
  targets: readonly ScopedMobileSettingsTarget[],
  paths: readonly string[],
  resolve: MessageResolver = m,
): string | undefined {
  const policy = targets
    .map((target) => target.environment.serverConfig.managedPolicy)
    .find((candidate) => paths.some((path) => isManagedSettingPath(candidate, path)));
  return policy === undefined
    ? undefined
    : resolve(msg("Managed by {organization}.", { organization: policy.organization }));
}

export function resolveMobileSettingsTargets(
  environments: readonly SettingsTarget[],
  members: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[] | null,
): readonly ScopedMobileSettingsTarget[] {
  if (members === null) {
    return environments.map((environment) => ({
      environment,
      projectId: null,
      ...resolveProjectSettings(environment.serverConfig.settings, null),
    }));
  }
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  return members.flatMap((member) => {
    const environment = byId.get(member.environmentId);
    if (!environment) return [];
    return [
      {
        environment,
        projectId: member.id,
        ...resolveProjectSettings(environment.serverConfig.settings, member.id),
      },
    ];
  });
}

export function planMobileScopedSettingsPatch(
  targets: readonly ScopedMobileSettingsTarget[],
  projectSelected: boolean,
  patch: MobileScopedSettingsPatch,
) {
  if (!projectSelected) {
    const environmentPatch = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !PROJECT_ONLY_KEYS.has(key)),
    ) as ServerSettingsPatch;
    if (Object.keys(environmentPatch).length === 0) return [];
    return targets.map((target) => ({
      environmentId: target.environment.environmentId,
      patch: environmentPatch,
    }));
  }
  const keys = Object.keys(patch);
  if (
    keys.some(
      (key) => !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(key as ProjectScopedServerSettingKey),
    )
  )
    return [];
  const writes = new Map<EnvironmentId, Record<string, unknown>>();
  for (const target of targets) {
    if (target.projectId === null) continue;
    const current =
      target.environment.serverConfig.settings.projectSettingsOverrides[target.projectId] ?? {};
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (
        value === null &&
        !isNullableProjectSettingsOverride(key as ProjectScopedServerSettingKey)
      ) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    const overrides = writes.get(target.environment.environmentId) ?? {};
    overrides[target.projectId] = next;
    writes.set(target.environment.environmentId, overrides);
  }
  return [...writes].map(([environmentId, projectSettingsOverrides]) => ({
    environmentId,
    patch: { projectSettingsOverrides } as ServerSettingsPatch,
  }));
}

export function uniformMobileSetting<K extends keyof ServerSettings>(
  targets: readonly Pick<ScopedMobileSettingsTarget, "settings">[],
  key: K,
): ServerSettings[K] | null {
  const reference = targets[0];
  if (!reference) return null;
  const value = reference.settings[key];
  return targets.every((target) => target.settings[key] === value) ? value : null;
}

export function planMobileScopedSettingsClear(
  targets: readonly ScopedMobileSettingsTarget[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const writes = new Map<EnvironmentId, Record<string, unknown>>();
  for (const target of targets) {
    if (target.projectId === null) continue;
    const overrides = writes.get(target.environment.environmentId) ?? {};
    overrides[target.projectId] = clearProjectSettingsOverrides(
      target.environment.serverConfig.settings,
      target.projectId,
      keys,
    );
    writes.set(target.environment.environmentId, overrides);
  }
  return [...writes].map(([environmentId, projectSettingsOverrides]) => ({
    environmentId,
    patch: { projectSettingsOverrides } as ServerSettingsPatch,
  }));
}
