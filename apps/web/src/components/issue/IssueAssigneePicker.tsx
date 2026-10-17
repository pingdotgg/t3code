import type { EnvironmentId, IssueActor, IssueScopeRef } from "@t3tools/contracts";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";

import { useIssueAssigneeCandidates } from "~/state/issues";

import {
  issueAssigneeId,
  issueAssigneeOptions,
  isIssueAssignee,
  nextIssueAssignees,
} from "./issueDetail.logic";
import { PullRequestCandidatePicker } from "../pullRequest/PullRequestCandidatePicker";
import { PullRequestActorLabel } from "../pullRequest/pullRequestPresentation";

const LOAD_MORE = { loadMore: true } as const;

export function IssueAssigneePicker({
  environmentId,
  source,
  selected,
  onChange,
  allowed,
  max,
  disabled = false,
  disabledReason = "Assigning people needs more access on this tracker",
}: {
  environmentId: EnvironmentId;
  source: IssueScopeRef;
  selected: ReadonlyArray<IssueActor>;
  onChange: (next: ReadonlyArray<IssueActor>) => void;
  allowed: boolean;
  max: number;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const candidates = useIssueAssigneeCandidates(environmentId, open && max > 0 ? source : null);

  const rows = (() => {
    const matches = issueAssigneeOptions(
      selected,
      candidates.items.map((actor) => ({ ...actor, id: issueAssigneeId(actor) })),
      query,
    );
    return candidates.hasMore ? [...matches, LOAD_MORE] : matches;
  })();

  if (max === 0) return null;

  const loaded = candidates.items.length > 0;
  const full = max > 1 && selected.length >= max;
  const note = [
    full ? `Up to ${max} assignees.` : "",
    candidates.truncated ? "This tracker has more people than can be listed here." : "",
    loaded && candidates.error !== null ? `More people could not be read. ${candidates.error}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <PullRequestCandidatePicker
      icon={<UserPlusIcon className="size-3.5" />}
      label="Change assignees"
      allowed={allowed}
      disabledReason={disabledReason}
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search people"
      isPending={candidates.isPending && !loaded}
      error={loaded ? null : candidates.error}
      candidates={rows}
      emptyLabel="Nobody can be assigned here."
      noMatchLabel="Nobody matches that."
      errorLabel="The people could not be read."
      truncated={note.length > 0}
      truncatedLabel={note}
      candidateKey={(row) => ("loadMore" in row ? "more" : `actor:${issueAssigneeId(row)}`)}
      disabled={disabled}
      onSelect={(row) => {
        if ("loadMore" in row) return candidates.loadMore();
        if (full && !isIssueAssignee(selected, issueAssigneeId(row))) return;
        const ids = nextIssueAssignees(selected, { ...row, id: issueAssigneeId(row) }, max);
        onChange([...selected, row].filter((actor) => ids.includes(issueAssigneeId(actor))));
      }}
    >
      {(row) =>
        "loadMore" in row ? (
          <span className="text-muted-foreground">
            {candidates.isPending ? "Loading…" : "Load more"}
          </span>
        ) : (
          <>
            <PullRequestActorLabel actor={row} tooltip={false} className="flex-1" />
            {isIssueAssignee(selected, issueAssigneeId(row)) ? (
              <CheckIcon aria-label="Selected" className="size-3.5 shrink-0" />
            ) : null}
          </>
        )
      }
    </PullRequestCandidatePicker>
  );
}
