import { useEffect, useState } from "react";

import { ClaudeAI, CursorIcon, OpenAI, type Icon } from "~/components/Icons";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  MARKETPLACE_HARNESS_LABELS,
  type MarketplaceHarnessId,
  type MarketplaceHarnessSupport,
  type MarketplacePlugin,
} from "~/pluginMarketplace/catalog";
import { fetchPluginMarketplaceLogo } from "~/pluginMarketplace/api";

const HARNESS_ICONS: Readonly<Record<MarketplaceHarnessId, Icon>> = {
  codex: OpenAI,
  claude: ClaudeAI,
  cursor: CursorIcon,
};

const FALLBACK_LOGO_STYLES = [
  "bg-blue-500/16 text-blue-700 dark:text-blue-300",
  "bg-emerald-500/16 text-emerald-700 dark:text-emerald-300",
  "bg-violet-500/16 text-violet-700 dark:text-violet-300",
  "bg-amber-500/16 text-amber-700 dark:text-amber-300",
  "bg-rose-500/16 text-rose-700 dark:text-rose-300",
  "bg-cyan-500/16 text-cyan-700 dark:text-cyan-300",
] as const;

const localLogoRequests = new Map<string, Promise<string | null>>();

function loadLocalPluginLogo(pluginId: string): Promise<string | null> {
  const existing = localLogoRequests.get(pluginId);
  if (existing) return existing;
  const request = fetchPluginMarketplaceLogo(pluginId)
    .then((result) => {
      if (result.dataUrl === null) localLogoRequests.delete(pluginId);
      return result.dataUrl;
    })
    .catch(() => {
      localLogoRequests.delete(pluginId);
      return null;
    });
  localLogoRequests.set(pluginId, request);
  return request;
}

function PluginFallbackIcon({
  name,
  packageName,
}: {
  readonly name: string;
  readonly packageName: string;
}) {
  const label =
    name
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.slice(0, 1).toLocaleUpperCase())
      .join("") || packageName.slice(0, 1).toLocaleUpperCase();
  const styleIndex = [...packageName].reduce(
    (total, character) => total + character.charCodeAt(0),
    0,
  );
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-full items-center justify-center font-semibold text-xs tracking-tight",
        FALLBACK_LOGO_STYLES[styleIndex % FALLBACK_LOGO_STYLES.length],
      )}
    >
      {label}
    </span>
  );
}

export function PluginLogo({
  plugin,
  size = "default",
  className,
}: {
  readonly plugin: Pick<
    MarketplacePlugin,
    "hasLocalLogo" | "id" | "logoDataUrl" | "logoUrl" | "name" | "packageName"
  >;
  readonly size?: "small" | "default" | "large";
  readonly className?: string;
}) {
  const [localLogo, setLocalLogo] = useState<{
    readonly pluginId: string;
    readonly dataUrl: string | null;
  } | null>(null);
  const [failedImage, setFailedImage] = useState<{
    readonly pluginId: string;
    readonly source: string;
  } | null>(null);
  useEffect(() => {
    if (!plugin.hasLocalLogo || plugin.logoDataUrl) return;
    let active = true;
    void loadLocalPluginLogo(plugin.id).then((dataUrl) => {
      if (active) setLocalLogo({ pluginId: plugin.id, dataUrl });
    });
    return () => {
      active = false;
    };
  }, [plugin.hasLocalLogo, plugin.id, plugin.logoDataUrl]);

  const localLogoDataUrl = localLogo?.pluginId === plugin.id ? localLogo.dataUrl : null;
  const source =
    plugin.logoDataUrl ?? localLogoDataUrl ?? (plugin.hasLocalLogo ? null : plugin.logoUrl);
  const showImage =
    source !== null && (failedImage?.pluginId !== plugin.id || failedImage.source !== source);
  return (
    <div
      aria-label={`${plugin.name} logo`}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border border-foreground/8 bg-foreground/5 text-foreground outline-1 -outline-offset-1 outline-white/8",
        size === "small" && "size-9 rounded-lg",
        size === "default" && "size-11 rounded-xl sm:size-10",
        size === "large" && "size-16 rounded-2xl",
        className,
      )}
      role="img"
    >
      {showImage ? (
        <img
          alt=""
          aria-hidden="true"
          className="size-full object-cover"
          referrerPolicy="no-referrer"
          src={source ?? undefined}
          onError={() => setFailedImage({ pluginId: plugin.id, source })}
        />
      ) : (
        <PluginFallbackIcon name={plugin.name} packageName={plugin.packageName} />
      )}
    </div>
  );
}

export function HarnessIcon({
  harness,
  className,
}: {
  readonly harness: MarketplaceHarnessId;
  readonly className?: string;
}) {
  const Icon = HARNESS_ICONS[harness];
  return <Icon aria-hidden="true" className={cn("aspect-square size-3.5 shrink-0", className)} />;
}

function supportLabel(support: MarketplaceHarnessSupport): string {
  const contents = [
    support.mcp ? "MCP" : null,
    support.skills ? "skills" : null,
    support.apps ? "apps" : null,
  ].filter(Boolean);
  return contents.length > 0
    ? `${MARKETPLACE_HARNESS_LABELS[support.harness]}: ${contents.join(" + ")}`
    : `${MARKETPLACE_HARNESS_LABELS[support.harness]} plugin available`;
}

export function HarnessSupportBadges({
  support,
  compact = true,
}: {
  readonly support: ReadonlyArray<MarketplaceHarnessSupport>;
  readonly compact?: boolean;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      role="group"
      aria-label="Supported harnesses"
    >
      {support.map((entry) => {
        const label = supportLabel(entry);
        return (
          <Tooltip key={entry.harness}>
            <TooltipTrigger
              render={
                <Badge
                  size="sm"
                  variant="outline"
                  role="img"
                  aria-label={label}
                  className={cn(
                    "overflow-visible bg-background/68 text-muted-foreground",
                    compact
                      ? "size-5 min-w-5 px-0 sm:size-5 sm:h-5 sm:min-w-5"
                      : "h-auto min-h-5 py-1 pr-2 pl-1 sm:h-auto",
                  )}
                />
              }
            >
              <HarnessIcon harness={entry.harness} className={compact ? "size-3" : "size-3.5"} />
              {compact ? null : <span>{MARKETPLACE_HARNESS_LABELS[entry.harness]}</span>}
            </TooltipTrigger>
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}
