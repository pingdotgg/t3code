import {
  type ModelSelection,
  PROJECT_FILE_BACKED_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type ProjectFileBackedSettingKey,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ProjectSettingsOverrides,
  resolveProjectProviderInstanceEnabled,
  type ResolvedServerSettings,
  type ServerSettings,
  type T3ProjectFile,
  type ThreadEnvMode,
  type WorktreeCleanupRules,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "./path.ts";
import { fallbackTextGenerationModelSelection } from "./serverSettings.ts";

export type ProjectSettingSource = "environment" | "project" | "t3.json";

export type ProjectSettingSources = Readonly<
  Record<ProjectScopedServerSettingKey, ProjectSettingSource>
>;

export interface ResolvedProjectSettings<Settings extends ServerSettings = ServerSettings> {
  readonly settings: Settings;
  readonly sources: ProjectSettingSources;
  readonly overrides: ProjectSettingsOverrides;
}

const EMPTY_OVERRIDES: ProjectSettingsOverrides = {};

const ENVIRONMENT_SOURCES: ProjectSettingSources = Object.fromEntries(
  PROJECT_SCOPED_SERVER_SETTING_KEYS.map((key) => [key, "environment"]),
) as Record<ProjectScopedServerSettingKey, ProjectSettingSource>;

export function hasProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): boolean {
  for (const entry of Object.values(settings.projectSettingsOverrides)) {
    // A forward-compatible decode can leave an unknown value as a present
    // undefined; that is not an override.
    if (Object.values(entry).some((value) => value !== undefined)) return true;
  }
  return false;
}

/**
 * The project aggregate's own model and workspace fields. They remain the
 * source of truth until the server has folded them into the override record;
 * after the fold the record alone decides, so a reset there cannot be undone
 * by a stale aggregate value.
 */
export interface LegacyProjectSettingsFields {
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null | undefined;
}

export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings;
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project: LegacyProjectSettingsFields | null | undefined,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings<ResolvedServerSettings>;
export function resolveProjectSettings(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
  projectFile?: T3ProjectFile | null,
): ResolvedProjectSettings {
  const resolved = resolveProjectOverrides(settings, projectId, project);
  return projectFile === undefined ? resolved : applyProjectFile(resolved, projectFile);
}

function applyProjectFile(
  resolved: ResolvedProjectSettings,
  projectFile: T3ProjectFile | null,
): ResolvedProjectSettings {
  let effective: Record<string, unknown> | null = null;
  let sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> | null = null;
  for (const key of Object.keys(PROJECT_FILE_BACKED_SETTINGS) as ProjectFileBackedSettingKey[]) {
    if (resolved.settings[key] !== null) continue;
    const { value, source } = resolveProjectFileBackedSetting(key, null, projectFile);
    effective ??= { ...resolved.settings };
    sources ??= { ...resolved.sources };
    effective[key] = value;
    sources[key] = source;
  }
  return effective === null || sources === null
    ? resolved
    : { ...resolved, settings: effective as ServerSettings, sources };
}

export function resolveProjectFileBackedSetting<K extends ProjectFileBackedSettingKey>(
  key: K,
  setting: ServerSettings[K],
  projectFile: T3ProjectFile | null,
): { value: ResolvedServerSettings[K]; source: ProjectSettingSource } {
  if (setting !== null) {
    return { value: setting as ResolvedServerSettings[K], source: "environment" };
  }
  const { field, builtIn } = PROJECT_FILE_BACKED_SETTINGS[key];
  const fromFile = projectFile?.[field] as ResolvedServerSettings[K] | undefined;
  return fromFile === undefined
    ? { value: builtIn as ResolvedServerSettings[K], source: "environment" }
    : { value: fromFile, source: "t3.json" };
}

