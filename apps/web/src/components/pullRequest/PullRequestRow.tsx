import { memo } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { ListRow } from "../sourceControl/ListRow";
import { Checkbox } from "../ui/checkbox";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestStateGlyph,
} from "./pullRequestPresentation";

function PullRequestRowImpl({
  entry,
  selected,
  selectionChecked,
  showProjectTitle,
  showProvider,
  environmentLabel,
  matchedElsewhere,
  onSelect,
  onToggleSelection,
}: {
  entry: EnvironmentPullRequestEntry;
  selected: boolean;
  selectionChecked?: boolean;
  showProjectTitle: boolean;
  /** Only when the list spans more than one host, where the repository alone is ambiguous. */
  showProvider: boolean;
  /** Names the server this row was read from, where the list spans more than one. */
  environmentLabel?: string;
  /**
   * A search found this, but in something the row does not show — a description, a comment, a
   * commit message. Saying so is the difference between a result and an apparently random row.
   */
  matchedElsewhere?: boolean;
  onSelect: (entry: EnvironmentPullRequestEntry) => void;
  onToggleSelection?: (entry: EnvironmentPullRequestEntry) => void;
}) {
  const { Icon, providerName } = getSourceControlPresentationForKind(entry.provider);
  return (
    <div className={cn("group/row relative", onToggleSelection && "[&>button]:pl-10")}>
      <ListRow
        glyph={
          <PullRequestStateGlyph
            state={entry.state}
            isDraft={entry.isDraft}
            mergeability={entry.mergeability}
            baseBranch={entry.baseBranch}
          />
        }
        title={entry.title}
        providerName={providerName}
        ProviderIcon={Icon}
        showProvider={showProvider}
        number={entry.number}
        onNumberContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void showPullRequestLinkContextMenu({
            url: entry.url,
            openLabel: openOnHostLabel(entry.provider),
            position: { x: event.clientX, y: event.clientY },
          });
        }}
        repository={showProjectTitle ? entry.repository : null}
        meta={[
          environmentLabel ? (
            <span key="environment" className="max-w-32 shrink-0 truncate">
              {environmentLabel}
            </span>
          ) : null,
          <PullRequestActorLabel key="author" actor={entry.author} className="max-w-40 shrink-0" />,
          entry.reviewDecision === "approved" || entry.reviewDecision === "changes-requested" ? (
            <span
              key="review"
              className={cn(
                "shrink-0",
                entry.reviewDecision === "approved"
                  ? "text-emerald-600/90 dark:text-emerald-400/80"
                  : "text-amber-600/90 dark:text-amber-400/80",
              )}
            >
              {entry.reviewDecision === "approved" ? "Approved" : "Changes requested"}
            </span>
          ) : null,
          entry.checksState === undefined ? null : (
            <PullRequestChecksPopover
              key="checks"
              checksState={entry.checksState}
              environmentId={entry.environmentId}
              reference={{
                projectId: entry.projectId,
                repository: entry.repository,
                number: entry.number,
              }}
            />
          ),
        ]}
        matchedElsewhere={matchedElsewhere === true}
        updatedAt={entry.updatedAt}
        trailing={<PullRequestDiffStat additions={entry.additions} deletions={entry.deletions} />}
        selected={selected}
        onSelect={() => onSelect(entry)}
      />
      {onToggleSelection ? (
        <Checkbox
          checked={selectionChecked}
          aria-label={
            (selectionChecked ? "Deselect " : "Select ") +
            entry.repository +
            " pull request #" +
            entry.number
          }
          className={cn(
            "absolute top-1/2 left-3 z-10 -translate-y-1/2 transition-opacity",
            selectionChecked
              ? "opacity-100"
              : "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
          )}
          onCheckedChange={() => onToggleSelection(entry)}
        />
      ) : null}
    </div>
  );
}

/**
 * Memoized: the list re-renders on every keystroke of a search and every status poll, and a
 * row whose entry, selection and match state are unchanged has nothing new to say. Effective
 * because the route hands it a stable `onSelect`.
 */
export const PullRequestRow = memo(PullRequestRowImpl);
