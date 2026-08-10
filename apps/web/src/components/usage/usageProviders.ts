import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, CursorIcon, type Icon, OpenAI } from "../Icons";

/**
 * Series and table order. The chart layers providers from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the other.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "cursor"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** Claude's brand orange, a neutral white for Codex, and Cursor's brand black. */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "#d97757",
  codex: "#e6e6e6",
  cursor: "#8a8a8a",
};

/**
 * Brand marks, reused from the provider picker.
 *
 * These ship their own fills (`#d97757` for Claude, white on dark for OpenAI),
 * which are the same colours as the chart bands, so swapping a colour dot for a
 * mark keeps the series association intact rather than trading it away.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
  cursor: CursorIcon,
};
