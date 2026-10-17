import type { EnvironmentId, IssueLabel, IssueScopeRef } from "@t3tools/contracts";
import { TagIcon } from "lucide-react";
import { useState } from "react";

import { useIssueLabelCandidates } from "~/state/issues";

import { PullRequestCandidatePicker } from "../pullRequest/PullRequestCandidatePicker";
import { issueLabelId, issueLabelOptions } from "./issueDetail.logic";
import { PullRequestLabelOption } from "../pullRequest/pullRequestPresentation";

const LOAD_MORE = { loadMore: true } as const;

export function IssueLabelPicker({
  environmentId,
  source,
  selected,
  onChange,
  allowed,
  disabled = false,
  disabledReason = "Setting labels needs more access on this tracker",
}: {
  environmentId: EnvironmentId;
  source: IssueScopeRef;
  selected: ReadonlyArray<IssueLabel>;
  onChange: (next: ReadonlyArray<IssueLabel>) => void;
  allowed: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const candidates = useIssueLabelCandidates(environmentId, open ? source : null);

  const rows = (() => {
    const matches = issueLabelOptions(
      selected,
      candidates.items.map((label) => ({ ...label, description: label.description ?? null })),
      query,
    );
    return candidates.hasMore ? [...matches, LOAD_MORE] : matches;
  })();

  const loaded = candidates.items.length > 0;
  const note = [
    candidates.truncated ? "This tracker has more labels than can be listed here." : "",
    loaded && candidates.error !== null ? `More labels could not be read. ${candidates.error}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <PullRequestCandidatePicker
      icon={<TagIcon className="size-3.5" />}
      label="Change labels"
      allowed={allowed}
      disabledReason={disabledReason}
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search labels"
      isPending={candidates.isPending && !loaded}
      error={loaded ? null : candidates.error}
      candidates={rows}
      emptyLabel="This tracker has no labels."
      noMatchLabel="No label matches that."
      errorLabel="The labels could not be read."
      truncated={note.length > 0}
      truncatedLabel={note}
      candidateKey={(row) => ("loadMore" in row ? "more" : `label:${issueLabelId(row)}`)}
      disabled={disabled}
      onSelect={(row) => {
        if ("loadMore" in row) return candidates.loadMore();
        onChange(
          selected.some((label) => issueLabelId(label) === issueLabelId(row))
            ? selected.filter((label) => issueLabelId(label) !== issueLabelId(row))
            : [...selected, row],
        );
      }}
    >
      {(row) => {
        if ("loadMore" in row) {
          return (
            <span className="text-muted-foreground">
              {candidates.isPending ? "Loading…" : "Load more"}
            </span>
          );
        }
        return (
          <PullRequestLabelOption
            label={row}
            checked={selected.some((label) => issueLabelId(label) === issueLabelId(row))}
            checkLabel="Selected"
          />
        );
      }}
    </PullRequestCandidatePicker>
  );
}
