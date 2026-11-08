import type {
  McpServerProjectOverride,
  ProjectId,
  ServerSettings,
  ServerSettingsPatch,
  ThreadToolPresets,
  ToolPreset,
  ToolPresets,
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
  // Null-prototype, so a skill named like an Object property (`__proto__`) is a key like any other.
  const switches: Record<string, boolean> = Object.assign(
    Object.create(null),
    settings.projectSettingsOverrides[projectId]?.disabledSkills,
  );
  for (const name of names) {
    // One switch per name, whatever its case.
    for (const existing of Object.keys(switches)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete switches[existing];
    }
    // Spelled as the environment spells it, so the switch reads as the same skill.
    const spelling =
      settings.disabledSkills.find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? name;
    if (disabled !== isSkillDisabled(settings.disabledSkills, name)) switches[spelling] = disabled;
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
  // Own keys only: `constructor` must not read as a server the object inherits.
  const inherited = Object.hasOwn(settings.mcpServers, name)
    ? settings.mcpServers[name]
    : undefined;
  if (projectId === null) {
    return inherited ? { mcpServers: { [name]: { ...inherited, enabled } } } : null;
  }
  const entries: Record<string, McpServerProjectOverride> = {
    ...settings.projectSettingsOverrides[projectId]?.mcpServers,
  };
  const own = Object.hasOwn(entries, name) ? entries[name] : undefined;
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

const lower = (name: string) => name.toLowerCase();

/** Equal switches whatever their key order; absent reads as empty. */
export function threadToolPresetsEqual(
  left: ThreadToolPresets | undefined,
  right: ThreadToolPresets | undefined,
): boolean {
  const entries = Object.entries(left ?? {});
  const other = right ?? {};
  return (
    entries.length === Object.keys(other).length &&
    entries.every(([name, on]) => Object.hasOwn(other, name) && other[name] === on)
  );
}

type EffectiveTools = Pick<ServerSettings, "disabledSkills" | "mcpServers">;

/**
 * Settings' tools with a thread's presets applied. A preset switched on turns
 * its skills and servers on, one switched off turns them off, and on wins
 * where two presets share a tool. Servers the settings don't define are skipped.
 */
export function applyThreadToolPresets<Tools extends EffectiveTools>(
  effective: Tools,
  presets: ToolPresets,
  switches: ThreadToolPresets | undefined,
): Tools {
  const members = (on: boolean) =>
    Object.entries(switches ?? {}).flatMap(([name, switched]) =>
      switched === on && Object.hasOwn(presets, name) ? [presets[name]!] : [],
    );
  const turnedOn = members(true);
  const turnedOff = members(false);
  if (turnedOn.length === 0 && turnedOff.length === 0) return effective;
  const skillsOn = new Set(turnedOn.flatMap((preset) => preset.skills.map(lower)));
  const serversOn = new Set(turnedOn.flatMap((preset) => preset.mcpServers));
  const serversOff = new Set(turnedOff.flatMap((preset) => preset.mcpServers));
  const disabledSkills = effective.disabledSkills.filter((name) => !skillsOn.has(lower(name)));
  for (const name of turnedOff.flatMap((preset) => preset.skills)) {
    if (!skillsOn.has(lower(name)) && !isSkillDisabled(disabledSkills, name)) {
      disabledSkills.push(name);
    }
  }
  const mcpServers = Object.fromEntries(
    Object.entries(effective.mcpServers).map(([name, server]) => [
      name,
      serversOn.has(name)
        ? { ...server, enabled: true }
        : serversOff.has(name)
          ? { ...server, enabled: false }
          : server,
    ]),
  ) as Tools["mcpServers"];
  return { ...effective, disabledSkills, mcpServers };
}

/**
 * Whether a preset's tools are on as settings have them. Servers the
 * settings don't define don't count; a preset with nothing left is off.
 */
export function toolPresetState(
  effective: EffectiveTools,
  preset: ToolPreset,
): "on" | "off" | "mixed" {
  const states = [
    ...preset.skills.map((name) => !isSkillDisabled(effective.disabledSkills, name)),
    ...preset.mcpServers.flatMap((name) =>
      Object.hasOwn(effective.mcpServers, name) ? [effective.mcpServers[name]!.enabled] : [],
    ),
  ];
  if (states.length > 0 && states.every(Boolean)) return "on";
  return states.some(Boolean) ? "mixed" : "off";
}

/**
 * A thread's switches with one preset set: a switch that matches what
 * settings already give is dropped, so the thread follows settings again.
 */
export function withThreadToolPreset(
  switches: ThreadToolPresets | undefined,
  name: string,
  on: boolean,
  settingsState: "on" | "off" | "mixed",
): ThreadToolPresets {
  const { [name]: _previous, ...rest } = switches ?? {};
  return settingsState === (on ? "on" : "off") ? rest : { ...rest, [name]: on };
}
