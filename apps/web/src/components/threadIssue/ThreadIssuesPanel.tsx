import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentScope } from "~/state/session";
import { threadIssueKeyOf, type ScopedThreadRef, type ThreadIssueLink } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CircleDotIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightOpenIcon,
  PlusIcon,
  UnlinkIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useIssueViewRefresh } from "~/hooks/useIssueViewRefresh";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { issueEnvironment } from "~/state/issues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { issueTrackerPresentation, IssueStateGlyph } from "../issue/issuePresentation";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { openLinkThreadIssueDialog } from "./LinkThreadIssueDialog";

function ThreadIssueRow({
  link,
  canUnlink,
  onOpen,
  onUnlink,
}: {
  link: ThreadIssueLink;
  canUnlink: boolean;
  onOpen: (link: ThreadIssueLink) => void;
  onUnlink: (link: ThreadIssueLink) => void;
}) {
  const tracker = issueTrackerPresentation(link.tracker);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className="group/issue-row relative flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {link.snapshot ? (
        <IssueStateGlyph state={link.snapshot.state} />
      ) : (
        <CircleDotIcon className="size-4 shrink-0" />
      )}
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col items-start text-left"
        onClick={() => onOpen(link)}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {link.snapshot?.displayKey ?? link.key}
          </span>
          <span className="min-w-0 truncate text-sm">{link.snapshot?.title ?? link.url}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <tracker.Icon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">
            {tracker.providerName} · {link.snapshot?.state.name ?? "Not read yet"} · updated{" "}
            {formatRelativeTimeLabel(link.snapshot?.syncedAt ?? link.linkedAt)}
          </span>
        </span>
      </button>
      <span className="flex opacity-0 group-hover/issue-row:opacity-100 has-[:focus-visible]:opacity-100 has-[[data-popup-open]]:opacity-100">
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label={`Actions for ${link.snapshot?.displayKey ?? link.key}`}
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <MenuPopup align="end">
            <MenuItem onClick={() => onOpen(link)}>
              <PanelRightOpenIcon className="size-3.5" />
              Open in panel
            </MenuItem>
            <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(link.url)}>
              <ArrowUpRightIcon className="size-3.5" />
              Open in {tracker.providerName}
            </MenuItem>
            <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>
              <LinkIcon className="size-3.5" />
              Copy link
            </MenuItem>
            {canUnlink ? (
              <MenuItem onClick={() => onUnlink(link)}>
                <UnlinkIcon className="size-3.5" />
                Unlink from thread
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </span>
    </div>
  );
}

export function ThreadIssuesPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const environmentId = threadRef.environmentId;
  const thread = useThreadShell(threadRef);
  const canRefresh = useAtomValue(
    issueEnvironment.refreshThreadLinks.permissionAtom(environmentId),
  );
  const refresh = useAtomCommand(issueEnvironment.refreshThreadLinks, {
    reportFailure: false,
  });
  const unlink = useAtomCommand(threadEnvironment.unlinkIssue, { reportFailure: true });
  const canUnlink = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canLink = canUnlink;
  const refreshedThread = useRef<string | null>(null);
  const threadKey = `${environmentId}:${threadRef.threadId}`;
  const [refreshError, setRefreshError] = useState({
    threadKey,
    canRefresh,
    error: null as string | null,
  });
  if (refreshError.threadKey !== threadKey || refreshError.canRefresh !== canRefresh)
    setRefreshError({ threadKey, canRefresh, error: null });
  const refreshLinks = () => {
    if (!canRefresh) return;
    void refresh({ environmentId, input: { threadId: threadRef.threadId } }).then((result) => {
      if (refreshedThread.current !== threadKey) return;
      setRefreshError({
        threadKey,
        canRefresh,
        error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      });
    });
  };
  const refreshOnScopeChange = useEffectEvent(refreshLinks);
  useEffect(() => {
    refreshedThread.current = threadKey;
    if (canRefresh) refreshOnScopeChange();
  }, [canRefresh, threadKey]);
  useIssueViewRefresh(refreshLinks, [], threadKey);

  const items = thread?.issues ?? [];
  const openIssue = (link: ThreadIssueLink) =>
    useRightPanelStore.getState().openIssue(threadRef, link);
  const handleUnlink = (link: ThreadIssueLink) =>
    void unlink({ environmentId, input: { threadId: threadRef.threadId, ...link } });
  const synced = items
    .flatMap((link) => (link.snapshot ? [link.snapshot.syncedAt] : []))
    .toSorted()
    .at(-1);
  const error = refreshError.error;

  if (items.length === 0) {
    return (
      <Empty className="scrollbar-gutter-both min-h-0 justify-center-safe overflow-y-auto">
        <EmptyMedia variant="icon">
          <CircleDotIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{thread === null ? "Loading linked issues" : "No linked issues"}</EmptyTitle>
          <EmptyDescription>
            {error ?? "Link the issues this thread works on to keep their state in view."}
          </EmptyDescription>
        </EmptyHeader>
        <Button
          size="sm"
          variant="outline"
          disabled={!canLink}
          onClick={() => openLinkThreadIssueDialog(threadRef)}
        >
          <PlusIcon className="size-3.5" />
          Link issue
        </Button>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1.5">
          {items.map((link) => (
            <ThreadIssueRow
              key={threadIssueKeyOf(link)}
              link={link}
              canUnlink={canUnlink}
              onOpen={openIssue}
              onUnlink={handleUnlink}
            />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {items.filter((link) => link.snapshot?.state.category === "open").length} open ·{" "}
          {items.length} linked
          {error ? ` · ${error}` : synced ? ` · synced ${formatRelativeTimeLabel(synced)}` : ""}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={!canLink}
          onClick={() => openLinkThreadIssueDialog(threadRef)}
        >
          <PlusIcon className="size-3.5" />
          Link
        </Button>
      </footer>
    </div>
  );
}
