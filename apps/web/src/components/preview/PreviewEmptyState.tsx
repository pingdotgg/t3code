import { T, useGT } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { parseUrl } from "@t3tools/shared/url";
import { Globe, Link } from "lucide-react";

import type { BrowserHistoryEntry } from "~/browserHistoryStore";
import { Button } from "~/components/ui/button";
import { LabeledSection } from "~/components/ui/labeled-section";

import { PreviewEmptyHero } from "./PreviewEmptyHero";
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
  const gt = useGT();
  const servers = useDiscoveredLocalServers({
    environmentId,
    configuredUrls,
  });
  const recents = recentEntries.filter((entry) => parseUrl(entry.url) !== null).slice(0, 8);

  return (
    <div className="scrollbar-gutter-both flex h-full min-h-0 overflow-y-auto px-4 pt-4 pb-6">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4.5">
        <PreviewEmptyHero
          icon={<Globe />}
          title={<T>No preview yet</T>}
          description={<T>Start a dev server or open a URL. Agents can open pages here too.</T>}
        >
          {onFocusUrl ? (
            <Button type="button" variant="secondary" size="xs" onClick={onFocusUrl}>
              <Link />
              <T>Open URL</T>
            </Button>
          ) : null}
        </PreviewEmptyHero>
        {servers.length > 0 ? (
          <LabeledSection label={gt("Local servers")}>
            {servers.map((server) => (
              <PreviewLocalServerCard
                key={`${server.host}:${server.port}`}
                server={server}
                onOpen={() => onOpenUrl(server.requestedUrl)}
              />
            ))}
          </LabeledSection>
        ) : null}
        {recents.length > 0 ? (
          <LabeledSection label={gt("Recently used")}>
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
          </LabeledSection>
        ) : null}
      </div>
    </div>
  );
}
