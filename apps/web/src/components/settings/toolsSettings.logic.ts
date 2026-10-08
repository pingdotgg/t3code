import {
  isValidMcpServerName,
  type McpServerConfig,
  type McpServerProjectOverride,
  type McpServerTransport,
  type McpServerVariable,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import {
  resolveProviderSkillSourceKind,
  resolveProviderSkillsForCwd,
} from "@t3tools/client-runtime/providerSkills";

export type ToolsTab = "skills" | "mcp";

export function validateToolsSearch(raw: Record<string, unknown>): { tab?: ToolsTab } {
  return raw.tab === "mcp" || raw.tab === "skills" ? { tab: raw.tab } : {};
}

/** Where a skill lives, the groups the Skills tab shows in order. */
export type SkillGroupKind = "project" | "personal" | "plugin" | "system";

export const SKILL_GROUP_LABELS: Readonly<Record<SkillGroupKind, string>> = {
  project: "Repository",
  personal: "Personal",
  plugin: "Plugins",
  system: "Built in",
};

export interface SkillProviderRef {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
}

/**
 * One row of the Skills tab: every provider instance that loads a skill of
 * this name, merged. Skills are switched by name, so two folders holding a
 * skill of the same name are one row; their paths are listed as copies.
 */
export interface SkillRow {
  readonly name: string;
  readonly description: string | undefined;
  readonly group: SkillGroupKind;
  readonly paths: ReadonlyArray<string>;
  readonly providers: ReadonlyArray<SkillProviderRef>;
  /** Off in the provider's own settings (e.g. Claude's `skillOverrides`). */
  readonly disabledByProvider: boolean;
}

function skillGroup(skill: ServerProviderSkill): SkillGroupKind {
  const path = skill.path.replaceAll("\\", "/");
  if (path.includes("/plugins/")) return "plugin";
  switch (resolveProviderSkillSourceKind(skill)) {
    case "project":
    case "repo":
      return "project";
    case "personal":
      return "personal";
    case "app":
      return "plugin";
    case "system":
    case "other":
      return skill.scope?.trim().toLowerCase() === "plugin" ? "plugin" : "system";
  }
}

const GROUP_ORDER: ReadonlyArray<SkillGroupKind> = ["project", "personal", "plugin", "system"];

const isFilePath = (path: string) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

/**
 * The skills every enabled provider instance on one environment discovers,
 * for the checkout at `cwd` when one is given (falling back to each
 * provider's own launch directory until its snapshot for `cwd` arrives).
 * A skill reached from a project folder by any provider counts as a project
 * skill, so the group follows the most specific location.
 */
export function collectSkillRows(
  providers: ReadonlyArray<ServerProvider>,
  cwd: string | null,
): ReadonlyArray<SkillRow> {
  const rows = new Map<
    string,
    {
      name: string;
      description: string | undefined;
      group: SkillGroupKind;
      paths: Set<string>;
      providers: Map<ProviderInstanceId, SkillProviderRef>;
      disabledByProvider: boolean;
    }
  >();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const skills = cwd === null ? provider.skills : resolveProviderSkillsForCwd(provider, cwd);
    for (const skill of skills) {
      const key = skill.name.trim().toLowerCase();
      if (key.length === 0) continue;
      const group = skillGroup(skill);
      const ref: SkillProviderRef = {
        instanceId: provider.instanceId,
        driver: provider.driver,
        displayName: provider.displayName ?? provider.instanceId,
      };
      // Pi reports a synthetic `pi:skill:<name>` id instead of a file.
      const path = isFilePath(skill.path) ? skill.path : null;
      const existing = rows.get(key);
      if (existing === undefined) {
        rows.set(key, {
          name: skill.name.trim(),
          description: skill.description ?? skill.shortDescription,
          group,
          paths: new Set(path === null ? [] : [path]),
          providers: new Map([[provider.instanceId, ref]]),
          disabledByProvider: !skill.enabled,
        });
        continue;
      }
      if (GROUP_ORDER.indexOf(group) < GROUP_ORDER.indexOf(existing.group)) existing.group = group;
      existing.description ??= skill.description ?? skill.shortDescription;
      if (path !== null) existing.paths.add(path);
      existing.providers.set(provider.instanceId, ref);
      // Off only when every provider that has it turned it off itself.
      existing.disabledByProvider &&= !skill.enabled;
    }
  }
  return [...rows.values()]
    .map((row) => ({
      name: row.name,
      description: row.description,
      group: row.group,
      paths: [...row.paths].toSorted(),
      providers: [...row.providers.values()].toSorted((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
      disabledByProvider: row.disabledByProvider,
    }))
    .toSorted(
      (left, right) =>
        GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group) ||
        left.name.localeCompare(right.name),
    );
}

export function groupSkillRows(
  rows: ReadonlyArray<SkillRow>,
): ReadonlyArray<{ readonly group: SkillGroupKind; readonly rows: ReadonlyArray<SkillRow> }> {
  return GROUP_ORDER.flatMap((group) => {
    const groupRows = rows.filter((row) => row.group === group);
    return groupRows.length === 0 ? [] : [{ group, rows: groupRows }];
  });
}

export function filterSkillRows(rows: ReadonlyArray<SkillRow>, query: string) {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) ||
      (row.description?.toLowerCase().includes(needle) ?? false),
  );
}

