import type { PullRequestAction } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { T } from "gt-react";
import { SearchIcon } from "lucide-react";
import { PullRequestChangeBreakdownStat } from "./PullRequestChangeBreakdownStat";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import {
  PullRequestSpeedActions,
  type PullRequestSpeedActionResult,
} from "./PullRequestSpeedActions";
import { Fragment, memo, type ReactNode, type RefCallback } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import { pullRequestPanelReference } from "./usePullRequestDetail";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import { PullRequestRowGlyph } from "./PullRequestListRow";
import {
  PullRequestActorAvatar,
  PullRequestLabelChip,
  PullRequestReviewDecisionGlyph,
} from "./pullRequestPresentation";

// How many label chips fit grows with the meta line: one, two, then three. The rest fold into a
// "+N" chip of the same shape, one per width, so the count always matches the chips shown.
const LABEL_SLOTS = [
  { chip: "inline-flex", overflow: "inline-flex @xl/pr-row-meta:hidden" },
  {
    chip: "hidden @xl/pr-row-meta:inline-flex",
    overflow: "hidden @xl/pr-row-meta:inline-flex @3xl/pr-row-meta:hidden",
  },
  { chip: "hidden @3xl/pr-row-meta:inline-flex", overflow: "hidden @3xl/pr-row-meta:inline-flex" },
] as const;

function PullRequestRowLabels({ labels }: { labels: EnvironmentPullRequestEntry["labels"] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {LABEL_SLOTS.map((slot, index) =>
        labels[index] ? (
          <span key={labels[index].name} className={slot.chip}>
            <PullRequestLabelChip label={labels[index]} size="pill" />
          </span>
        ) : null,
      )}
      {LABEL_SLOTS.map((slot, index) => {
        const remaining = labels.length - index - 1;
        return remaining > 0 && labels[index] ? (
          <span key={slot.overflow} className={slot.overflow}>
            <Badge variant="secondary" size="pill">
              +{remaining}
            </Badge>
          </span>
        ) : null;
      })}
    </span>
  );
}

