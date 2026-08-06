/** Claude-provider model entry for the enabled Codex bridge (fork feature f5). */
import {
  CLAUDE_CODEX_ROUTED_SUB_PROVIDER,
  type ClaudeSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { effectiveClaudeCodexModel } from "@t3tools/shared/claudeCodexRouting";
import { createModelCapabilities } from "@t3tools/shared/model";

const ROUTED_CODEX_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export function formatClaudeCodexModelName(model: string): string {
  const parts = model
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "codex") return "Codex";
      if (/^[\d.]+$/u.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    });
  if (parts[0] === "GPT" && parts[1] && /^[\d.]+$/u.test(parts[1])) {
    return [`GPT-${parts[1]}`, ...parts.slice(2)].join(" ");
  }
  return parts.join(" ");
}

export function claudeCodexRoutedModel(
  settings: Pick<ClaudeSettings, "codexRouting">,
): ServerProviderModel | undefined {
  if (settings.codexRouting?.enabled !== true) return undefined;
  const slug = effectiveClaudeCodexModel(settings.codexRouting.model);
  const name = formatClaudeCodexModelName(slug);
  return {
    slug,
    name,
    shortName: name,
    subProvider: CLAUDE_CODEX_ROUTED_SUB_PROVIDER,
    isCustom: false,
    capabilities: ROUTED_CODEX_CAPABILITIES,
  };
}

/**
 * Inserts the routed model after current Claude models and before the legacy
 * section. A colliding custom slug is replaced because enabling the bridge
 * makes that slug an explicit Codex route for this Claude instance.
 */
export function withClaudeCodexRoutedModel(
  models: ReadonlyArray<ServerProviderModel>,
  settings: Pick<ClaudeSettings, "codexRouting">,
): ReadonlyArray<ServerProviderModel> {
  const routed = claudeCodexRoutedModel(settings);
  if (!routed) return models;
  const next = models.filter(
    (model) => model.slug !== routed.slug && model.subProvider !== CLAUDE_CODEX_ROUTED_SUB_PROVIDER,
  );
  const firstLegacy = next.findIndex((model) => model.isLegacy === true);
  if (firstLegacy === -1) return [...next, routed];
  return [...next.slice(0, firstLegacy), routed, ...next.slice(firstLegacy)];
}