/** Whether `providers` covers only some of the enabled instances, so the row should name them. */
export function skillReachesSomeProviders(row: SkillRow, enabledProviderCount: number): boolean {
  return row.providers.length < enabledProviderCount;
}

/** The environment's list with one skill switched. Sorted so equal lists compare equal. */
export function withSkillDisabled(
  disabledSkills: ReadonlyArray<string>,
  name: string,
  disabled: boolean,
): ReadonlyArray<string> {
  const next = new Set(
    disabledSkills.filter((entry) => entry.toLowerCase() !== name.toLowerCase()),
  );
  if (disabled) next.add(name);
  return [...next].toSorted();
}

export function isSkillDisabled(disabledSkills: ReadonlyArray<string>, name: string): boolean {
  const lowered = name.toLowerCase();
  return disabledSkills.some((entry) => entry.toLowerCase() === lowered);
}

// ── MCP servers ────────────────────────────────────────────────────

/** Where a server in the effective list comes from at the current scope. */
export type McpServerOrigin =
  /** Defined on the environment; at project scope, inherited unchanged. */
  | "environment"
  /** Added by the project, or replacing the environment's server of that name. */
  | "project"
  /** The environment's server, switched on or off for the project. */
  | "project-switch";

export interface McpServerRow {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly origin: McpServerOrigin;
  /** The project replaces an environment server of the same name. */
  readonly replacesEnvironment: boolean;
}