function resolveProjectOverrides(
  settings: ServerSettings,
  projectId: ProjectId | null,
  project?: LegacyProjectSettingsFields | null,
): ResolvedProjectSettings {
  const stored = projectId === null ? undefined : settings.projectSettingsOverrides[projectId];
  const overrides: ProjectSettingsOverrides =
    project == null || settings.projectSettingsFolded
      ? (stored ?? EMPTY_OVERRIDES)
      : {
          ...(project.defaultModelSelection != null
            ? { defaultModelSelection: project.defaultModelSelection }
            : {}),
          ...(project.defaultThreadEnvMode != null
            ? { defaultThreadEnvMode: project.defaultThreadEnvMode }
            : {}),
          ...stored,
        };
  if (Object.keys(overrides).length === 0) {
    return { settings, sources: ENVIRONMENT_SOURCES, overrides: EMPTY_OVERRIDES };
  }
  const sources: Record<ProjectScopedServerSettingKey, ProjectSettingSource> = {
    ...ENVIRONMENT_SOURCES,
  };
  const effective: Record<string, unknown> = { ...settings };
  for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    // A forward-compatible decode leaves an unknown value as a present
    // undefined; that is not an override.
    if (value === undefined) continue;
    if (
      (key === "textGenerationModelSelection" || key === "defaultModelSelection") &&
      value !== undefined &&
      value !== null &&
      !resolveProjectProviderInstanceEnabled(
        settings,
        projectId,
        (value as ModelSelection).instanceId,
      )
    ) {
      continue;
    }
    effective[key] = value;
    sources[key] = "project";
  }
  const textGeneration = effective.textGenerationModelSelection as ModelSelection;
  if (!resolveProjectProviderInstanceEnabled(settings, projectId, textGeneration.instanceId)) {
    const fallback = fallbackTextGenerationModelSelection(
      settings.providerInstances,
      (instanceId) => resolveProjectProviderInstanceEnabled(settings, projectId, instanceId),
      {
        includeConfiguredInstances: true,
        defaultModelSelection: effective.defaultModelSelection as ModelSelection | null,
      },
    );
    if (fallback !== null) effective.textGenerationModelSelection = fallback;
  }
  return { settings: effective as ServerSettings, sources, overrides };
}

/**
 * A project the environment made from just a name (a folder directly inside
 * `ServerConfig.newProjectsRoot`) has only its first commit, so until it has a
 * thread, a new thread works in the project checkout even when the environment
 * default is a new worktree.
 */
export function resolveNewThreadEnvMode(input: {
  readonly projectSettings: ResolvedProjectSettings<ResolvedServerSettings>;
  readonly workspaceRoot: string | null;
  readonly newProjectsRoot: string | null | undefined;
  readonly projectHasThreads: boolean;
}): ThreadEnvMode {
  const configured = input.projectSettings.settings.defaultThreadEnvMode;
  if (
    configured === "local" ||
    input.projectHasThreads ||
    input.projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    input.workspaceRoot === null ||
    input.newProjectsRoot == null
  ) {
    return configured;
  }
  const root = normalizeProjectPathForComparison(input.newProjectsRoot);
  const folder = normalizeProjectPathForComparison(input.workspaceRoot);
  const separator = root.includes("\\") ? "\\" : "/";
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`;
  const isNewProjectFolder =
    folder.startsWith(prefix) &&
    folder.length > prefix.length &&
    !folder.slice(prefix.length).includes(separator);
  return isNewProjectFolder ? "local" : configured;
}

export function withProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  next: ProjectSettingsOverrides | null,
): ServerSettings["projectSettingsOverrides"] {
  const { [projectId]: _removed, ...rest } = settings.projectSettingsOverrides;
  return next === null || Object.keys(next).length === 0 ? rest : { ...rest, [projectId]: next };
}

export function clearProjectSettingsOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  keys: readonly ProjectScopedServerSettingKey[],
): ProjectSettingsOverrides | null {
  const current = settings.projectSettingsOverrides[projectId];
  if (current === undefined) return null;
  const next = { ...current };
  for (const key of keys) delete next[key];
  return Object.keys(next).length === 0 ? null : next;
}

export function resolveWorktreeCleanup(
  settings: ServerSettings,
  projectId: ProjectId | null,
): WorktreeCleanupRules {
  const policy = resolveProjectSettings(settings, projectId).settings.worktreeCleanup;
  if (policy?.mode === "custom") return policy.rules;
  if (policy?.mode === "off")
    return {
      worktreeKeepWhen: settings.storageCleanup.worktreeKeepWhen,
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
    };
  const {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  } = settings.storageCleanup;
  return {
    worktreeKeepWhen,
    worktreeAfterDays,
    worktreeSettledAfterDays,
    worktreeOnMerge,
    worktreeOnDelete,
    worktreeUnchanged,
  };
}
