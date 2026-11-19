import type { PullRequestListEntry, PullRequestSummary } from "@t3tools/contracts";
import { EllipsisIcon, PanelRightIcon, TagIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import type { ReactNode } from "react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import {
  PULL_REQUEST_DETAIL_HEADER_CLASS,
  PullRequestChecksStatusLine,
  PullRequestDetailHeaderBody,
  PullRequestDetailTabBar,
  PullRequestDetailTitleRow,
  PullRequestMetaRow,
  PullRequestTimestamp,
} from "./PullRequestDetailLayout";
import { PullRequestBackButton, PullRequestNumberLink } from "./PullRequestDetailCrumbs";
import { openOnHostLabel } from "./pullRequestLinkContextMenu";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestLabelChip,
  pullRequestChecksStatePresentation,
  resolvePullRequestState,
} from "./pullRequestPresentation";
import { resolveFilterOptions } from "./pullRequestListOptions";

import { changeRequestTermKind } from "./changeRequestTerm";

export function GhostBar({ className }: { className?: string | undefined }) {
  return <span aria-hidden className={cn("block h-3 rounded bg-muted-foreground/15", className)} />;
}

const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2"];
const META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5", "w-1/4", "w-1/3", "w-2/5", "w-1/3"];
const DEFAULT_DETAIL_TABS = [
  { value: "summary", label: msg("Description", { $context: "pull request tab" }) },
  { value: "checks", label: msg("Checks", { $context: "pull request tab" }) },
  { value: "timeline", label: msg("Timeline", { $context: "pull request tab" }) },
  { value: "code", label: msg("Code", { $context: "pull request tab" }) },
] as const;

