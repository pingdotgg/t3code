import { useAtomCommand } from "~/state/use-atom-command";
/**
 * Putting labels on, and taking them off, from the row that says which it already wears. Presses
 * only tick the boxes; the changes are sent together when the menu closes, one request for what
 * was put on and one for what was taken off.
 */
import type { EnvironmentId, PullRequestLabelCandidate, PullRequestRef } from "@t3tools/contracts";
import { TagIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { Checkbox } from "../ui/checkbox";
import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { readableFailure } from "./pullRequestDetail.logic";
import { pullRequestLabelColor } from "./pullRequestList.logic";

function matches(candidate: PullRequestLabelCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.name.toLowerCase().includes(needle) ||
    (candidate.description ?? "").toLowerCase().includes(needle)
  );
}

export function PullRequestLabelPicker({
  environmentId,
  reference,
  allowed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  allowed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  // What the reader has ticked this time the menu is open, by label name, against what the host
  // says is applied. A label ticked back to where it started is dropped rather than sent.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.labelCandidates({ environmentId, input: reference }) : null,
  );
  const setLabels = useAtomCommand(pullRequestEnvironment.setLabels, {
    reportFailure: false,
  });

  const all = candidatesQuery.data?.candidates ?? [];
  const candidates = all.filter((entry) => matches(entry, query));
  const isChecked = (candidate: PullRequestLabelCandidate) =>
    toggled.get(candidate.name) ?? candidate.isApplied;
  const appliedCount = all.filter(isChecked).length;

  const toggle = (candidate: PullRequestLabelCandidate) => {
    setToggled((previous) => {
      const next = new Map(previous);
      const checked = !(previous.get(candidate.name) ?? candidate.isApplied);
      if (checked === candidate.isApplied) next.delete(candidate.name);
      else next.set(candidate.name, checked);
      return next;
    });
  };

  // Each direction is its own request, so one can land while the other is refused. Whatever the
  // host refused is named in the toast; what it took is already on the pull request.
  const save = async (changes: ReadonlyMap<string, boolean>) => {
    const add = [...changes].flatMap(([name, applied]) => (applied ? [name] : []));
    const remove = [...changes].flatMap(([name, applied]) => (applied ? [] : [name]));
    if (add.length === 0 && remove.length === 0) return;
    setSaving(true);
    const failed: string[] = [];
    let failure: unknown = null;
    for (const [labels, applied] of [
      [add, true],
      [remove, false],
    ] as const) {
      if (labels.length === 0) continue;
      const result = await setLabels({ environmentId, input: { ...reference, labels, applied } });
      if (result._tag === "Failure") {
        failed.push(...labels);
        failure = squashAtomCommandFailure(result);
      }
    }
    setSaving(false);
    if (failed.length > 0) {
      toastManager.add({
        type: "error",
        title:
          failed.length === 1
            ? `Could not change ${failed[0]}`
            : `Could not change ${failed.length} labels`,
        description: readableFailure(
          failure,
          "The host refused it. Check that you have triage access on this repository.",
        ),
      });
    }
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      const changes = toggled;
      setToggled(new Map());
      setQuery("");
      void save(changes);
    }
  };

  return (
    <PullRequestCandidatePicker
      icon={<TagIcon className="size-3.5" />}
      label="Change labels"
      allowed={allowed}
      disabledReason="Changing labels needs triage access on this repository"
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search labels"
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel="This repository has no labels."
      noMatchLabel="No label matches that."
      errorLabel="The labels could not be read."
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel="This repository has more labels than are listed here. Apply the rest on the host."
      candidateKey={(candidate) => candidate.name}
      disabled={saving}
      onSelect={toggle}
      footer={
        candidatesQuery.data
          ? `${appliedCount.toLocaleString()} applied · changes save when you close`
          : null
      }
    >
      {(candidate) => {
        const dot = pullRequestLabelColor(candidate.color);
        return (
          <>
            {/* The row is the control; the box only shows its state. */}
            <span aria-hidden className="pointer-events-none flex shrink-0">
              <Checkbox checked={isChecked(candidate)} tabIndex={-1} />
            </span>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(dot ? { style: { backgroundColor: dot } } : {})}
            />
            <span className="min-w-0 flex-1 truncate">
              {candidate.name}
              {candidate.description ? (
                <span className="text-muted-foreground"> · {candidate.description}</span>
              ) : null}
            </span>
            <span className="sr-only">{isChecked(candidate) ? "Applied" : "Not applied"}</span>
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}
