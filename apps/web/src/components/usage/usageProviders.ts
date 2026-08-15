import type { UsageProviderKind } from "@t3tools/contracts";

import {
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  type Icon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";

/**
 * Series and table order. The chart layers providers from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the other.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = [
  "codex",
  "claude",
  "cursor",
  "grok",
  "opencode",
];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
};

/** Brand-adjacent colours that stay distinct on the dark usage chart. */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "#d97757",
  codex: "#e6e6e6",
  cursor: "#88c0d0",
  grok: "#a3a3a3",
  opencode: "#cfcecd",
};

/**
 * Brand marks, reused from the provider picker.
 *
 * These ship their own fills, which are the same colours as the chart bands,
 * so swapping a colour dot for a mark keeps the series association intact
 * rather than trading it away.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
  cursor: CursorIcon,
  grok: GrokIcon,
  opencode: OpenCodeIcon,
};