export function PullRequestListGhost({ rows = 7, caption }: { rows?: number; caption?: string }) {
  const gt = useGT();
  return (
    <div role="status" aria-label={caption ?? gt("Loading pull requests")} className="space-y-0.5">
      {/* Outside the pulse so the explanation stays readable. */}
      {caption ? (
        <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{caption}</p>
      ) : null}
      <div className="motion-safe:animate-skeleton space-y-0.5">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 py-2.5"
          >
            <GhostBar className="size-4 rounded-full" />
            <div className="min-w-0 space-y-1.5">
              <GhostBar className={cn("h-4", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
              <GhostBar className={cn("h-3.5", META_WIDTHS[index % META_WIDTHS.length])} />
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <GhostBar className="w-12" />
              <GhostBar className="w-16" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PullRequestDetailGhost({
  seed: entry,
  summary,
  actions,
  tabs: requestedTabs,
  activeTab,
  number,
  onBack,
  onClose,
}: {
  seed?: PullRequestListEntry | null;
  summary?: PullRequestSummary | null;
  actions?: ReactNode;
  tabs?: ReadonlyArray<{ value: string; label: string }>;
  activeTab?: string;
  number?: number;
  onBack?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const tabs = requestedTabs ?? resolveFilterOptions(DEFAULT_DETAIL_TABS, resolve);
  const seed = summary
    ? {
        ...entry,
        ...summary,
        isDraft: summary.isDraft ?? entry?.isDraft,
      }
    : entry;
  const terminology = sourceControlClients.get(seed?.provider).changeRequest;
  const statePresentation = seed
    ? resolvePullRequestState(
        {
          state: seed.state,
          isDraft: seed.isDraft ?? false,
        },
        resolve,
      )
    : null;
  // Passing list rollups can omit workflows awaiting approval; wait for detail.
  const checksPresentation =
    seed?.checksState === "failing" || seed?.checksState === "pending"
      ? pullRequestChecksStatePresentation(seed.checksState, resolve)
      : null;
  const changedFiles = summary?.changedFiles ?? null;
  const selectedTab =
    tabs.find((item) => item.value === activeTab)?.value ?? tabs[0]?.value ?? "summary";

  return (
    <div
      role="status"
      aria-label={gt(
        "Loading {term, select, mr {merge request} cr {change request} other {pull request}}",
        { term: changeRequestTermKind(terminology) },
      )}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden bg-background",
        !seed && "motion-safe:animate-skeleton",
      )}
    >
      <div className={cn(PULL_REQUEST_DETAIL_HEADER_CLASS, "border-b border-(--shell-divider)")}>
        <PullRequestDetailTitleRow className="gap-1 pl-4.5">
          {onBack ? <PullRequestBackButton onBack={onBack} /> : null}
          {seed ? (
            <h1 className="min-w-0 truncate text-lg leading-6 font-medium">{seed.title}</h1>
          ) : (
            <GhostBar className="h-5 w-4/5 max-w-md" />
          )}
        </PullRequestDetailTitleRow>
        <div className="mr-4.5 flex h-7 shrink-0 items-center justify-end gap-1 [--control-radius:9999px]">
          {actions ?? <GhostBar className="h-6 w-16 rounded-full" />}
          <Button
            size="icon-xs"
            variant="ghost"
            disabled
            aria-label={gt(
              "{term, select, mr {Merge request} cr {Change request} other {Pull request}} actions loading",
              {
                term: changeRequestTermKind(terminology),
              },
            )}
          >
            <EllipsisIcon aria-hidden className="size-4" />
          </Button>
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt(
                "Collapse {term, select, mr {merge request} cr {change request} other {pull request}} panel",
                { term: changeRequestTermKind(terminology) },
              )}
              onClick={onClose}
            >
              <PanelRightIcon aria-hidden className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <PullRequestDetailHeaderBody
          repository={seed ? seed.repository : <GhostBar className="w-24" />}
          link={
            seed ? (
              <PullRequestNumberLink
                detail={seed}
                toneClassName={statePresentation?.toneClassName ?? null}
                openOnHostText={openOnHostLabel(sourceControlClients.get(seed.provider), resolve)}
              />
            ) : (
              <span className="text-muted-foreground tabular-nums">#{number ?? "…"}</span>
            )
          }
          author={
            seed ? (
              <PullRequestActorLabel actor={seed.author ?? null} tooltip={false} />
            ) : (
              <span className="flex items-center gap-1.5">
                <GhostBar className="size-4 rounded-full" />
                <GhostBar className="h-3 w-14" />
              </span>
            )
          }
          updated={
            seed ? (
              <PullRequestTimestamp timestamp={seed.updatedAt} />
            ) : (
              <GhostBar className="h-3 w-16" />
            )
          }
          base={
            seed ? (
              <span className="min-w-0 truncate">{seed.baseBranch}</span>
            ) : (
              <GhostBar className="h-3 w-12" />
            )
          }
          head={
            seed ? (
              <span className="ms-1 min-w-0 truncate">{seed.headBranch}</span>
            ) : (
              <GhostBar className="h-3 w-32" />
            )
          }
          files={
            changedFiles === null ? (
              <GhostBar className="h-3 w-10" />
            ) : (
              gt("{count, plural, one {{formatted} file} other {{formatted} files}}", {
                count: changedFiles,
                formatted: changedFiles.toLocaleString(),
              })
            )
          }
          diffStat={
            seed ? (
              <PullRequestDiffStat
                additions={seed.additions ?? 0}
                deletions={seed.deletions ?? 0}
                className="shrink-0 font-mono text-sm"
              />
            ) : (
              <GhostBar className="h-3 w-20" />
            )
          }
        >
          <PullRequestMetaRow
            icon={<UsersIcon aria-hidden className="size-3.5" />}
            label={gt("Reviewers")}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <GhostBar className="h-3 w-10" />
              <Button size="icon-xs" variant="ghost" disabled aria-label={gt("Reviewers loading")}>
                <UserPlusIcon aria-hidden className="size-3.5" />
              </Button>
            </span>
          </PullRequestMetaRow>
          <PullRequestMetaRow
            icon={<TagIcon aria-hidden className="size-3.5" />}
            label={gt("Labels")}
          >
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {entry?.labels ? (
                entry.labels.length > 0 ? (
                  entry.labels.map((label) => (
                    <PullRequestLabelChip
                      key={label.name}
                      label={label}
                      size="pill"
                      className="max-w-48"
                    />
                  ))
                ) : (
                  <span className="text-muted-foreground">
                    <T context="no labels">None</T>
                  </span>
                )
              ) : (
                <>
                  <GhostBar className="h-4.5 w-24" />
                  <GhostBar className="h-4.5 w-20" />
                </>
              )}
              <Button size="icon-xs" variant="ghost" disabled aria-label={gt("Labels loading")}>
                <TagIcon aria-hidden className="size-3.5" />
              </Button>
            </span>
          </PullRequestMetaRow>
        </PullRequestDetailHeaderBody>

        <PullRequestDetailTabBar tabs={tabs} value={selectedTab} inert>
          {selectedTab !== "checks" ? null : checksPresentation ? (
            <PullRequestChecksStatusLine
              className={checksPresentation.toneClassName}
              icon={<checksPresentation.Icon aria-hidden className="size-3.5" />}
              label={checksPresentation.label}
            />
          ) : (
            <PullRequestChecksStatusLine
              icon={<GhostBar className="my-px size-3.5 rounded-full" />}
              label={<GhostBar className="w-28" />}
            />
          )}
        </PullRequestDetailTabBar>

        <div className="space-y-3 px-4.5 py-4">
          <GhostBar className="h-5 w-40" />
          <div className="space-y-2">
            <GhostBar className="h-4 w-full" />
            <GhostBar className="h-4 w-11/12" />
            <GhostBar className="h-4 w-4/5" />
            <GhostBar className="h-4 w-2/3" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function PullRequestPeopleGhost({ rows = 4 }: { rows?: number }) {
  const gt = useGT();
  return (
    <div
      role="status"
      aria-label={gt("Loading people")}
      className="motion-safe:animate-skeleton space-y-1 p-1"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-7 items-center gap-2 rounded-md px-2">
          <GhostBar className="size-4 rounded-full" />
          <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
        </div>
      ))}
    </div>
  );
}

export function PullRequestTimelineGhost({ rows = 6 }: { rows?: number }) {
  const gt = useGT();
  return (
    <div
      role="status"
      aria-label={gt("Loading timeline")}
      className="motion-safe:animate-skeleton px-4 py-5"
    >
      <div className="relative ml-2 border-l border-border/70 pl-5">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="relative pb-5">
            <GhostBar className="absolute -left-[1.55rem] top-1 size-2 rounded-full" />
            <GhostBar className={cn("h-3.5", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
            <GhostBar className="mt-1.5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
