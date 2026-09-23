import { ExternalLinkIcon, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { GitHubIcon, GitLabIcon } from "../Icons";
import { Button } from "../ui/button";

export const DOWNLOAD_FORMAT = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function SourceLinkIcon({ url }: { url: string }) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (host === "github.com" || host.endsWith(".github.com"))
    return <GitHubIcon className="size-3.5" />;
  if (host === "gitlab.com" || host.endsWith(".gitlab.com"))
    return <GitLabIcon className="size-3.5" monochrome />;
  return <ExternalLinkIcon className="size-3.5" />;
}

export function OpenVsxExtensionIcon({
  iconUrl,
  fallbackIcon: FallbackIcon,
}: {
  iconUrl: string | null;
  fallbackIcon: LucideIcon;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
      {iconUrl && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={iconUrl}
          onError={() => setFailed(true)}
        />
      ) : (
        <FallbackIcon className="size-4" />
      )}
    </div>
  );
}

export function OpenVsxResultCard({
  name,
  subtitle,
  description,
  iconUrl,
  fallbackIcon,
  sourceUrl,
  action,
}: {
  name: string;
  subtitle: string;
  description: string;
  iconUrl: string | null;
  fallbackIcon: LucideIcon;
  sourceUrl?: string | null;
  action: ReactNode;
}) {
  return (
    <article className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 transition-colors hover:bg-accent/20">
      <div className="flex min-w-0 gap-3">
        <OpenVsxExtensionIcon key={iconUrl} iconUrl={iconUrl} fallbackIcon={fallbackIcon} />
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-medium">{name}</h4>
          <p className="truncate text-muted-foreground text-xs">{subtitle}</p>
        </div>
      </div>
      <p className="line-clamp-2 min-h-8 text-muted-foreground text-xs leading-4">{description}</p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {sourceUrl ? (
            <Button
              aria-label={`View source for ${name}`}
              render={<a href={sourceUrl} rel="noreferrer" target="_blank" />}
              size="icon-micro"
              variant="ghost-muted"
            >
              <SourceLinkIcon url={sourceUrl} />
            </Button>
          ) : null}
        </div>
        {action}
      </div>
    </article>
  );
}
