import type { ProviderContextUsage } from "@t3tools/contracts";
import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";

/**
 * Translate the SDK's `/context` report into the wire contract. The SDK's
 * category list already includes free space and any deferred slices; the detail
 * groups mirror the expandable rows Claude Code shows under that list.
 */
export function toProviderContextUsage(
  response: SDKControlGetContextUsageResponse,
): ProviderContextUsage {
  const categories = response.categories
    .filter((category) => category.name.trim().length > 0 && category.tokens >= 0)
    .map((category) => ({
      name: category.name,
      tokens: Math.round(category.tokens),
      deferred: category.kind === "deferred" || category.isDeferred === true,
      ...(category.kind === undefined ? {} : { kind: category.kind }),
    }));

  const groups: Array<ProviderContextUsage["groups"][number]> = [];
  const pushGroup = (
    label: string,
    items: ReadonlyArray<{ name: string; tokens: number; detail?: string }>,
  ) => {
    const kept = items
      .filter((item) => item.name.trim().length > 0 && item.tokens >= 0)
      .map((item) => ({
        name: item.name,
        tokens: Math.round(item.tokens),
        ...(item.detail && item.detail.trim().length > 0 ? { detail: item.detail } : {}),
      }))
      .sort((left, right) => right.tokens - left.tokens);
    if (kept.length === 0) return;
    groups.push({
      label,
      tokens: kept.reduce((sum, item) => sum + item.tokens, 0),
      items: kept,
    });
  };

  pushGroup(
    "System prompt",
    (response.systemPromptSections ?? []).map((section) => ({
      name: section.name,
      tokens: section.tokens,
    })),
  );
  pushGroup(
    "System tools",
    (response.systemTools ?? []).map((tool) => ({ name: tool.name, tokens: tool.tokens })),
  );
  // MCP tool names carry an `mcp__<server>__` prefix; the server already
  // appears as the detail column, so only the bare tool name is shown.
  pushGroup(
    "MCP tools",
    response.mcpTools.map((tool) => ({
      name: tool.name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "") || tool.name,
      tokens: tool.tokens,
      detail: tool.serverName,
    })),
  );
  // Memory files arrive as absolute paths; the last two segments identify
  // them (`t3code/AGENTS.md`) without the home-directory prefix.
  pushGroup(
    "Memory files",
    response.memoryFiles.map((file) => ({
      name: file.path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || file.path,
      tokens: file.tokens,
      detail: file.type,
    })),
  );
  pushGroup(
    "Skills",
    (response.skills?.skillFrontmatter ?? []).map((skill) => ({
      name: skill.name,
      tokens: skill.tokens,
      detail: skill.source,
    })),
  );
  pushGroup(
    "Custom agents",
    response.agents.map((agent) => ({
      name: agent.agentType,
      tokens: agent.tokens,
      detail: agent.source,
    })),
  );
  // `messageBreakdown` is left out on purpose: it totals every API call in
  // the session, so it exceeds the resident "Messages" slice and would read
  // as a contradiction next to it.

  return {
    model: response.model,
    totalTokens: Math.max(0, Math.round(response.totalTokens)),
    maxTokens: Math.max(1, Math.round(response.maxTokens)),
    categories,
    groups,
  };
}
