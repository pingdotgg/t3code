import { ThreadDetailsControl } from "./ThreadDetailsControl";
import type { ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import { threadPullRequestKeyOf } from "@t3tools/shared/threadPullRequests";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Minus, Plus } from "lucide";
import {
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { threadEnvironment } from "~/state/threads";

import { MorphIcon } from "~/components/MorphIcon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";
import {
  prRailBlocker,
  prRailItems,
  threadDetailsPrGroups,
  type PrRailBlocker,
  type PrRailGroup,
} from "./threadDetailsPrRail.logic";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./threadDetailsPanelStyles";

const BLOCKER_LABEL: Record<PrRailBlocker, string> = {
  failing: "checks failing",
  conflicting: "has conflicts",
  draft: "is a draft",
  closed: "is closed",
};

function dotToneOf(link: ThreadPullRequestLink) {
  const snapshot = link.snapshot;
  if (snapshot === null) return "text-muted-foreground";
  if (snapshot.state === "open" && !snapshot.isDraft) {
    if (snapshot.checksState === "failing" || snapshot.mergeability === "conflicting") {
      return "text-destructive";
    }
    if (snapshot.checksState === "pending") return "text-warning";
  }
  return resolvePullRequestState(snapshot).toneClassName;
}

// Each row draws its own slice of the rail, so the line breaks around the full current row.
function RailCell({ dot }: { dot?: string }) {
  return (
    <span className="relative flex w-4 shrink-0 self-stretch items-center justify-center before:absolute before:-inset-y-1 before:left-1/2 before:w-px before:bg-muted-foreground/40">
      {dot ? <span className={cn("relative size-2 rounded-full bg-current", dot)} /> : null}
    </span>
  );
}

function ThreadDetailsPrCompactRow({
  link,
  rail,
  onOpen,
  onStopWatching,
}: {
  link: ThreadPullRequestLink;
  rail: boolean;
  onOpen: (event: ReactMouseEvent<HTMLElement>) => void;
  onStopWatching: (() => void) | undefined;
}) {
  const snapshot = link.snapshot;
  return (
    <div className="flex w-full min-w-0 items-center">
      <ThreadDetailsControl
        variant="ghost"
        size="sm"
        part="row"
        aria-label={link.url}
        onClick={onOpen}
        onAuxClick={onOpen}
      >
        {rail ? (
          <RailCell dot={dotToneOf(link)} />
        ) : (
          <PullRequestGlyph.pullRequest className={cn("size-4 shrink-0", dotToneOf(link))} />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            THREAD_DETAILS_PANEL_LABEL_CLASS,
            snapshot?.state === "merged" && "text-muted-foreground",
          )}
        >
          {snapshot?.title ?? link.url}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{link.number}</span>
      </ThreadDetailsControl>
      {onStopWatching && (snapshot?.state ?? "open") === "open" ? (
        <ThreadDetailsControl
          type="button"
          variant="ghost"
          size="sm"
          part="icon"
          className="group/watch"
          aria-label={`Stop watching #${link.number}`}
          onClick={onStopWatching}
        >
          <EyeIcon aria-hidden className="size-3.5 group-hover/watch:hidden" />
          <EyeOffIcon aria-hidden className="hidden size-3.5 group-hover/watch:block" />
        </ThreadDetailsControl>
      ) : null}
    </div>
  );
}

function ThreadDetailsPrRail({
  group,
  currentLink,
  currentRow,
  unfolded,
  onUnfold,
  renderRow,
}: {
  group: PrRailGroup;
  currentLink: ThreadPullRequestLink | null;
  currentRow: ReactNode;
  unfolded: boolean;
  onUnfold: () => void;
  renderRow: (link: ThreadPullRequestLink, rail: boolean) => ReactNode;
}) {
  const currentKey = currentLink === null ? null : threadPullRequestKeyOf(currentLink);
  const blocker = prRailBlocker(group.layers);
  return (
    <div data-thread-details-pr-stack className="flex flex-col">
      <div className="flex h-7 items-center gap-2.5 px-2.5 text-xs text-muted-foreground">
        <PullRequestGlyph.stack aria-hidden className="size-4 shrink-0" />
        <span className="font-medium text-foreground/80">Stack of {group.layers.length}</span>
        {group.base ? <span className="min-w-0 truncate">→ {group.base}</span> : null}
      </div>
      {prRailItems(group.layers, currentLink, unfolded).map((item) => {
        if (item.kind === "fold") {
          return (
            <ThreadDetailsControl
              key={`fold:${threadPullRequestKeyOf(item.first)}`}
              variant="ghost"
              size="sm"
              part="row"
              tone="muted"
              onClick={onUnfold}
            >
              <RailCell />
              {item.count} more
            </ThreadDetailsControl>
          );
        }
        const key = threadPullRequestKeyOf(item.link);
        return key === currentKey ? (
          <div key={key}>{currentRow}</div>
        ) : (
          <div key={key}>{renderRow(item.link, true)}</div>
        );
      })}
      {group.base ? (
        <div className="flex h-6 items-center gap-2.5 px-2.5 text-xs text-muted-foreground">
          <span aria-hidden className="flex w-4 shrink-0 justify-center">
            ↳
          </span>
          <span className="min-w-0 truncate">{group.base}</span>
        </div>
      ) : null}
      {blocker ? (
        <p className="px-2.5 pb-1 text-xs text-destructive">
          #{blocker.link.number} {BLOCKER_LABEL[blocker.reason]}, so the stack cannot merge
        </p>
      ) : null}
    </div>
  );
}

export function ThreadDetailsPrRows({
  threadRef,
  links,
  currentLink,
  onOpenLink,
  ...row
}: ComponentProps<typeof ThreadDetailsPrRow> & {
  threadRef: ScopedThreadRef;
  links: ReadonlyArray<ThreadPullRequestLink>;
  currentLink: ThreadPullRequestLink | null;
  onOpenLink: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const watch = useAtomCommand(threadEnvironment.watchPullRequest, { reportFailure: true });
  const stopWatching = (link: ThreadPullRequestLink | null) =>
    link?.watch === undefined
      ? undefined
      : () =>
          void watch({
            environmentId: threadRef.environmentId,
            input: {
              threadId: threadRef.threadId,
              host: link.host,
              repository: link.repository,
              number: link.number,
              watching: false,
            },
          });
  const currentRow = <ThreadDetailsPrRow {...row} onStopWatching={stopWatching(currentLink)} />;
  if (currentLink === null) return currentRow;
  const { current, others } = threadDetailsPrGroups(links, currentLink);
  const hiddenCount = others.reduce((count, group) => count + group.layers.length, 0);
  if ((current === null || current.layers.length === 1) && hiddenCount === 0) return currentRow;

  // Rows other than the current one render from the stored snapshot: one live query per row
  // would poll the host for every pull request in a long stack.
  const renderRow = (link: ThreadPullRequestLink, rail: boolean) => (
    <ThreadDetailsPrCompactRow
      link={link}
      rail={rail}
      onOpen={(event) => onOpenLink(event, link.url)}
      onStopWatching={stopWatching(link)}
    />
  );
  const renderGroup = (group: PrRailGroup, withCurrent: boolean) =>
    group.layers.length === 1 ? (
      withCurrent ? (
        currentRow
      ) : (
        <div key={group.key}>{renderRow(group.layers[0]!, false)}</div>
      )
    ) : (
      <ThreadDetailsPrRail
        key={group.key}
        group={group}
        currentLink={withCurrent ? currentLink : null}
        currentRow={currentRow}
        unfolded={unfolded.has(group.key)}
        onUnfold={() => setUnfolded((previous) => new Set(previous).add(group.key))}
        renderRow={renderRow}
      />
    );

  return (
    <>
      {current === null ? currentRow : renderGroup(current, true)}
      {expanded ? (
        <div data-thread-details-pr-list className="flex flex-col">
          {others.map((group) => renderGroup(group, false))}
        </div>
      ) : null}
      {hiddenCount > 0 ? (
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(!expanded)}
          part="row"
          tone="muted"
          className="w-full active:scale-100"
        >
          <MorphIcon aria-hidden className="size-4 shrink-0" icon={expanded ? Minus : Plus} />
          {expanded ? "Show less" : `Show ${hiddenCount} more`}
        </ThreadDetailsControl>
      ) : null}
    </>
  );
}
