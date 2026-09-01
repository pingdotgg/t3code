import { ExternalLinkIcon, PaperclipIcon, PlayIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext, useMemo } from "react";
import type { Options as ReactMarkdownOptions } from "react-markdown";

import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { remarkPullRequestAutolinks, splitPullRequestBody } from "./pullRequestMarkdown.logic";

export const PullRequestMarkdownContext = createContext<string | null>(null);

/**
 * A pull request body, rendered with the app's markdown renderer plus a card for each upload
 * embedded in it, which that renderer drops on the floor.
 *
 * These upload URLs do not identify the media format. The card links to GitHub, where the
 * original upload can be opened or downloaded even when its codec cannot play in the client.
 */
export function PullRequestMarkdown({
  text,
  cwd,
  environmentId,
  className,
}: {
  text: string;
  cwd: string;
  environmentId: EnvironmentId;
  className?: string;
}) {
  const segments = splitPullRequestBody(text);
  const repositoryUrl = useContext(PullRequestMarkdownContext);
  const extraRemarkPlugins = useMemo<NonNullable<ReactMarkdownOptions["remarkPlugins"]>>(
    () => (repositoryUrl ? [[remarkPullRequestAutolinks, { repositoryUrl }]] : []),
    [repositoryUrl],
  );
  return (
    <div className={cn("space-y-3", className)}>
      {segments.map((segment) => {
        if (segment.kind === "markdown") {
          return (
            <ChatMarkdown
              key={segment.id}
              text={segment.text}
              cwd={cwd}
              environmentId={environmentId}
              extraRemarkPlugins={extraRemarkPlugins}
            />
          );
        }
        const isVideo = segment.media === "video";
        const Icon = isVideo ? PlayIcon : PaperclipIcon;
        return (
          // A plain anchor rather than the page's openExternal button: the desktop window
          // turns a blocked _blank into openExternal itself, and in a browser tab — where
          // there is no shell to call — this is the only one of the two that goes anywhere.
          <a
            key={segment.id}
            href={segment.url}
            rel="noreferrer noopener"
            target="_blank"
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm hover:bg-muted/60"
          >
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {isVideo ? "Play video on GitHub" : "Open attachment on GitHub"}
            </span>
            <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}
