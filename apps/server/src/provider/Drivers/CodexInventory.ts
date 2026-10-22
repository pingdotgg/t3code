import type {
  ProviderDisabledInventory,
  ProviderInventoryItem,
  ProviderInventorySection,
  ServerProviderSkill,
} from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";
import type { ProviderInventoryDraft } from "@t3tools/provider-core/server/driver";

const CHATGPT_CONNECTORS_URL = "https://chatgpt.com/#settings/Connectors";

// Codex serves ChatGPT connectors through this one MCP server. They are listed
// as connectors, so the proxy itself is not shown.
const CODEX_APPS_SERVER = "codex_apps";
const MAX_ERROR_CHARS = 300;
// `-c` splits its key on dots, so only ids that are already bare TOML keys are
// passed. ChatGPT connector ids are `[a-z0-9_]` in practice.
const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

type McpServerStatus = CodexSchema.V2ListMcpServerStatusResponse["data"][number];
type PluginMarketplace = CodexSchema.V2PluginInstalledResponse["marketplaces"][number];
type InstalledApp = CodexSchema.V2AppsInstalledResponse["apps"][number];

export type CodexInventoryPart<A> = { readonly _tag: "Success"; readonly value: A } | Failure;
type Failure = { readonly _tag: "Failure"; readonly message: string };

export interface CodexInventoryProbe {
  readonly mcpServers: CodexInventoryPart<ReadonlyArray<McpServerStatus>>;
  readonly plugins: CodexInventoryPart<ReadonlyArray<PluginMarketplace>>;
  readonly apps: CodexInventoryPart<ReadonlyArray<InstalledApp>>;
  readonly skills: CodexInventoryPart<ReadonlyArray<ServerProviderSkill>>;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const byName = (left: ProviderInventoryItem, right: ProviderInventoryItem) =>
  left.name.localeCompare(right.name);

function section<A>(
  part: CodexInventoryPart<A>,
  canDisable: boolean,
  toItems: (value: A) => ReadonlyArray<ProviderInventoryItem>,
): ProviderInventorySection {
  return part._tag === "Failure"
    ? { _tag: "Failed", message: part.message }
    : { _tag: "Listed", items: toItems(part.value).toSorted(byName), canDisable };
}

function mcpServerItem(server: McpServerStatus): ProviderInventoryItem {
  const error = nonEmpty(server.toolsError)?.slice(0, MAX_ERROR_CHARS);
  const plugin = nonEmpty(server.pluginId);
  return {
    id: server.name,
    name: server.name,
    status: error ? "failed" : server.authStatus === "notLoggedIn" ? "needsAuth" : "connected",
    ...(error ? { error } : { toolCount: Object.keys(server.tools).length }),
    ...(plugin ? { plugin } : {}),
  };
}

export function codexInventoryFromProbe(probe: CodexInventoryProbe): ProviderInventoryDraft {
  return {
    manageUrl: CHATGPT_CONNECTORS_URL,
    connectors: section(probe.apps, true, (apps) =>
      apps.map((app) => ({
        id: app.id,
        name: nonEmpty(app.runtimeName) ?? app.id,
        ...(app.enabled
          ? app.callable
            ? { status: "connected" as const }
            : {}
          : { status: "disabled" as const }),
      })),
    ),
    // Disabling a server Codex no longer has configured makes `app-server`
    // hang on startup, and T3 cannot see the user's config when it launches a
    // session, so MCP servers are listed but not switchable.
    mcpServers: section(probe.mcpServers, false, (servers) =>
      servers.filter((server) => server.name !== CODEX_APPS_SERVER).map(mcpServerItem),
    ),
    // Codex ignores per-plugin config overrides for remote marketplace plugins.
    plugins: section(probe.plugins, false, (marketplaces) =>
      marketplaces.flatMap((marketplace) =>
        marketplace.plugins
          .filter((plugin) => plugin.installed)
          .map((plugin): ProviderInventoryItem => {
            const description = nonEmpty(plugin.interface?.shortDescription);
            return {
              id: plugin.id,
              name: nonEmpty(plugin.interface?.displayName) ?? plugin.name,
              ...(description ? { description } : {}),
              ...(plugin.enabled ? {} : { status: "disabled" as const }),
            };
          }),
      ),
    ),
    skills: section(probe.skills, true, (skills) =>
      skills.map((skill) => {
        const description = skill.shortDescription ?? skill.description;
        return {
          id: skill.path,
          name: skill.displayName ?? skill.name,
          ...(description ? { description } : {}),
          ...(skill.enabled ? {} : { status: "disabled" as const }),
        };
      }),
    ),
  };
}

/**
 * Config overrides for this `app-server` process only; the user's
 * `config.toml` is left alone. Codex merges `skills.config` with the user's
 * own entries, so their disabled skills stay disabled.
 */
export function codexDisabledInventoryArgs(
  disabled: ProviderDisabledInventory,
): ReadonlyArray<string> {
  const args: Array<string> = [];
  for (const id of disabled.connectors ?? []) {
    if (BARE_TOML_KEY.test(id)) args.push("-c", `apps.${id}.enabled=false`);
  }
  const skills = disabled.skills ?? [];
  if (skills.length > 0) {
    // A JSON string literal is also a valid TOML basic string.
    const entries = skills.map((path) => `{path=${JSON.stringify(path)},enabled=false}`);
    args.push("-c", `skills.config=[${entries.join(",")}]`);
  }
  return args;
}

/** Marks skills T3 keeps out of its sessions, so the composer stops offering them. */
export function withCodexDisabledInventory(
  skills: ReadonlyArray<ServerProviderSkill>,
  disabled: ProviderDisabledInventory,
): ReadonlyArray<ServerProviderSkill> {
  const paths = new Set(disabled.skills);
  if (paths.size === 0) return skills;
  return skills.map((skill) =>
    skill.enabled && paths.has(skill.path) ? { ...skill, enabled: false } : skill,
  );
}
