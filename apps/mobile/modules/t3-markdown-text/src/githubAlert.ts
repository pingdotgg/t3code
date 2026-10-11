import type { MarkdownNode } from "react-native-nitro-markdown/headless";

const ALERTS = {
  NOTE: { title: "Note", color: "#4493f8", lightColor: "#0969da", symbol: "info.circle" },
  TIP: { title: "Tip", color: "#3fb950", lightColor: "#1a7f37", symbol: "lightbulb" },
  IMPORTANT: {
    title: "Important",
    color: "#ab7df8",
    lightColor: "#8250df",
    symbol: "exclamationmark.bubble",
  },
  WARNING: {
    title: "Warning",
    color: "#d29922",
    lightColor: "#9a6700",
    symbol: "exclamationmark.triangle",
  },
  CAUTION: {
    title: "Caution",
    color: "#f85149",
    lightColor: "#cf222e",
    symbol: "exclamationmark.octagon",
  },
} as const;

/** GitHub alerts are blockquotes whose first line contains only the alert marker. */
export function githubAlert(node: MarkdownNode) {
  if (node.type !== "blockquote") return null;
  const paragraph = node.children?.[0];
  const text = paragraph?.children?.[0];
  if (paragraph?.type !== "paragraph" || text?.type !== "text") return null;
  const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](\r?\n|$)/i.exec(text.content ?? "");
  if (!match) return null;
  const rest = (text.content ?? "").slice(match[0].length);
  const siblings = paragraph.children?.slice(1) ?? [];
  if (
    !rest &&
    !match[2] &&
    siblings.length &&
    !["soft_break", "line_break"].includes(siblings[0]!.type)
  )
    return null;
  if (!rest && ["soft_break", "line_break"].includes(siblings[0]?.type ?? "")) siblings.shift();
  const children = [...(rest ? [{ ...text, content: rest }] : []), ...siblings];
  return {
    ...ALERTS[match[1]!.toUpperCase() as keyof typeof ALERTS],
    children: [
      ...(children.length ? [{ ...paragraph, children }] : []),
      ...(node.children?.slice(1) ?? []),
    ],
  };
}
