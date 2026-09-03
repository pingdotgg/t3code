/**
 * Putting a label on, and taking one off, from the row that says which it already wears.
 *
 * The repository's labels are read only once this menu opens, for the reason the reviewer menu
 * reads its people then: they are worth a request when somebody wants them and worth nothing on
 * every pull request they merely open.
 */
import type { EnvironmentId, PullRequestLabelCandidate, PullRequestRef } from "@t3tools/contracts";
import { CheckIcon, TagIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { PullRequestPeopleGhost } from "./PullRequestGhosts";
import { readableFailure } from "./pullRequestDetail.logic";
import { pullRequestLabelColor } from "./pullRequestList.logic";

/** Narrows only what arrived: the host is asked once, when the menu opens. */
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
  onChanged,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** False where the host would refuse this account's change. Disabled with the reason rather
   * than hidden, like the reviewer control beside it. */
  allowed: boolean;
  /** The detail carries the labels, so it is re-read once the host has taken the change. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Mounted with the menu closed, so nothing is asked of the host until it opens.
  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.labelCandidates({ environmentId, input: reference }) : null,
  );
  const setLabels = useAtomCommand(pullRequestEnvironment.setLabels, { reportFailure: false });

  const candidates = useMemo(
    () => (candidatesQuery.data?.candidates ?? []).filter((entry) => matches(entry, query)),
    [candidatesQuery.data, query],
  );

  const toggle = async (candidate: PullRequestLabelCandidate) => {
    if (pending !== null) return;
    setPending(candidate.name);
    const result = await setLabels({
      environmentId,
      input: { ...reference, labels: [candidate.name], applied: !candidate.isApplied },
    });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: candidate.isApplied
          ? `Could not take ${candidate.name} off`
          : `Could not put ${candidate.name} on`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have triage access on this repository.",
        ),
      });
      return;
    }
    onChanged();
    candidatesQuery.refresh();
  };

  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost" disabled aria-label="Change labels">
              <TagIcon className="size-3.5" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          Changing labels needs triage access on this repository
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label="Change labels">
            <TagIcon className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup align="start" side="bottom" className="w-72 p-0">
        <div className="border-b border-border/60 p-2">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search labels"
            aria-label="Search labels"
            size="compact"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {candidatesQuery.isPending ? (
            <PullRequestPeopleGhost rows={4} />
          ) : candidatesQuery.error !== null ? (
            <p className="p-2 text-xs text-muted-foreground">
              The labels could not be read. {candidatesQuery.error}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.length > 0 ? "No label matches that." : "This repository has no labels."}
            </p>
          ) : (
            candidates.map((candidate) => {
              const dot = pullRequestLabelColor(candidate.color);
              return (
                <button
                  key={candidate.name}
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void toggle(candidate)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60 disabled:opacity-60"
                >
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
                  {candidate.isApplied ? (
                    <CheckIcon aria-label="Applied" className="size-3.5 shrink-0" />
                  ) : null}
                </button>
              );
            })
          )}
          {candidatesQuery.data?.truncated ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              This repository has more labels than are listed here. Apply the rest on the host.
            </p>
          ) : null}
        </div>
      </MenuPopup>
    </Menu>
  );
}
