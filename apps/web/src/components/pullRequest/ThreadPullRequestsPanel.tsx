import type { ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import {
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { ArrowUpRightIcon, LinkIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "@t3tools/i18n/react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openLinkPullRequestDialog } from "./LinkPullRequestDialog";
import { pullRequestListLines, type PullRequestListLine } from "./pullRequestListLines";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowBranches,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "./PullRequestListRow";
import {
  PullRequestDiffStat,
  PullRequestReviewDecisionGlyph,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";

const SOURCE_LABEL_KEYS = {
  manual: "linkedByYou",
  created: "createdFromThisThread",
  agent: "linkedByAgent",
  stack: "foundInStack",
  "stack-dismissed": "dismissedSource",
} as const satisfies Record<
  ThreadPullRequestLink["source"],
  "linkedByYou" | "createdFromThisThread" | "linkedByAgent" | "foundInStack" | "dismissedSource"
>;

function ChecksGlyph({
  state,
}: {
  state: NonNullable<ThreadPullRequestLink["snapshot"]>["checksState"] & string;
}) {
  const { t } = useTranslation("pullRequests");
  const presentation = pullRequestChecksStatePresentation(state, t);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <presentation.Icon
          role="img"
          aria-label={presentation.label}
          className={cn("size-3.5", presentation.toneClassName)}
        />
      </TooltipTrigger>
      <TooltipPopup>{presentation.label}</TooltipPopup>
    </Tooltip>
  );
}

function LinkRow({
  line,
  threadRef,
  onUnlink,
}: {
  line: PullRequestListLine;
  threadRef: ScopedThreadRef;
  onUnlink: (link: ThreadPullRequestLink) => void;
}) {
  const { t, i18n } = useTranslation("pullRequests");
  const openPrLink = useOpenPrLink(threadRef);
  const { link, depth, stack } = line;
  const snapshot = link.snapshot;
  return (
    <div
      className={cn(PULL_REQUEST_ROW_CLASS, "relative hover:bg-accent/60")}
      // Each layer steps in under the one it targets. The step is capped: beyond a few layers
      // the indent only says "still in the stack", which the connector line already does, and
      // a sixteen-layer stack would otherwise stair-step off the right edge.
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? <span aria-hidden className="-ml-2 h-6 w-px shrink-0 bg-border/70" /> : null}
      {snapshot === null ? (
        <PullRequestGlyph.pullRequest
          aria-label={t("waitingForHostState")}
          className="size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        <PullRequestRowGlyph
          state={snapshot.state}
          isDraft={snapshot.isDraft}
          mergeability={snapshot.mergeability}
          baseBranch={snapshot.baseBranch}
        />
      )}
      <a
        href={link.url}
        onClick={(event) => openPrLink(event, link.url, threadRef)}
        className="flex min-w-0 flex-1"
      >
        <PullRequestRowLines
          number={
            <Tooltip>
              <TooltipTrigger render={<span className={PULL_REQUEST_ROW_NUMBER_CLASS} />}>
                #{link.number}
              </TooltipTrigger>
              <TooltipPopup>
                {t(SOURCE_LABEL_KEYS[link.source])} · {formatRelativeTimeLabel(link.linkedAt)}
              </TooltipPopup>
            </Tooltip>
          }
          title={snapshot?.title ?? link.repository}
          signals={
            snapshot?.state === "open" ? (
              <>
                {snapshot.checksState ? <ChecksGlyph state={snapshot.checksState} /> : null}
                {snapshot.reviewDecision ? (
                  <PullRequestReviewDecisionGlyph decision={snapshot.reviewDecision} />
                ) : null}
              </>
            ) : null
          }
          // Match the full PR list: diff counts up top, checks under the lifecycle glyph, the
          // verdict by the author. Each is absent rather than neutral when the host said
          // nothing, so a row without them reads as unknown, not as fine.
          status={
            <PullRequestDiffStat
              additions={snapshot?.additions ?? 0}
              deletions={snapshot?.deletions ?? 0}
              className="font-mono"
            />
          }
          meta={
            <>
              {stack ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-foreground/70" />
                    }
                  >
                    <PullRequestGlyph.stack aria-hidden className="size-3" />
                    {stack.size}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {stack.kind === "native"
                      ? t("githubStackDescription", {
                          amount: new Intl.NumberFormat(i18n.resolvedLanguage).format(stack.size),
                        })
                      : t("chainedPullRequestsDescription", {
                          amount: new Intl.NumberFormat(i18n.resolvedLanguage).format(stack.size),
                        })}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {snapshot?.author ? (
                <PullRequestRowAuthor
                  actor={snapshot.author}
                  className="shrink-0"
                  labelClassName="max-w-28"
                />
              ) : null}
              {snapshot !== null ? (
                <>
                  {/* Cut in the middle: rows from one owner differ in the repository name at the
                      end, which a tail cut would hide. */}
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex min-w-0 max-w-32 font-mono" />}>
                      <MiddleTruncate value={link.repository} showTitle={false} />
                    </TooltipTrigger>
                    <TooltipPopup>{link.repository}</TooltipPopup>
                  </Tooltip>
                  <PullRequestRowBranches head={snapshot.headBranch} base={snapshot.baseBranch} />
                </>
              ) : (
                <span className="truncate font-mono">
                  {link.host}/{link.repository}
                </span>
              )}
            </>
          }
          updatedAt={snapshot?.updatedAt}
        />
      </a>
      {/* Out of the row's flow, so no row reserves a column for a button only the hovered one
          shows. It sits over the right end of the second line on the row's own hover color,
          fading in from the left, so it covers the time and leaves the diff counts alone. */}
      <span
        className={cn(
          "absolute right-0 bottom-0.5 flex items-center rounded-r-md bg-background pr-1 pl-5",
          "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
          // Hidden means untouchable too: on a touch screen there is no hover, and an invisible
          // layer over the right of the row would otherwise swallow the tap meant for the link.
          "pointer-events-none opacity-0 group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
          "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
          "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
        )}
      >
        <span aria-hidden className="absolute inset-0 bg-accent/60" />
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label={t("actionsForPullRequest", { number: link.number })}
                className="relative"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <MenuPopup align="end" side="bottom">
            <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>
              <LinkIcon className="size-3.5" />
              {t("copyLink")}
            </MenuItem>
            <MenuItem onClick={(event) => openPrLink(event, link.url, threadRef)}>
              <ArrowUpRightIcon className="size-3.5" />
              {t("open")}
            </MenuItem>
            <MenuItem onClick={() => onUnlink(link)}>
              <PullRequestGlyph.unlink className="size-3.5" />
              {link.source === "stack" ? t("dismissFromThread") : t("unlinkFromThread")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    </div>
  );
}

export function ThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { t } = useTranslation("pullRequests");
  const configs = useServerConfigs();
  if (configs.get(threadRef.environmentId)?.environment.capabilities.threadPullRequests !== true) {
    return (
      <PullRequestsUnavailableState
        title={t("linkedPullRequestsUnavailable")}
        error={t("multipleLinkedPullRequestsUnsupported")}
      />
    );
  }
  return <EnabledThreadPullRequestsPanel threadRef={threadRef} />;
}

function EnabledThreadPullRequestsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { t, i18n } = useTranslation("pullRequests");
  const thread = useThreadShell(threadRef);
  const openLinkDialog = useCallback(() => openLinkPullRequestDialog(threadRef), [threadRef]);
  const unlink = useAtomCommand(threadEnvironment.unlinkPullRequest, { reportFailure: true });
  const links = useMemo(() => visibleThreadPullRequests(thread?.pullRequests ?? []), [thread]);
  const lines = useMemo(() => pullRequestListLines(resolveThreadPullRequestChains(links)), [links]);
  const handleUnlink = useCallback(
    (link: ThreadPullRequestLink) => {
      void unlink({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          host: link.host,
          repository: link.repository,
          number: link.number,
        },
      });
    },
    [threadRef, unlink],
  );
  const openCount = useMemo(
    () => links.filter((link) => link.snapshot === null || link.snapshot.state === "open").length,
    [links],
  );
  const lastSynced = useMemo(() => {
    let latest: string | null = null;
    for (const link of links) {
      const at = link.snapshot?.syncedAt;
      if (at !== undefined && (latest === null || at > latest)) latest = at;
    }
    return latest;
  }, [links]);

  if (links.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <PullRequestGlyph.link aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">{t("noLinkedPullRequests")}</p>
        <p className="max-w-60 text-xs text-muted-foreground">{t("pullRequestsFromThreadHelp")}</p>
        <Button size="sm" variant="outline" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          {t("linkPullRequest")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1.5">
          {lines.map((line) => (
            <LinkRow
              key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
              line={line}
              threadRef={threadRef}
              onUnlink={handleUnlink}
            />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {t("openAndLinkedCounts", {
            open: new Intl.NumberFormat(i18n.resolvedLanguage).format(openCount),
            linked: new Intl.NumberFormat(i18n.resolvedLanguage).format(links.length),
          })}
          {lastSynced ? ` · ${t("syncedAt", { time: formatRelativeTimeLabel(lastSynced) })}` : ""}
        </span>
        <Button size="xs" variant="ghost" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          {t("link")}
        </Button>
      </footer>
    </div>
  );
}
