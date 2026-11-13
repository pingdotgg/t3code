import type { ToolActivityIcon, ToolActivitySource } from "@t3tools/contracts";
import { isPublicFaviconHost } from "@t3tools/shared/hostClassification";
import { resolveT3McpToolDefinition } from "@t3tools/shared/t3McpToolPresentation";

export function normalizeMcpText(value: unknown, maxLength = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length > 0 && text.length <= maxLength ? text : undefined;
}

export function normalizeMcpHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.href.length <= 4096
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** What the provider reports about the MCP server behind a tool call. */
export interface McpServerPresentation {
  /** MCP `Implementation.icons` from the server's initialize result. */
  readonly icons?: unknown;
  /** MCP `Tool.icons` of the called tool. */
  readonly toolIcons?: unknown;
  readonly websiteUrl?: unknown;
  /** The server's HTTP address. Only its origin reaches clients. */
  readonly url?: unknown;
}

const MAX_DECLARED_ICONS = 32;
// Leading host labels dropped to reach the brand site, as in mcp.higgsfield.ai → higgsfield.ai.
const MCP_SERVICE_HOST_LABELS: ReadonlySet<string> = new Set(["mcp", "api"]);

/** Picks MCP `Icon` entries for light and dark backgrounds; `data:` URIs are skipped to keep rows small. */
function declaredMcpIcon(value: unknown): ToolActivityIcon | undefined {
  if (!Array.isArray(value)) return undefined;
  const icons = value.slice(0, MAX_DECLARED_ICONS).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const src = normalizeMcpHttpUrl(Reflect.get(entry, "src"));
    const mimeType = Reflect.get(entry, "mimeType");
    if (!src || (typeof mimeType === "string" && !mimeType.startsWith("image/"))) return [];
    const theme = Reflect.get(entry, "theme");
    const sizes = Reflect.get(entry, "sizes");
    return [
      {
        src,
        theme: theme === "light" || theme === "dark" ? theme : undefined,
        scalable: mimeType === "image/svg+xml" || (Array.isArray(sizes) && sizes.includes("any")),
      },
    ];
  });
  const pick = (theme: "light" | "dark" | undefined) => {
    const matches = icons.filter((icon) => icon.theme === theme);
    return (matches.find((icon) => icon.scalable) ?? matches[0])?.src;
  };
  const themedLight = pick("light");
  const logoUrl = themedLight ?? pick(undefined) ?? pick("dark");
  if (!logoUrl) return undefined;
  const logoUrlDark = pick("dark") ?? (themedLight ? pick(undefined) : undefined);
  return {
    _tag: "themed-logo",
    logoUrl,
    ...(logoUrlDark && logoUrlDark !== logoUrl ? { logoUrlDark } : {}),
  };
}

/** The site icon for a public HTTP address, sent as an origin so paths and query secrets stay home. */
function siteIcon(value: unknown): ToolActivityIcon | undefined {
  const href = normalizeMcpHttpUrl(value);
  if (!href) return undefined;
  const url = new URL(href);
  if (!isPublicFaviconHost(url.hostname)) return undefined;
  const labels = url.hostname.split(".");
  if (labels.length > 2 && MCP_SERVICE_HOST_LABELS.has(labels[0]!.toLowerCase())) {
    url.hostname = labels.slice(1).join(".");
  }
  return { _tag: "website", pageUrl: url.origin };
}

export function mcpToolPresentation(input: {
  readonly toolName?: unknown;
  readonly serverName?: unknown;
  readonly title?: unknown;
  readonly serverDisplayName?: unknown;
  readonly iconUrl?: unknown;
  readonly iconUrlDark?: unknown;
  readonly source?: unknown;
  readonly server?: McpServerPresentation | undefined;
}): {
  readonly title?: string;
  readonly toolIcon?: ToolActivityIcon;
  readonly toolSource?: ToolActivitySource;
} {
  const source =
    typeof input.source === "object" && input.source !== null ? input.source : undefined;
  const qualified =
    typeof input.toolName === "string" ? /^mcp__(.+?)__(.+)$/i.exec(input.toolName) : null;
  const server = normalizeMcpText(input.serverName ?? qualified?.[1] ?? input.serverDisplayName);
  const tool = normalizeMcpText(qualified?.[2] ?? input.toolName);
  if (server && tool && resolveT3McpToolDefinition(`${server}.${tool}`)) return {};
  const title =
    normalizeMcpText(input.title) ??
    (server && tool ? normalizeMcpText(tool.replace(/[_-]+/gu, " ")) : undefined);
  if (!server) return title ? { title } : {};
  const name =
    normalizeMcpText(input.serverDisplayName) ??
    normalizeMcpText(source && Reflect.get(source, "name")) ??
    normalizeMcpText(server.replace(/[_-]+/gu, " ")) ??
    server;
  const logoUrl =
    normalizeMcpHttpUrl(input.iconUrl) ??
    normalizeMcpHttpUrl(source && Reflect.get(source, "logoUrl"));
  const logoUrlDark =
    normalizeMcpHttpUrl(input.iconUrlDark) ??
    normalizeMcpHttpUrl(source && Reflect.get(source, "logoUrlDark"));
  const providerIcon = logoUrl
    ? { _tag: "themed-logo" as const, logoUrl, ...(logoUrlDark ? { logoUrlDark } : {}) }
    : undefined;
  const icon =
    declaredMcpIcon(input.server?.icons) ??
    providerIcon ??
    siteIcon(input.server?.websiteUrl) ??
    siteIcon(input.server?.url);
  const toolIcon = declaredMcpIcon(input.server?.toolIcons) ?? icon;
  return {
    ...(title ? { title } : {}),
    ...(toolIcon ? { toolIcon } : {}),
    toolSource: {
      key: `mcp:${server.toLowerCase()}`,
      name,
      kind: "integration",
      ...(icon ? { icon } : {}),
    },
  };
}