export function listMcpServerRows(input: {
  readonly environment: Readonly<Record<string, McpServerConfig>>;
  readonly project: Readonly<Record<string, McpServerProjectOverride>> | null;
}): ReadonlyArray<McpServerRow> {
  const rows = new Map<string, McpServerRow>();
  for (const [name, config] of Object.entries(input.environment)) {
    rows.set(name, { name, config, origin: "environment", replacesEnvironment: false });
  }
  for (const [name, entry] of Object.entries(input.project ?? {})) {
    const inherited = input.environment[name];
    if (entry.transport !== undefined) {
      rows.set(name, {
        name,
        config: { enabled: entry.enabled, transport: entry.transport },
        origin: "project",
        replacesEnvironment: inherited !== undefined,
      });
    } else if (inherited !== undefined) {
      rows.set(name, {
        name,
        config: { ...inherited, enabled: entry.enabled },
        origin: "project-switch",
        replacesEnvironment: false,
      });
    }
  }
  return [...rows.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

// ── Server editor draft ────────────────────────────────────────────

export interface McpVariableDraft {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  /** A stored secret the user has not replaced. */
  readonly stored: boolean;
}

export interface McpServerDraft {
  readonly name: string;
  readonly type: McpServerTransport["type"];
  readonly command: string;
  readonly args: string;
  readonly url: string;
  readonly env: ReadonlyArray<McpVariableDraft>;
  readonly headers: ReadonlyArray<McpVariableDraft>;
}

let variableDraftId = 0;
export const nextMcpVariableDraftId = () => `mcp-var-${variableDraftId++}`;

const variableDrafts = (variables: ReadonlyArray<McpServerVariable>) =>
  variables.map((variable) => ({
    id: nextMcpVariableDraftId(),
    name: variable.name,
    value: variable.valueRedacted ? "" : variable.value,
    sensitive: variable.sensitive,
    stored: variable.valueRedacted === true,
  }));

export const EMPTY_MCP_SERVER_DRAFT: McpServerDraft = {
  name: "",
  type: "stdio",
  command: "",
  args: "",
  url: "",
  env: [],
  headers: [],
};

export function mcpServerDraftFrom(name: string, config: McpServerConfig): McpServerDraft {
  const transport = config.transport;
  return transport.type === "stdio"
    ? {
        ...EMPTY_MCP_SERVER_DRAFT,
        name,
        type: "stdio",
        command: transport.command,
        args: formatArgs(transport.args),
        env: variableDrafts(transport.env),
      }
    : {
        ...EMPTY_MCP_SERVER_DRAFT,
        name,
        type: "http",
        url: transport.url,
        headers: variableDrafts(transport.headers),
      };
}

/** Arguments on one line; an argument with whitespace or quotes is double-quoted. */
export function formatArgs(args: ReadonlyArray<string>): string {
  return args
    .map((arg) =>
      arg.length === 0 || /[\s"'\\]/.test(arg) ? `"${arg.replaceAll(/(["\\])/g, "\\$1")}"` : arg,
    )
    .join(" ");
}

/** Split an argument line on whitespace, honoring single and double quotes. */
export function parseArgs(line: string): ReadonlyArray<string> {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < line.length) current += line[++index];
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

function variablesFromDrafts(drafts: ReadonlyArray<McpVariableDraft>): McpServerVariable[] {
  return drafts.flatMap((draft) => {
    const name = draft.name.trim();
    if (name.length === 0) return [];
    if (draft.sensitive && draft.stored && draft.value.length === 0) {
      return [{ name, value: "", sensitive: true, valueRedacted: true }];
    }
    return [{ name, value: draft.value, sensitive: draft.sensitive }];
  });
}

export type McpServerDraftResult =
  | { readonly ok: true; readonly name: string; readonly transport: McpServerTransport }
  | { readonly ok: false; readonly field: "name" | "command" | "url"; readonly message: string };

export function mcpServerFromDraft(
  draft: McpServerDraft,
  takenNames: ReadonlySet<string>,
): McpServerDraftResult {
  const name = draft.name.trim();
  if (!isValidMcpServerName(name)) {
    return {
      ok: false,
      field: "name",
      message:
        name === "t3-code"
          ? "t3-code is reserved for T3 Code's own server."
          : "Use lowercase letters, digits, - or _, starting with a letter.",
    };
  }
  if (takenNames.has(name)) {
    return { ok: false, field: "name", message: "A server with this name already exists." };
  }
  if (draft.type === "stdio") {
    const command = draft.command.trim();
    if (command.length === 0) {
      return { ok: false, field: "command", message: "Enter the command that starts the server." };
    }
    return {
      ok: true,
      name,
      transport: {
        type: "stdio",
        command,
        args: [...parseArgs(draft.args)],
        env: variablesFromDrafts(draft.env),
      },
    };
  }
  const url = draft.url.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return { ok: false, field: "url", message: "Enter an http:// or https:// URL." };
  }
  return {
    ok: true,
    name,
    transport: { type: "http", url, headers: variablesFromDrafts(draft.headers) },
  };
}

/**
 * Read the JSON snippet MCP vendors publish (`{"mcpServers": {...}}`, a bare
 * `{"name": {...}}` map, or one server object) into a draft. Values in `env`
 * and `headers` are marked sensitive, since that is where keys go.
 */
export function parseMcpServerJson(text: string): McpServerDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  let record = parsed as Record<string, unknown>;
  for (const key of ["mcpServers", "servers", "mcp"]) {
    const nested = record[key];
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      record = nested as Record<string, unknown>;
      break;
    }
  }
  const isServer = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" &&
    value !== null &&
    ("command" in value || "url" in value || "serverUrl" in value || "httpUrl" in value);
  const [name, server] = isServer(record)
    ? ["", record]
    : (Object.entries(record).find(([, value]) => isServer(value)) ?? ["", undefined]);
  if (server === undefined || !isServer(server)) return null;
  const toVariables = (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>).map(([key, entry]) => ({
          id: nextMcpVariableDraftId(),
          name: key,
          value: typeof entry === "string" ? entry : String(entry),
          sensitive: true,
          stored: false,
        }))
      : [];
  const url = server.url ?? server.serverUrl ?? server.httpUrl;
  if (typeof url === "string") {
    return {
      ...EMPTY_MCP_SERVER_DRAFT,
      name: name.toLowerCase(),
      type: "http",
      url,
      headers: toVariables(server.headers),
    };
  }
  const commandValue = server.command;
  const commandParts = Array.isArray(commandValue)
    ? commandValue.filter((part): part is string => typeof part === "string")
    : typeof commandValue === "string"
      ? [commandValue]
      : [];
  const [command = "", ...commandArgs] = commandParts;
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return {
    ...EMPTY_MCP_SERVER_DRAFT,
    name: name.toLowerCase(),
    type: "stdio",
    command,
    args: formatArgs([...commandArgs, ...args]),
    env: toVariables(server.env ?? server.environment),
  };
}
