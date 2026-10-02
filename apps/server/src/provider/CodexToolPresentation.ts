import * as NodeCrypto from "node:crypto";
import type {
  ToolActivityIcon,
  ToolActivityNativeAppReference,
  ToolActivitySource,
} from "@t3tools/contracts";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

type CodexLifecycleItem = EffectCodexSchema.V2ItemCompletedNotification["item"];

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizedHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    const href = url.href;
    return (url.protocol === "http:" || url.protocol === "https:") && href.length <= 4096
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedAppId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const appId = value.trim();
  return appId.length > 0 && appId.length <= 512 && /^[A-Za-z0-9._-]+$/u.test(appId)
    ? appId
    : undefined;
}

function normalizedDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const displayName = value.trim().replace(/\s+/gu, " ");
  return displayName && displayName.length <= 160 ? displayName : undefined;
}

function normalizedSourceKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function nativeAppSourceKey(appId: string): string {
  const key = `native-app:${appId.toLowerCase()}`;
  if (key.length <= 512) return key;
  const digest = NodeCrypto.createHash("sha256").update(key).digest("hex");
  return `${key.slice(0, 512 - digest.length - 1)}:${digest}`;
}

function browserDisplayName(value: unknown): string | undefined {
  const normalized = normalizedDisplayName(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("chrome") || normalized === "chromium") return "Chrome";
  if (normalized.includes("edge")) return "Microsoft Edge";
  if (normalized.includes("firefox")) return "Firefox";
  if (normalized.includes("safari")) return "Safari";
  if (normalized.includes("arc")) return "Arc";
  if (normalized === "iab" || normalized.includes("in-app")) return "Browser";
  return normalizedDisplayName(value);
}

function browserNativeAppReference(name: string): ToolActivityNativeAppReference | undefined {
  switch (name) {
    case "Chrome":
      return { _tag: "display-name", displayName: "Google Chrome" };
    case "Microsoft Edge":
    case "Firefox":
    case "Safari":
    case "Arc":
      return { _tag: "display-name", displayName: name };
    default:
      return undefined;
  }
}

function appDisplayNameFromId(appId: string): string | undefined {
  const knownNames: Readonly<Record<string, string>> = {
    "com.apple.finder": "Finder",
    "com.apple.safari": "Safari",
    "com.google.chrome": "Chrome",
    "com.microsoft.edgemac": "Microsoft Edge",
    "org.mozilla.firefox": "Firefox",
    "company.thebrowser.browser": "Arc",
  };
  return knownNames[appId.toLowerCase()];
}

function nativeAppReference(value: unknown): ToolActivityNativeAppReference | undefined {
  const app = asUnknownRecord(value);
  if (app?.kind === "appId") {
    const appId = normalizedAppId(app.appId);
    return appId ? { _tag: "app-id", appId } : undefined;
  }
  if (app?.kind === "displayName") {
    const displayName = normalizedDisplayName(app.displayName);
    return displayName ? { _tag: "display-name", displayName } : undefined;
  }
  return undefined;
}

function themedLogoIcon(
  ...records: ReadonlyArray<Record<string, unknown> | undefined>
): ToolActivityIcon | undefined {
  for (const record of records) {
    const logoUrl = normalizedImageUrl(record?.logoUrl);
    if (!logoUrl) continue;
    const logoUrlDark = normalizedImageUrl(record?.logoUrlDark ?? record?.logoDarkUrl);
    return {
      _tag: "themed-logo",
      logoUrl,
      ...(logoUrlDark ? { logoUrlDark } : {}),
    };
  }
  return undefined;
}

export interface McpToolPresentation {
  readonly toolSurface?: "browser" | "computer";
  readonly toolIcon?: ToolActivityIcon;
  readonly toolSource?: ToolActivitySource;
}