/** The meta line's author: a 16px avatar and the login, as in the tasks board and PR panel. */
function PullRequestRowMetaAuthor({ actor }: { actor: EnvironmentPullRequestEntry["author"] }) {
  const login = actor?.login ?? "ghost";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex min-w-3.5 max-w-40 items-center gap-1.5" />}
      >
        <PullRequestActorAvatar actor={actor} />
        <span className="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate">
          {login}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {actor?.name && actor.name !== login ? `${actor.name} (@${login})` : login}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The page row's two lines, spaced like a Tasks board card: the title line at 20px, the muted
 * meta line at 22px so label chips fit without growing rows that have none.
 */
function PullRequestPageRowLines({
  number,
  title,
  status,
  signals,
  meta,
  updatedAt,
}: {
  number: ReactNode;
  title: ReactNode;
  status?: ReactNode;
  signals?: ReactNode;
  meta?: ReactNode;
  updatedAt?: string | null | undefined;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-ui">
      <span className="flex min-h-5 min-w-0 items-center gap-2 leading-5">
        {number}
        <span className="min-w-0 truncate font-medium text-foreground/90">{title}</span>
        {signals ? <span className="flex shrink-0 items-center gap-2">{signals}</span> : null}
        {status ? (
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">{status}</span>
        ) : null}
      </span>
      <span className="@container/pr-row-meta flex h-5.5 min-w-0 items-center gap-1.5 overflow-hidden leading-4 text-muted-foreground tabular-nums">
        {meta}
        {updatedAt ? (
          <span className="ml-auto shrink-0 whitespace-nowrap pl-2">
            <RelativeTime timestamp={updatedAt} />
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** Joins the meta line's parts with a quiet dot. */
function PullRequestRowMetaParts({ parts }: { parts: ReadonlyArray<ReactNode> }) {
  return (
    <>
      {parts.map((part, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- the parts are fixed slots
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden className="shrink-0 text-muted-foreground/50">
              ·
            </span>
          ) : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}

export type PullRequestRowTarget = Pick<
  EnvironmentPullRequestEntry,
  "environmentId" | "projectId" | "host" | "repository" | "number"
>;

function PullRequestRowImpl({
  entry,
  selected,
  showProjectTitle,
  showProvider,
  environmentLabel,
  matchedElsewhere,
  statsKey,
  statsRef,
  onSelect,
  onIntent,
  hostActions,
  onActed,
  closing = false,
  sweeping = false,
  onCloseSweepStart,
}: {
  entry: EnvironmentPullRequestEntry;
  selected: boolean;
  showProjectTitle: boolean;
  showProvider: boolean;
  environmentLabel?: string;
  matchedElsewhere?: boolean;
  /** Visibility key for deferred line-count reads. */
  statsKey?: string;
  statsRef?: RefCallback<HTMLDivElement>;
  onSelect: (entry: PullRequestRowTarget) => void;
  /** The row the pointer or focus rests on, or null when it leaves. */
  onIntent?: (entry: PullRequestRowTarget | null) => void;
  hostActions: ReadonlySet<PullRequestAction>;
  onActed: (result: PullRequestSpeedActionResult) => void;
  closing?: boolean;
  sweeping?: boolean;
  onCloseSweepStart?: (entry: EnvironmentPullRequestEntry, event: PointerEvent) => void;
}) {
  const { Icon, providerName, terminology } = getSourceControlPresentationForKind(entry.provider);
  return (
    <div
      ref={statsRef}
      data-pull-request-stats-key={statsKey}
      data-pull-request-key={statsKey}
      className={cn(
        "flex items-center rounded-lg [content-visibility:auto] [contain-intrinsic-block-size:68px]",
        selected
          ? "bg-sidebar-row-active light:ring-1 light:ring-inset light:ring-sidebar-border/70"
          : "hover:bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(entry)}
        onPointerEnter={() => onIntent?.(entry)}
        onPointerLeave={(event) => {
          if (event.currentTarget !== document.activeElement) onIntent?.(null);
        }}
        onFocus={() => onIntent?.(entry)}
        onBlur={(event) => {
          if (!event.currentTarget.matches(":hover")) onIntent?.(null);
        }}
        className="group/pr-row flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <PullRequestRowGlyph
          state={entry.state}
          isDraft={entry.isDraft}
          mergeability={entry.mergeability}
          baseBranch={entry.baseBranch}
          className="mt-0.5 self-start"
        />
        <PullRequestPageRowLines
          number={
            <span
              className="shrink-0 text-muted-foreground tabular-nums"
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void showPullRequestLinkContextMenu({
                  url: entry.url,
                  openLabel: openOnHostLabel(sourceControlClients.get(entry.provider)),
                  position: { x: event.clientX, y: event.clientY },
                });
              }}
            >
              #{entry.number}
            </span>
          }
          title={entry.title}
          signals={
            <>
              {entry.checksState === undefined ? null : (
                <PullRequestChecksPopover
                  checksState={entry.checksState}
                  environmentId={entry.environmentId}
                  reference={{
                    ...pullRequestPanelReference({ ...entry, host: entry.host.toLowerCase() }),
                    allowStale: false,
                  }}
                />
              )}
              {entry.reviewDecision === undefined ? null : (
                <PullRequestReviewDecisionGlyph decision={entry.reviewDecision} />
              )}
            </>
          }
          status={
            <>
              {entry.stack ? (
                <PullRequestStackPopover
                  environmentId={entry.environmentId}
                  reference={{
                    projectId: entry.projectId,
                    host: entry.host,
                    repository: entry.repository,
                    number: entry.number,
                  }}
                  membership={entry.stack}
                  onSelect={(target) =>
                    onSelect({ ...target, host: entry.host, environmentId: entry.environmentId })
                  }
                />
              ) : null}
              <PullRequestChangeBreakdownStat
                environmentId={entry.environmentId}
                reference={{
                  projectId: entry.projectId,
                  host: entry.host,
                  repository: entry.repository,
                  number: entry.number,
                }}
                additions={entry.additions}
                deletions={entry.deletions}
                className="text-ui"
              />
            </>
          }
          meta={
            <>
              {matchedElsewhere ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="flex min-w-6 items-center gap-1 overflow-hidden rounded-full border border-border/60 px-1.5 text-2xs" />
                    }
                  >
                    <span className="sr-only">
                      <T>matched in the description</T>
                    </span>
                    <SearchIcon aria-hidden className="size-3 shrink-0" />
                    <span aria-hidden className="hidden truncate @xs/pr-row-meta:block">
                      <T>matched in the description</T>
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    <T>Matched in the description</T>
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {showProvider ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                    <Icon aria-label={providerName} className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup>{providerName}</TooltipPopup>
                </Tooltip>
              ) : null}
              <PullRequestRowMetaParts
                parts={[
                  <PullRequestRowMetaAuthor key="author" actor={entry.author} />,
                  showProjectTitle ? (
                    <span key="repository" className="truncate">
                      {entry.repository}
                    </span>
                  ) : null,
                  environmentLabel ? (
                    <span key="environment" className="min-w-0 max-w-32 truncate">
                      {environmentLabel}
                    </span>
                  ) : null,
                ].filter((part) => part !== null)}
              />
              {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
            </>
          }
          updatedAt={entry.updatedAt}
        />
      </button>
      {hostActions.size > 0 ? (
        <PullRequestSpeedActions
          entry={entry}
          hostActions={hostActions}
          terminology={terminology}
          onActed={onActed}
          closing={closing}
          sweeping={sweeping}
          {...(onCloseSweepStart ? { onCloseSweepStart } : {})}
        />
      ) : null}
    </div>
  );
}

export const PullRequestRow = memo(PullRequestRowImpl);
