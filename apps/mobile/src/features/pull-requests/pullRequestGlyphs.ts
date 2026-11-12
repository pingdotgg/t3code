import type { AppSymbolName } from "../../components/ui/AppSymbol";

export const PullRequestGlyph = {
  pullRequest: "arrow.triangle.pull",
  draft: "git.pull-request.draft",
  closed: "git.pull-request.closed",
  merged: "arrow.triangle.merge",
  stack: "square.3.layers.3d",
  conflicting: "exclamationmark.triangle",
} as const satisfies Record<string, AppSymbolName>;
