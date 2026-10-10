import type {
  McpServerProjectOverride,
  ProjectId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";

/**
 * Settings patches for Settings → Tools, shared by the web page and the
 * agents' `t3_tools_update` tool so both write the same overrides. A project
 * patch replaces that project's whole entry, so each one is built from the
 * current settings rather than merged later.
 */

type ToolsSettings = Pick<
  ServerSettings,
  "disabledSkills" | "mcpServers" | "projectSettingsOverrides"
>;

/** One project's override entry with `key` replaced, dropping what became empty. */
export function projectOverridePatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  key: "mcpServers" | "disabledSkills",
  value: Readonly<Record<string, unknown>>,
): ServerSettingsPatch {
  const { [key]: _previous, ...rest } = settings.projectSettingsOverrides[projectId] ?? {};
  const next = Object.keys(value).length === 0 ? rest : { ...rest, [key]: value };
  return {
    projectSettingsOverrides: {
      [projectId]: Object.keys(next).length === 0 ? null : next,
    },
  } as ServerSettingsPatch;
}

/** The environment's list with one skill switched. Sorted so equal lists compare equal. */
function withSkillDisabled(
  disabledSkills: ReadonlyArray<string>,
  name: string,
  disabled: boolean,
): ReadonlyArray<string> {
  const next = new Set(
    disabledSkills.filter((entry) => entry.toLowerCase() !== name.toLowerCase()),
  );
  if (disabled) next.add(name);
  return [...next].sort();
}

export function isSkillDisabled(disabledSkills: ReadonlyArray<string>, name: string): boolean {
  const lowered = name.toLowerCase();
  return disabledSkills.some((entry) => entry.toLowerCase() === lowered);
}

/**
 * Switch skills on or off for the environment, or for one project. A project
 * switch that matches the environment is dropped, since it overrides nothing.
 */
export function skillsDisabledPatch(
  settings: ToolsSettings,
  projectId: ProjectId | null,
  names: ReadonlyArray<string>,
  disabled: boolean,
): ServerSettingsPatch {
  if (projectId === null) {
    return {
      disabledSkills: [
        ...names.reduce(
          (list, name) => withSkillDisabled(list, name, disabled),
          settings.disabledSkills,
        ),
      ],
    };
  }
  const switches = { ...settings.projectSettingsOverrides[projectId]?.disabledSkills };
  for (const name of names) {
    delete switches[name];
    if (disabled !== isSkillDisabled(settings.disabledSkills, name)) switches[name] = disabled;
  }
  return projectOverridePatch(settings, projectId, "disabledSkills", switches);
}

/**
 * Switch an MCP server on or off for the environment, or for one project.
 * Null when the environment has no server of that name. A project's own server
 * keeps its definition; an inherited one gets a switch, or loses it when it
 * matches the environment again.
 */
export function mcpServerEnabledPatch(
  settings: ToolsSettings,
  projectId: ProjectId | null,
  name: string,
  enabled: boolean,
): ServerSettingsPatch | null {
  const inherited = settings.mcpServers[name];
  if (projectId === null) {
    return inherited ? { mcpServers: { [name]: { ...inherited, enabled } } } : null;
  }
  const entries: Record<string, McpServerProjectOverride> = {
    ...settings.projectSettingsOverrides[projectId]?.mcpServers,
  };
  const own = entries[name];
  if (own?.transport !== undefined) {
    entries[name] = { ...own, enabled };
  } else if (inherited === undefined) {
    return null;
  } else if (inherited.enabled === enabled) {
    delete entries[name];
  } else {
    entries[name] = { enabled };
  }
  return projectOverridePatch(settings, projectId, "mcpServers", entries);
}
