import type {
  BranchNamingMode,
  ClientServerSettingsPatch,
  ProjectId,
  ProjectScript,
  ProjectSettingsOverrides,
  ServerSettings,
  StorageCleanupReport,
  StorageCleanupReportEntry,
  WorktreeCleanup,
  WorktreeCleanupRules,
} from "@t3tools/contracts";

/** What `server.updateSettings` takes. */
export interface SettingsInput {
  readonly patch: typeof ClientServerSettingsPatch.Type;
}

type OverrideEntry = NonNullable<
  NonNullable<(typeof ClientServerSettingsPatch.Type)["projectSettingsOverrides"]>[ProjectId]
>;

/** The project a page edits, or null for the environment's own defaults. */
export interface ProjectRef {
  readonly id: ProjectId;
  readonly scripts: ReadonlyArray<ProjectScript>;
}

/** `inherited` is true only for a project that follows the environment. */
export interface Field<T> {
  readonly value: T;
  readonly inherited: boolean;
}

function field<T>(
  project: ProjectRef | null,
  inheritedValue: T,
  override: T | undefined,
): Field<T> {
  return override === undefined
    ? { value: inheritedValue, inherited: project !== null }
    : { value: override, inherited: false };
}

// Mirrors the engine's resolution, which a project follows until it holds its own list.
function scriptsFor(
  settings: ServerSettings,
  project: ProjectRef | null,
): ReadonlyArray<ProjectScript> {
  if (project === null) return settings.defaultProjectScripts;
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

// SAFETY: a stored entry may hold the legacy writing-style form the patch refuses, but the engine
// rewrites whole entries and nothing here sets that key.
const asPatchEntry = (entry: ProjectSettingsOverrides): OverrideEntry => entry as OverrideEntry;

const withoutKeys = (entry: ProjectSettingsOverrides, keys: ReadonlyArray<string>): OverrideEntry =>
  // SAFETY: filtering a stored entry keeps a subset of its own keys and values, so it stays an entry.
  Object.fromEntries(Object.entries(entry).filter(([key]) => !keys.includes(key))) as OverrideEntry;

function overridePatch(
  settings: ServerSettings,
  projectId: ProjectId,
  changes: ProjectSettingsOverrides,
): SettingsInput {
  return {
    patch: {
      projectSettingsOverrides: {
        [projectId]: asPatchEntry({ ...settings.projectSettingsOverrides[projectId], ...changes }),
      },
    },
  };
}

/** Drops overrides so the project follows the environment again. */
export function resetOverride(
  settings: ServerSettings,
  projectId: ProjectId,
  keys: ReadonlyArray<keyof ProjectSettingsOverrides>,
): SettingsInput {
  const entry = settings.projectSettingsOverrides[projectId];
  const next = entry === undefined ? {} : withoutKeys(entry, keys);
  return {
    patch: {
      projectSettingsOverrides: {
        [projectId]: Object.keys(next).length === 0 ? null : next,
      },
    },
  };
}

export interface WorktreeValues {
  readonly setupScript: Field<string>;
  readonly branchNamingMode: Field<BranchNamingMode>;
  readonly branchNamePrefix: Field<string>;
  readonly branchNameInstructions: Field<string>;
  /** Per machine, so a project cannot override it. */
  readonly worktreesDirectory: string;
}

export function worktreeValues(
  settings: ServerSettings,
  project: ProjectRef | null,
): WorktreeValues {
  const entry = project === null ? undefined : settings.projectSettingsOverrides[project.id];
  return {
    setupScript: {
      value:
        scriptsFor(settings, project).find((script) => script.runOnWorktreeCreate)?.command ?? "",
      inherited: project !== null && entry?.defaultProjectScripts === undefined,
    },
    branchNamingMode: field(project, settings.branchNamingMode, entry?.branchNamingMode),
    branchNamePrefix: field(project, settings.branchNamePrefix, entry?.branchNamePrefix),
    branchNameInstructions: field(
      project,
      settings.branchNameInstructions,
      entry?.branchNameInstructions,
    ),
    worktreesDirectory: settings.worktreesDirectory,
  };
}

function nextScriptId(settings: ServerSettings, project: ProjectRef | null): string {
  const taken = new Set(
    [
      ...settings.defaultProjectScripts,
      ...Object.values(settings.projectSettingsOverrides).flatMap(
        (entry) => entry.defaultProjectScripts ?? [],
      ),
      ...(project?.scripts ?? []),
    ].map((script) => script.id),
  );
  let id = "setup";
  for (let n = 2; taken.has(id); n += 1) id = `setup-${n}`;
  return id;
}

/**
 * Edits the script T3 runs when it creates a worktree and keeps the other actions. An empty
 * command removes the setup script.
 */
export function saveSetupScript(
  settings: ServerSettings,
  project: ProjectRef | null,
  command: string,
): SettingsInput {
  const scripts = scriptsFor(settings, project);
  const text = command.trim();
  const current = scripts.find((script) => script.runOnWorktreeCreate);
  let next: ReadonlyArray<ProjectScript>;
  if (current === undefined) {
    next =
      text === ""
        ? scripts
        : [
            ...scripts,
            {
              id: nextScriptId(settings, project),
              name: "Setup",
              command: text,
              icon: "configure",
              runOnWorktreeCreate: true,
            },
          ];
  } else {
    next =
      text === ""
        ? scripts.filter((script) => script !== current)
        : scripts.map((script) => (script === current ? { ...script, command: text } : script));
  }
  return project === null
    ? { patch: { defaultProjectScripts: next } }
    : overridePatch(settings, project.id, { defaultProjectScripts: next });
}

export interface BranchNamingChange {
  readonly branchNamingMode?: BranchNamingMode;
  readonly branchNamePrefix?: string;
  readonly branchNameInstructions?: string;
}

export function saveBranchNaming(
  settings: ServerSettings,
  project: ProjectRef | null,
  change: BranchNamingChange,
): SettingsInput {
  const trimmed = {
    ...change,
    ...(change.branchNamePrefix === undefined
      ? {}
      : { branchNamePrefix: change.branchNamePrefix.trim() }),
    ...(change.branchNameInstructions === undefined
      ? {}
      : { branchNameInstructions: change.branchNameInstructions.trim() }),
  };
  return project === null ? { patch: trimmed } : overridePatch(settings, project.id, trimmed);
}

export function saveWorktreesDirectory(path: string): SettingsInput {
  return { patch: { worktreesDirectory: path.trim() } };
}

/** T3's switch for provider version checks, shared by every client of the engine. */
export function saveProviderUpdateChecks(enabled: boolean): SettingsInput {
  return { patch: { enableProviderUpdateChecks: enabled } };
}

export type CleanupMode = "inherit" | "off" | "custom";

export interface CleanupValues {
  /** Null for the environment, which has no policy above it. */
  readonly mode: CleanupMode | null;
  readonly rules: WorktreeCleanupRules;
  /** False while the rules are fixed by a policy or by the project's Off or Inherit choice. */
  readonly editable: boolean;
}

function rulesFor(settings: ServerSettings, policy: WorktreeCleanup): WorktreeCleanupRules {
  if (policy?.mode === "custom") return policy.rules;
  const { storageCleanup } = settings;
  if (policy?.mode === "off") {
    return {
      worktreeKeepWhen: storageCleanup.worktreeKeepWhen,
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
    };
  }
  return {
    worktreeKeepWhen: storageCleanup.worktreeKeepWhen,
    worktreeAfterDays: storageCleanup.worktreeAfterDays,
    worktreeSettledAfterDays: storageCleanup.worktreeSettledAfterDays,
    worktreeOnMerge: storageCleanup.worktreeOnMerge,
    worktreeOnDelete: storageCleanup.worktreeOnDelete,
    worktreeUnchanged: storageCleanup.worktreeUnchanged,
  };
}

export function cleanupValues(
  settings: ServerSettings,
  projectId: ProjectId | null,
): CleanupValues {
  if (projectId === null) {
    return {
      mode: null,
      rules: rulesFor(settings, settings.worktreeCleanup),
      editable: settings.worktreeCleanup === null,
    };
  }
  const override = settings.projectSettingsOverrides[projectId]?.worktreeCleanup;
  const mode = override?.mode ?? "inherit";
  return {
    mode,
    rules: rulesFor(settings, override ?? settings.worktreeCleanup),
    editable: mode === "custom",
  };
}

export function saveCleanupRules(
  settings: ServerSettings,
  projectId: ProjectId | null,
  change: Partial<WorktreeCleanupRules>,
): SettingsInput {
  if (projectId === null) return { patch: { storageCleanup: change } };
  return overridePatch(settings, projectId, {
    worktreeCleanup: {
      mode: "custom",
      rules: { ...cleanupValues(settings, projectId).rules, ...change },
    },
  });
}

export function saveCleanupMode(
  settings: ServerSettings,
  projectId: ProjectId,
  mode: CleanupMode,
): SettingsInput {
  if (mode === "inherit") return resetOverride(settings, projectId, ["worktreeCleanup"]);
  return overridePatch(settings, projectId, {
    worktreeCleanup:
      mode === "off"
        ? { mode: "off" }
        : { mode: "custom", rules: cleanupValues(settings, projectId).rules },
  });
}

const rulesEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeSettledAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

/** Delete now runs the enabled rules, so it has nothing to do while every rule is off. */
export function hasCleanupRules(settings: ServerSettings): boolean {
  return (
    settings.storageCleanup.browserArtifactsAfterDays !== null ||
    settings.storageCleanup.logsAfterDays !== null ||
    rulesEnabled(rulesFor(settings, settings.worktreeCleanup)) ||
    Object.values(settings.projectSettingsOverrides).some(
      (entry) =>
        entry.worktreeCleanup?.mode === "custom" && rulesEnabled(entry.worktreeCleanup.rules),
    )
  );
}

/** A retention field holds whole days. Empty turns the rule off, and anything else is refused. */
export function parseDays(text: string, minimum: number): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const days = Number(trimmed);
  return Number.isInteger(days) && days >= minimum && days <= 3650 ? days : "invalid";
}

export function reportEntryName(entry: StorageCleanupReportEntry): string {
  if (entry.kind === "logs") return "Rotated logs";
  if (entry.kind === "browser-artifacts") return "Browser artifacts";
  return entry.path?.split(/[\\/]/).findLast(Boolean) ?? "Worktree";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The report with the later finish, since a run's reply and the engine's push can arrive in either order. */
export function latestReport(
  first: StorageCleanupReport | null,
  second: StorageCleanupReport | null,
): StorageCleanupReport | null {
  if (first === null || second === null) return first ?? second;
  return second.finishedAt > first.finishedAt ? second : first;
}

export function removedWorktreePaths(report: StorageCleanupReport | null): ReadonlySet<string> {
  return new Set(
    (report?.entries ?? []).flatMap((entry) =>
      entry.kind === "worktree" && entry.outcome === "removed" && entry.path !== null
        ? [entry.path]
        : [],
    ),
  );
}
