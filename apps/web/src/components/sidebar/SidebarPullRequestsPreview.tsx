import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { AlarmClockIcon, CircleDashedIcon } from "lucide-react";
import { type MouseEvent, useCallback, useMemo, useState } from "react";

import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { cn } from "../../lib/utils";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useLinkedThreadPullRequest } from "../ThreadStatusIndicators";
import {
  collectPullRequestPreviewEntries,
  type PullRequestPreviewEntry,
} from "./SidebarPullRequestsPreview.logic";

const MAX_PULL_REQUEST_ROWS = 8;

type OpenPullRequest = (
  event: MouseEvent<HTMLAnchorElement>,
  entry: PullRequestPreviewEntry,
  url: string,
) => void;

function PullRequestPreviewRow({
  entry,
  onOpen,
}: {
  readonly entry: PullRequestPreviewEntry;
  readonly onOpen: OpenPullRequest;
}) {
  const detail = useLinkedThreadPullRequest(entry.thread.environmentId, entry.reference);
  const pr = detail?.pr ?? null;
  const state = pr
    ? resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft === true })
    : null;
  const title = pr?.title ?? entry.thread.branch ?? entry.thread.title;
  const url = pr?.url ?? entry.reference.url;
  const Icon = state?.Icon ?? CircleDashedIcon;
  return (
    <li>
      {/* A real link, like the sidebar badge: cmd/ctrl+click and middle-click
          open the host, a plain click opens T3's pull request view. */}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => onOpen(event, entry, url)}
        className={cn(
          "group/pr-preview -mx-1 flex items-center gap-2 rounded-sm px-1 leading-5 underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          entry.snoozed && "text-muted-foreground",
        )}
      >
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-0.5 tabular-nums",
            state?.toneClassName ?? "text-muted-foreground/60",
          )}
        >
          <Icon role="img" aria-label={state?.label ?? "Loading"} className="size-3 shrink-0" />
          <span className="group-hover/pr-preview:underline">#{entry.reference.number}</span>
        </span>
        <span className="min-w-0 truncate group-hover/pr-preview:underline">{title}</span>
        {entry.snoozed ? (
          <AlarmClockIcon aria-label="Snoozed" className="ms-auto size-3 shrink-0 opacity-70" />
        ) : null}
      </a>
    </li>
  );
}

/**
 * The pull requests behind the sidebar's active and snoozed threads, for a
 * glance before opening the page. The footer item supplies the frame and
 * heading. Mounted only while the popover is open, so the footer itself never
 * subscribes to thread state.
 */
export function SidebarPullRequestsPreview() {
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  // One clock per open: the popover is short-lived and must not tick.
  const [now] = useState(() => new Date().toISOString());
  const entries = useMemo(() => {
    const capabilities = new Map(
      [...serverConfigs].map(([id, config]) => [id, config.environment.capabilities] as const),
    );
    return collectPullRequestPreviewEntries(threads, capabilities, now);
  }, [now, serverConfigs, threads]);
  const openPrLink = useOpenPrLink();
  const router = useRouter();
  const handleOpen = useCallback<OpenPullRequest>(
    (event, entry, url) => {
      const threadRef = scopeThreadRef(entry.thread.environmentId, entry.thread.id);
      // Opened in the right panel: go to the thread that owns it, as the sidebar badge does.
      if (openPrLink(event, url, threadRef)) {
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      }
    },
    [openPrLink, router],
  );
  const visible = entries.slice(0, MAX_PULL_REQUEST_ROWS);
  const hidden = entries.length - visible.length;

  if (entries.length === 0) {
    return (
      <span className="leading-5 text-muted-foreground">
        No pull requests on your active threads.
      </span>
    );
  }
  return (
    <ul className="flex flex-col">
      {visible.map((entry) => (
        <PullRequestPreviewRow
          key={scopedThreadKey(scopeThreadRef(entry.thread.environmentId, entry.thread.id))}
          entry={entry}
          onOpen={handleOpen}
        />
      ))}
      {hidden > 0 ? <li className="leading-5 text-muted-foreground">+{hidden} more</li> : null}
    </ul>
  );
}