export function mcpToolPresentation(
  item: Extract<CodexLifecycleItem, { readonly type: "mcpToolCall" }>,
): McpToolPresentation {
  const result = asUnknownRecord(item.result);
  const metadata = asUnknownRecord(result?._meta);
  const surface = asUnknownRecord(metadata?.["codex/toolSurface"]);
  const sourceMetadata = asUnknownRecord(metadata?.source);
  const appContext = asUnknownRecord(item.appContext);
  const sourceLogo = themedLogoIcon(surface, sourceMetadata, appContext);
  if (surface?.kind === "browserUse") {
    const screenshot = asUnknownRecord(surface.screenshot);
    const browserUse = asUnknownRecord(metadata?.browser_use);
    const openTabs = Array.isArray(surface.openTabs) ? surface.openTabs : [];
    const latestOpenTab = openTabs
      .toReversed()
      .map(asUnknownRecord)
      .find((tab) => normalizedHttpUrl(tab?.url) !== undefined);
    const selectedPage = [
      { record: screenshot, url: screenshot?.pageUrl },
      { record: browserUse, url: browserUse?.url },
      { record: latestOpenTab, url: latestOpenTab?.url },
    ]
      .map((candidate) => ({ ...candidate, pageUrl: normalizedHttpUrl(candidate.url) }))
      .find((candidate) => candidate.pageUrl !== undefined);
    const pageUrl = selectedPage?.pageUrl;
    const faviconUrl = normalizedImageUrl(
      selectedPage?.record?.faviconUrl ?? selectedPage?.record?.favIconUrl,
    );
    const faviconUrlDark = normalizedImageUrl(
      selectedPage?.record?.faviconUrlDark ?? selectedPage?.record?.favIconUrlDark,
    );
    const name =
      browserDisplayName(appContext?.appName) ??
      browserDisplayName(surface.browserFamily) ??
      browserDisplayName(surface.backend) ??
      "Browser";
    const nativeBrowserIcon = browserNativeAppReference(name);
    const sourceIcon =
      sourceLogo ??
      (nativeBrowserIcon ? ({ _tag: "native-app", app: nativeBrowserIcon } as const) : undefined);
    const sourceKeyPart = normalizedSourceKeyPart(name) || "browser";
    return {
      toolSurface: "browser",
      ...(pageUrl
        ? {
            toolIcon: {
              _tag: "website",
              pageUrl,
              ...(faviconUrl ? { faviconUrl } : {}),
              ...(faviconUrlDark ? { faviconUrlDark } : {}),
            } as const,
          }
        : {}),
      toolSource: {
        key: `browser-use:${sourceKeyPart}`,
        name,
        kind: name === "Browser" ? "browser" : "integration",
        ...(sourceIcon ? { icon: sourceIcon } : {}),
      },
    };
  }
  if (surface?.kind === "computerUse") {
    const app = nativeAppReference(surface.app);
    const args = asUnknownRecord(item.arguments);
    const argumentAppName =
      normalizedDisplayName(args?.appName) ??
      normalizedDisplayName(args?.application) ??
      normalizedDisplayName(typeof args?.app === "string" ? args.app : undefined);
    const name =
      normalizedDisplayName(appContext?.appName) ??
      argumentAppName ??
      (app?._tag === "display-name" ? app.displayName : undefined) ??
      (app?._tag === "app-id" ? appDisplayNameFromId(app.appId) : undefined) ??
      "Computer Use";
    const sourceIcon = sourceLogo ?? (app ? ({ _tag: "native-app", app } as const) : undefined);
    const sourceKey = app
      ? app._tag === "app-id"
        ? nativeAppSourceKey(app.appId)
        : `native-app-name:${normalizedSourceKeyPart(app.displayName)}`
      : "computer-use";
    return {
      toolSurface: "computer",
      ...(app ? { toolIcon: { _tag: "native-app", app } as const } : {}),
      toolSource: {
        key: sourceKey,
        name,
        kind: "computer",
        ...(sourceIcon ? { icon: sourceIcon } : {}),
      },
    };
  }

  return {};
}
