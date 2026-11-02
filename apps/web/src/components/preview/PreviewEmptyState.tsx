import type { EnvironmentId } from "@t3tools/contracts";
import { Globe, Link } from "lucide-react";

import type { BrowserHistoryEntry } from "~/browserHistoryStore";
import { Button } from "~/components/ui/button";

import { PreviewLocalServerCard } from "./PreviewLocalServerCard";
import { PreviewRecentUrlCard } from "./PreviewRecentUrlCard";
import { useDiscoveredLocalServers } from "./useDiscoveredLocalServers";

interface Props {
  environmentId: EnvironmentId;
  configuredUrls?: ReadonlyArray<string> | undefined;
  recentEntries: ReadonlyArray<BrowserHistoryEntry>;
  onRemoveRecent: (url: string) => void;
  onOpenUrl: (url: string) => void;
  /** Focuses the chrome row's address field. */
  onFocusUrl?: () => void;
}

/**
 * The browser's blank tab: a hero that points at the address field, then live
 * local servers, then recently visited pages.
 */
export function PreviewEmptyState({
  environmentId,
  configuredUrls,
  recentEntries,
  onRemoveRecent,
  onOpenUrl,
  onFocusUrl,
}: Props) {
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
  });
  const recents = recentEntries.filter((entry) => URL.canParse(entry.url)).slice(0, 8);

  return (
    <div className="scrollbar-gutter-both flex h-full min-h-0 overflow-y-auto px-4 pt-4 pb-6">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4.5">
        <div className="flex flex-col items-center gap-2.5 px-4 py-6 text-center">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full surface-raised">
            <Globe aria-hidden className="size-4.5 text-muted-foreground" />
          </span>
          <h2 className="text-label text-foreground">No preview yet</h2>
          <p className="max-w-[300px] text-balance text-body text-muted-foreground">
            Start a dev server or open a URL. Agents can open pages here too.
          </p>
          {onFocusUrl ? (
            <div className="pt-1.5">
              <Button type="button" variant="secondary" size="xs" onClick={onFocusUrl}>
                <Link />
                Open URL
              </Button>
            </div>
          ) : null}
        </div>
        {servers.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-meta font-medium text-dim-foreground">Local servers</h3>
            {servers.map((server) => (
              <PreviewLocalServerCard
                key={`${server.host}:${server.port}`}
                server={server}
                onOpen={() => onOpenUrl(server.requestedUrl)}
              />
            ))}
          </section>
        ) : null}
        {recents.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-meta font-medium text-dim-foreground">Recently used</h3>
            <div className="flex flex-col">
              {recents.map((entry) => (
                <PreviewRecentUrlCard
                  key={entry.url}
                  entry={entry}
                  onOpen={() => onOpenUrl(entry.url)}
                  onRemove={() => onRemoveRecent(entry.url)}
                />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
