import type {
  ToolActivityIcon,
  ToolActivityNativeAppReference,
  ToolActivitySource,
  ToolActivitySurface,
} from "@t3tools/contracts";

export interface ExtractedToolActivityPresentation {
  readonly toolSurface?: ToolActivitySurface;
  readonly toolIcon?: ToolActivityIcon;
  readonly toolSource?: ToolActivitySource;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function imageUrl(value: unknown): string | undefined {
  const raw = trimmedString(value, 4096);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function pageUrl(value: unknown): string | undefined {
  const raw = trimmedString(value, 4096);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function nativeAppReference(value: unknown): ToolActivityNativeAppReference | undefined {
  const app = asRecord(value);
  const appId = trimmedString(app?.appId, 512);
  if (app?._tag === "app-id" && appId && /^[A-Za-z0-9._-]+$/u.test(appId)) {
    return { _tag: "app-id", appId };
  }
  const displayName = trimmedString(app?.displayName, 160);
  if (app?._tag === "display-name" && displayName) {
    return { _tag: "display-name", displayName };
  }
  return undefined;
}

function activityIcon(value: unknown): ToolActivityIcon | undefined {
  const icon = asRecord(value);
  if (icon?._tag === "website") {
    const resolvedPageUrl = pageUrl(icon.pageUrl);
    const faviconUrl = imageUrl(icon.faviconUrl);
    const faviconUrlDark = imageUrl(icon.faviconUrlDark);
    if (resolvedPageUrl) {
      return {
        _tag: "website",
        pageUrl: resolvedPageUrl,
        ...(faviconUrl ? { faviconUrl } : {}),
        ...(faviconUrlDark ? { faviconUrlDark } : {}),
      };
    }
  }
  if (icon?._tag === "native-app") {
    const app = nativeAppReference(icon.app);
    if (app) return { _tag: "native-app", app };
  }
  if (icon?._tag === "themed-logo") {
    const logoUrl = imageUrl(icon.logoUrl);
    const logoUrlDark = imageUrl(icon.logoUrlDark);
    if (logoUrl) {
      return {
        _tag: "themed-logo",
        logoUrl,
        ...(logoUrlDark ? { logoUrlDark } : {}),
      };
    }
  }
  return undefined;
}

function activitySource(value: unknown): ToolActivitySource | undefined {
  const source = asRecord(value);
  const key = trimmedString(source?.key, 512);
  const name = trimmedString(source?.name, 160);
  const kind = source?.kind;
  if (!key || !name || (kind !== "browser" && kind !== "computer" && kind !== "integration")) {
    return undefined;
  }
  const icon = activityIcon(source?.icon);
  return { key, name, kind, ...(icon ? { icon } : {}) };
}

/** MCP identity comes from provider fields, never from command text or tool output. */
export function readMcpToolIdentity(value: unknown) {
  const data = asRecord(value);
  const server = trimmedString(data?.server, 160);
  const tool = trimmedString(data?.tool, 160);
  if (server && tool) return { server, tool };
  const name = trimmedString(data?.toolName ?? data?.tool ?? value, 512);
  const match = name?.match(/^mcp__(.+?)__(.+)$/u);
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
}

export function extractMcpToolData(payloadValue: unknown): unknown {
  const payload = asRecord(payloadValue);
  if (payload?.itemType !== "mcp_tool_call") return undefined;
  const data = asRecord(payload.data);
  return data?.item ?? data;
}

const pydanticIcon: ToolActivityIcon = {
  _tag: "themed-logo",
  // Official Pydantic mark, bundled so activity rendering needs no external request.
  // Source: https://pydantic.dev/favicon/favicon-32x32.png
  logoUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAjVBMVEUAAADkHunlH+jmH+nnIO3mH+nmH+jmH+nmH+nmIOrnI+fhJOHlH+jmIOnlH+nmH+nlIOnmIOnnIOjoH+jlIOnmH+nmH+jmH+jlH+nlHujlIOjkIOnmH+jmIOnmIOnlH+nmH+rlIOjmH+nlH+nlH+jmIOjmIOjmH+jnH+nmH+bpHenlIOnlIOnlH+rmIOn8IWMRAAAALnRSTlMAOfz3D+ySy+U9FQfy1bSwbV01K97Et4p4Wk4d3LyagEhE0KOih3xoYCkj3b0xGud1NAAAASlJREFUOMutktmSgjAQRdskEGRHkc19X2bm/v/nDYlIFNAn71NXnVOVzk3o23GldD8KEZB94jHqxO/5lCMIwKfvuLcD/1OS90ZYAbE+xh7mG4asWbQa4nMLjquv6sCaDwhLsO19GjPM+rwAciJvs/GIcqDo8gmDFNXBB3iYCAk2euViAUgfTXwJLMSLsL8TKwMyCzr7Z55oeqi8ETCise2gTmL4zYdlj9WkBaLaseDfWmHW7qQEs/Wj8iNwoq5AJ+D41EtfoN+mOZHqZo3Q7T4CShoSqAJCojOwoq5g3v9MO4BHpegLoow4EFCpS+HhRTwL4hJy1HESdeP1Qs1sFrt3QSQNtbftW+apdpY2YC+ZmtN80vnR6wBtUlW8iXGkoj+G9nMtiit9Of95Iid+i/HAwQAAAABJRU5ErkJggg==",
};

export function mcpToolSource(server: string): ToolActivitySource {
  const isLogfire = /^(?:pydantic[-_])?logfire$/iu.test(server);
  return {
    key: `mcp:${server}`,
    name: `${isLogfire ? "Pydantic Logfire" : server} MCP`,
    kind: "integration",
    ...(isLogfire ? { icon: pydanticIcon } : {}),
  };
}

export function extractToolActivityPresentation(
  payloadValue: unknown,
): ExtractedToolActivityPresentation {
  const payload = asRecord(payloadValue);
  const toolSurface =
    payload?.toolSurface === "browser" || payload?.toolSurface === "computer"
      ? payload.toolSurface
      : undefined;
  const toolIcon = activityIcon(payload?.toolIcon);
  const identity =
    readMcpToolIdentity(extractMcpToolData(payload)) ??
    (payload?.itemType === "mcp_tool_call" ? readMcpToolIdentity(payload.title) : undefined);
  const toolSource =
    activitySource(payload?.toolSource) ??
    (!toolSurface && identity && !/^(?:t3-code|t3_code|t3code)$/iu.test(identity.server)
      ? mcpToolSource(identity.server)
      : undefined);
  return {
    ...(toolSurface ? { toolSurface } : {}),
    ...(toolIcon ? { toolIcon } : {}),
    ...(toolSource ? { toolSource } : {}),
  };
}
