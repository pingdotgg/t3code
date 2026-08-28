/**
 * Assigning an issue, from the row that says who has it.
 *
 * The people who may be assigned are read only once this menu opens: on a large repository that
 * is a list of everyone with access, which is worth a request when somebody wants it and worth
 * nothing on every issue they merely open.
 */
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueAssigneeCandidate, IssueRef } from "@t3tools/contracts";
import { UserPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { issueEnvironment } from "~/state/issues";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { SourceControlActorLabel } from "../sourceControl/actorPresentation";
import { EntityPicker, EntityPickerOption } from "../sourceControl/EntityPicker";
import { readableFailure } from "../sourceControl/handoff";
import { PeopleGhost } from "../sourceControl/ListGhosts";
import { toastManager } from "../ui/toast";

/** Long lists are common — an organisation repository lists everyone — so what arrived can be
 * narrowed here. It narrows only what arrived: the host is asked once, when the menu opens. */
function matches(candidate: IssueAssigneeCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.login.toLowerCase().includes(needle) ||
    (candidate.name ?? "").toLowerCase().includes(needle)
  );
}

export function IssueAssigneePicker({
  environmentId,
  reference,
  allowed,
  open,
  onOpenChange,
  onChanged,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** False where the host would refuse this account, which is worth saying rather than hiding:
   * the control disabled with a reason answers the question its absence would raise. */
  allowed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The detail carries who is assigned, so it is re-read once the host has taken the change. */
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Mounted with the menu closed, so nothing is asked of the host until it opens.
  const candidatesQuery = useEnvironmentQuery(
    open ? issueEnvironment.assigneeCandidates({ environmentId, input: reference }) : null,
  );
  const setAssignees = useAtomCommand(issueEnvironment.setAssignees, { reportFailure: false });

  const all = useMemo(() => candidatesQuery.data?.candidates ?? [], [candidatesQuery.data]);
  const candidates = useMemo(() => all.filter((entry) => matches(entry, query)), [all, query]);
  /**
   * The host has more people with access than it listed — a common thing on an organisation
   * repository, and no reason not to assign: every host puts whoever already has the issue in this
   * list whatever else it left out, so the set stays spellable. It is only the reader who is not
   * being shown everybody.
   */
  const truncated = candidatesQuery.data?.truncated === true;

  const toggle = async (candidate: IssueAssigneeCandidate) => {
    if (pending !== null) return;
    // Every host writes assignees by replacing the whole set, and addresses a person by an
    // identifier the issue itself does not carry — GitLab assigns by numeric user id. So the set
    // is rebuilt from this list rather than from the issue's own assignees, which is also why
    // whoever already has it is listed here: a host that can assign somebody can name them.
    const next = candidate.isAssigned
      ? all.flatMap((entry) => (entry.isAssigned && entry.id !== candidate.id ? [entry.id] : []))
      : [...all.flatMap((entry) => (entry.isAssigned ? [entry.id] : [])), candidate.id];
    setPending(candidate.id);
    const result = await setAssignees({ environmentId, input: { ...reference, assignees: next } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: candidate.isAssigned
          ? `Could not take this issue off ${candidate.login}`
          : `Could not assign this issue to ${candidate.login}`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have write access on this repository, and that they still have access to it.",
        ),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: candidate.isAssigned
        ? `Taken off ${candidate.login}`
        : `Assigned to ${candidate.login}`,
    });
    onChanged();
    candidatesQuery.refresh();
  };

  return (
    <EntityPicker
      icon={<UserPlusIcon className="size-3.5" />}
      label="Change who is assigned"
      allowed={allowed}
      disallowedReason="Assigning an issue needs write access on this repository"
      open={open}
      onOpenChange={onOpenChange}
      searchLabel="Search people with access"
      query={query}
      onQueryChange={setQuery}
      loading={candidatesQuery.isPending ? <PeopleGhost rows={4} /> : null}
      message={
        candidatesQuery.error !== null
          ? `The people with access could not be read. ${candidatesQuery.error}`
          : candidates.length === 0
            ? query.length > 0
              ? "Nobody with access matches that."
              : "Nobody else has access to this repository."
            : null
      }
      note={
        // Typing filters what arrived; it does not ask the host again, so this says what the list
        // is rather than offering a search that would find nothing further.
        truncated
          ? "This repository has more people with access than are listed here. Everybody already assigned is, so choosing from here keeps them — somebody else who is missing has to be assigned on the host."
          : null
      }
    >
      {candidates.map((candidate) => (
        <EntityPickerOption
          key={candidate.id}
          checked={candidate.isAssigned}
          checkedLabel="Already assigned"
          disabled={pending !== null || truncated}
          onSelect={() => void toggle(candidate)}
        >
          <SourceControlActorLabel actor={candidate} className="min-w-0 flex-1 truncate" />
        </EntityPickerOption>
      ))}
    </EntityPicker>
  );
}
