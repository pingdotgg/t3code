import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, type Icon, OpenCodeIcon, OpenAI } from "../Icons";

/**
 * Series and table order. The chart layers both providers from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the other.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "opencode"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/**
 * Claude's brand orange against a neutral white for Codex; a violet that reads
 * on both themes for OpenCode.
 */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "#d97757",
  codex: "#e6e6e6",
  opencode: "#a78bfa",
};

/**
 * Brand marks, reused from the provider picker.
 *
 * Claude ships its own fill (`#d97757`), which matches its chart band; OpenAI
 * and OpenCode render monochrome, so their legend and hover marks carry the
 * series association through the neighbouring label rather than a fill.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
  opencode: OpenCodeIcon,
};
