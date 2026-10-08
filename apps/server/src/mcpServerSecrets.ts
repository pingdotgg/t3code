/**
 * Sensitive MCP server variables (env values, HTTP headers) live in the
 * secret store, never in settings.json or on the wire. Servers sit in two
 * places, the environment's `mcpServers` and each project's override entry,
 * so every helper here walks both.
 *
 * On disk and towards clients a sensitive variable is `{value: "",
 * valueRedacted: true}`. A client that sends that back keeps the stored
 * secret; a new value replaces it; turning `sensitive` off moves the value
 * back into settings.
 */
import type {
  McpServerConfig,
  McpServerProjectOverride,
  McpServerVariable,
  ProjectSettingsOverrides,
  ServerSettings,
} from "@t3tools/contracts";

/** Where a server lives: the environment, or one project's overrides. */
type McpServerOwner = { readonly kind: "environment" } | { readonly kind: "project"; id: string };

type ServerEntry = McpServerConfig | McpServerProjectOverride;

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/** Deterministic per (owner, server, variable kind, variable name). */
function mcpServerSecretName(input: {
  readonly owner: McpServerOwner;
  readonly server: string;
  readonly variableKind: "env" | "header";
  readonly variable: string;
}): string {
  const owner = input.owner.kind === "environment" ? "env" : `project-${encode(input.owner.id)}`;
  return `mcp-${owner}-${encode(input.server)}-${input.variableKind}-${encode(input.variable)}`;
}

interface VariableSite {
  readonly owner: McpServerOwner;
  readonly server: string;
  readonly variableKind: "env" | "header";
  readonly variable: McpServerVariable;
}

function variablesOf(entry: ServerEntry): {
  readonly kind: "env" | "header";
  readonly variables: ReadonlyArray<McpServerVariable>;
} | null {
  const transport = entry.transport;
  if (transport === undefined) return null;
  return transport.type === "stdio"
    ? { kind: "env", variables: transport.env }
    : { kind: "header", variables: transport.headers };
}

function* variableSites(settings: ServerSettings): Generator<VariableSite> {
  for (const [server, entry] of Object.entries(settings.mcpServers)) {
    const variables = variablesOf(entry);
    if (variables === null) continue;
    for (const variable of variables.variables) {
      yield { owner: { kind: "environment" }, server, variableKind: variables.kind, variable };
    }
  }
  for (const [id, overrides] of Object.entries(settings.projectSettingsOverrides)) {
    for (const [server, entry] of Object.entries(overrides.mcpServers ?? {})) {
      const variables = variablesOf(entry);
      if (variables === null) continue;
      for (const variable of variables.variables) {
        yield { owner: { kind: "project", id }, server, variableKind: variables.kind, variable };
      }
    }
  }
}

const siteSecretName = (site: VariableSite) =>
  mcpServerSecretName({
    owner: site.owner,
    server: site.server,
    variableKind: site.variableKind,
    variable: site.variable.name,
  });

/**
 * Rebuild every server in `settings` with `map` applied to each variable.
 * Returns the input unchanged when no server has variables.
 */
function mapVariables(
  settings: ServerSettings,
  map: (site: VariableSite) => McpServerVariable,
): ServerSettings {
  const mapEntry = <Entry extends ServerEntry>(
    owner: McpServerOwner,
    server: string,
    entry: Entry,
  ): Entry => {
    const transport = entry.transport;
    if (transport === undefined) return entry;
    if (transport.type === "stdio") {
      if (transport.env.length === 0) return entry;
      return {
        ...entry,
        transport: {
          ...transport,
          env: transport.env.map((variable) =>
            map({ owner, server, variableKind: "env", variable }),
          ),
        },
      };
    }
    if (transport.headers.length === 0) return entry;
    return {
      ...entry,
      transport: {
        ...transport,
        headers: transport.headers.map((variable) =>
          map({ owner, server, variableKind: "header", variable }),
        ),
      },
    };
  };
  const mcpServers = Object.fromEntries(
    Object.entries(settings.mcpServers).map(([server, entry]) => [
      server,
      mapEntry({ kind: "environment" }, server, entry),
    ]),
  ) as ServerSettings["mcpServers"];
  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(settings.projectSettingsOverrides).map(([id, overrides]) => [
      id,
      overrides.mcpServers === undefined
        ? overrides
        : ({
            ...overrides,
            mcpServers: Object.fromEntries(
              Object.entries(overrides.mcpServers).map(([server, entry]) => [
                server,
                mapEntry({ kind: "project", id }, server, entry),
              ]),
            ),
          } satisfies ProjectSettingsOverrides),
    ]),
  ) as ServerSettings["projectSettingsOverrides"];
  return { ...settings, mcpServers, projectSettingsOverrides };
}

/** What a client sees: sensitive values blanked, with a flag that one is stored. */
export function redactMcpServerSecrets(settings: ServerSettings): ServerSettings {
  return mapVariables(settings, ({ variable }) => {
    if (!variable.sensitive) {
      const { valueRedacted: _omit, ...rest } = variable;
      return rest;
    }
    return {
      ...variable,
      value: "",
      ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
    };
  });
}

export type McpSecretChange =
  | { readonly kind: "write"; readonly secretName: string; readonly value: string }
  | { readonly kind: "remove"; readonly secretName: string };

/**
 * Plan the secret-store writes for moving from `current` to `next`, and the
 * settings to persist (sensitive values replaced by the redaction flag).
 * A sensitive variable sent back redacted with no value keeps its secret;
 * a value the user typed replaces it; an empty value or a variable that is
 * no longer sensitive (or no longer exists) removes it.
 */
export function planMcpServerSecrets(
  current: ServerSettings,
  next: ServerSettings,
): { readonly settings: ServerSettings; readonly changes: ReadonlyArray<McpSecretChange> } {
  const stored = new Set<string>();
  for (const site of variableSites(current)) {
    if (site.variable.sensitive) stored.add(siteSecretName(site));
  }
  const changes: McpSecretChange[] = [];
  const kept = new Set<string>();
  const settings = mapVariables(next, (site) => {
    const secretName = siteSecretName(site);
    const { variable } = site;
    const { valueRedacted: _omit, ...plain } = variable;
    if (!variable.sensitive) return plain;
    if (variable.value.length === 0) {
      if (!variable.valueRedacted) return plain;
      kept.add(secretName);
      return { ...variable, value: "", valueRedacted: true };
    }
    kept.add(secretName);
    changes.push({ kind: "write", secretName, value: variable.value });
    return { ...variable, value: "", valueRedacted: true };
  });
  for (const secretName of stored) {
    if (!kept.has(secretName)) changes.push({ kind: "remove", secretName });
  }
  return { settings, changes };
}

/** The secret names whose values `materializeMcpServerSecrets` needs. */
export function mcpServerSecretNames(settings: ServerSettings): ReadonlyArray<string> {
  const names: string[] = [];
  for (const site of variableSites(settings)) {
    if (site.variable.sensitive && site.variable.valueRedacted) names.push(siteSecretName(site));
  }
  return names;
}

/** Settings with stored secret values filled back in, for server-side consumers. */
export function materializeMcpServerSecrets(
  settings: ServerSettings,
  secrets: ReadonlyMap<string, string>,
): ServerSettings {
  if (secrets.size === 0) return settings;
  return mapVariables(settings, (site) => {
    if (!site.variable.sensitive || !site.variable.valueRedacted) return site.variable;
    return { ...site.variable, value: secrets.get(siteSecretName(site)) ?? "" };
  });
}
