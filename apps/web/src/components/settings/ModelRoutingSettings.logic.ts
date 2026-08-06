/** Pure settings helpers for Claude Code → Codex routing (fork feature f5). */
import {
  DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS,
  ClaudeCodexRoutingSettings as ClaudeCodexRoutingSettingsSchema,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type ClaudeCodexRoutingSettings,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeClaudeCodexRouting = Schema.decodeUnknownSync(ClaudeCodexRoutingSettingsSchema);

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function claudeRoutingProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter((provider) => provider.driver === "claudeAgent" && provider.enabled);
}

export function readClaudeCodexRouting(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  instanceId: ProviderInstanceId,
): ClaudeCodexRoutingSettings {
  const explicit = settings.providerInstances[instanceId];
  if (explicit?.driver === "claudeAgent") {
    const configured = asRecord(explicit.config).codexRouting;
    try {
      return decodeClaudeCodexRouting(configured ?? {});
    } catch {
      return DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS;
    }
  }
  return settings.providers.claudeAgent.codexRouting ?? DEFAULT_CLAUDE_CODEX_ROUTING_SETTINGS;
}

export function buildClaudeCodexRoutingPatch(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  instanceId: ProviderInstanceId,
  routing: ClaudeCodexRoutingSettings,
): ServerSettingsPatch {
  const explicit = settings.providerInstances[instanceId];
  if (explicit?.driver === "claudeAgent") {
    return {
      providerInstances: {
        ...settings.providerInstances,
        [instanceId]: {
          ...explicit,
          config: {
            ...asRecord(explicit.config),
            codexRouting: routing,
          },
        },
      },
    };
  }

  const defaultId = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
  if (instanceId !== defaultId) {
    return {};
  }
  return { providers: { claudeAgent: { codexRouting: routing } } };
}
