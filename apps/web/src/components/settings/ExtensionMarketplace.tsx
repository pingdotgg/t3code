import { useState, type ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { sourceControlIcon } from "../../sourceControlPresentation";
import { definePluginComponent } from "~/plugins/features";

function sourceHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export const ExtensionIcon = definePluginComponent(
  "component:components/settings/ExtensionMarketplace/ExtensionIcon",
  function ExtensionIcon({
    iconUrl,
    fallback,
  }: {
    iconUrl?: string | undefined;
    fallback: ReactNode;
  }) {
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    return (
      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
        {iconUrl && failedUrl !== iconUrl ? (
          <img
            alt=""
            className="size-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
            src={iconUrl}
            onError={() => setFailedUrl(iconUrl)}
          />
        ) : (
          fallback
        )}
      </div>
    );
  },
);

export const SourceLinkIcon = definePluginComponent(
  "component:components/settings/ExtensionMarketplace/SourceLinkIcon",
  function SourceLinkIcon({ url }: { url: string }) {
    const host = sourceHost(url);
    const definition = host === null ? undefined : sourceControlClients.findByPublicDomain(host);
    const Icon = definition ? sourceControlIcon(definition) : ExternalLinkIcon;
    return <Icon className="size-3.5" />;
  },
);

export const ExtensionCard = definePluginComponent(
  "component:components/settings/ExtensionMarketplace/ExtensionCard",
  function ExtensionCard({
    name,
    byline,
    description,
    icon,
    children,
  }: {
    name: string;
    byline: ReactNode;
    description?: string | undefined;
    icon: ReactNode;
    children: ReactNode;
  }) {
    return (
      <article
        aria-label={name}
        className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 transition-colors hover:bg-accent/20"
      >
        <div className="flex min-w-0 gap-3">
          {icon}
          <div className="min-w-0 flex-1">
            <h4 className="truncate text-sm font-medium">{name}</h4>
            <p className="truncate text-muted-foreground text-xs">{byline}</p>
          </div>
        </div>
        {description ? (
          <p className="line-clamp-2 min-h-8 text-muted-foreground text-xs leading-4">
            {description}
          </p>
        ) : null}
        {children}
      </article>
    );
  },
);
