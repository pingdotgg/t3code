/**
 * Putting labels on an issue, from the row that says which it wears.
 *
 * What a repository has is read only once this menu opens: a long-lived repository has dozens of
 * labels, which is worth a request when somebody wants to change one and worth nothing on every
 * issue they merely open.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueLabelCandidate, IssueRef } from "@t3tools/contracts";
import { TagIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { EntityPicker, EntityPickerOption } from "../sourceControl/EntityPicker";
import { readableFailure } from "../sourceControl/handoff";
import { toastManager } from "../ui/toast";

/** A repository with dozens of labels is common, so what arrived can be narrowed here. It
 * narrows only what arrived: the host is asked once, when the menu opens. */
function matches(candidate: IssueLabelCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.name.toLowerCase().includes(needle) ||
    (candidate.description ?? "").toLowerCase().includes(needle)
  );
}

export function IssueLabelPicker({
  environmentId,
  reference,
  applied,
  allowed,
  open,
  onOpenChange,
  onChanged,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /**
   * The labels the issue wears, by name, as the issue itself reports them. Every host writes
   * labels by replacing the whole set, so the set sent back is built from these rather than from
   * the candidate list — which the host may have cut short, and which would then quietly take
   * off every label past its end.
   */
  applied: ReadonlyArray<string>;
  /** False where the host would refuse this account, which is worth saying rather than hiding:
   * the control disabled with a reason answers the question its absence would raise. */
  allowed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The detail carries the labels, so it is re-read once the host has taken the change. */
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  /**
   * What the last successful write left on the host, against the prop it was built from.
   *
   * A write resolves before `onChanged()` can bring the detail back, so for that window the prop
   * still says what the issue wore beforehand; a second toggle built on it would send the first
   * one straight back off. What was written stands in until the prop reads as anything else — at
   * which point the host has spoken more recently than this and takes over again, so a label put
   * on elsewhere is not quietly taken off by the next toggle either.
   */
  const [written, setWritten] = useState<{
    readonly base: string;
    readonly labels: ReadonlyArray<string>;
  } | null>(null);

  // Mounted with the menu closed, so nothing is asked of the host until it opens.
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.labelCandidates({ environmentId, input: reference }) : null,
  );
  const setLabels = useAtomCommand(issueEnvironment.setLabels, { reportFailure: false });

  const candidates = useMemo(
    () => (candidatesQuery.data?.candidates ?? []).filter((entry) => matches(entry, query)),
    [candidatesQuery.data, query],
  );
  // Order is the host's, so the set is compared by content rather than by the array it arrived in.
  const appliedKey = useMemo(() => applied.toSorted().join("\n"), [applied]);
  const current = written !== null && written.base === appliedKey ? written.labels : applied;
  const appliedNames = useMemo(() => new Set(current), [current]);

  const toggle = async (candidate: IssueLabelCandidate) => {
    if (pending !== null) return;
    const isApplied = appliedNames.has(candidate.name);
    const next = isApplied
      ? current.filter((name) => name !== candidate.name)
      : [...current, candidate.name];
    setPending(candidate.name);
    const result = await setLabels({ environmentId, input: { ...reference, labels: next } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: isApplied
          ? `Could not take the \`${candidate.name}\` label off`
          : `Could not put the \`${candidate.name}\` label on`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have write access on this repository, and that the label still exists.",
        ),
      });
      return;
    }
    setWritten({ base: appliedKey, labels: next });
    onChanged();
    candidatesQuery.refresh();
  };

  return (
    <EntityPicker
      icon={<TagIcon className="size-3.5" />}
      label="Change the labels"
      allowed={allowed}
      disallowedReason="Changing labels needs write access on this repository"
      open={open}
      onOpenChange={onOpenChange}
      searchLabel="Search labels"
      query={query}
      onQueryChange={setQuery}
      message={
        candidatesQuery.isPending
          ? "Reading this repository's labels…"
          : candidatesQuery.error !== null
            ? `The labels could not be read. ${candidatesQuery.error}`
            : candidates.length === 0
              ? query.length > 0
                ? "No label matches that."
                : "This repository has no labels to put on."
              : null
      }
      note={
        // Typing filters what arrived; it does not ask the host again, so this says what the list
        // is rather than offering a search that would find nothing further.
        candidatesQuery.data?.truncated === true
          ? "This repository has more labels than are listed here. Put the rest on from the host."
          : null
      }
    >
      {candidates.map((candidate) => (
        <EntityPickerOption
          key={candidate.name}
          checked={appliedNames.has(candidate.name)}
          checkedLabel="Already on"
          disabled={pending !== null}
          onSelect={() => void toggle(candidate)}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{candidate.name}</span>
            {candidate.description ? (
              <span className="block truncate text-[11px] text-muted-foreground">
                {candidate.description}
              </span>
            ) : null}
          </span>
        </EntityPickerOption>
      ))}
    </EntityPicker>
  );
}
