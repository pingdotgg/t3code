import {
  workflowReferenceIssue,
  workflowReferenceLabel,
  workflowReferencePullRequest,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunReference, WorkflowRunSubject } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T } from "gt-react";
import { CircleCheckIcon, CircleDotIcon, ExternalLinkIcon, LinkIcon } from "lucide-react";

import { isElectron } from "~/env";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { ISSUES_PANEL_REF, useRightPanelStore } from "../../rightPanelStore";
import { IssueDetailPanel } from "../issue/IssueDetailPanel";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { PULL_REQUEST_STATE_PRESENTATION } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";

/** A reference, or a run's subject, which says nothing of where it stands. */
type Shown = WorkflowRunSubject & Partial<Pick<WorkflowRunReference, "state">>;

/**
 * The mark a reference wears: its kind's icon, in the ink its state has on its own page. A
 * subject says nothing of its state, so its mark wears none.
 */
function referenceGlyph(reference: Shown) {
  const unknown = reference.state === undefined ? { toneClassName: "text-muted-foreground" } : {};
  if (workflowReferencePullRequest(reference) !== null) {
    const state =
      reference.state === "closed" || reference.state === "merged" ? reference.state : "open";
    return { ...PULL_REQUEST_STATE_PRESENTATION[state], ...unknown };
  }
  if (workflowReferenceIssue(reference) !== null) {
    return reference.state === "closed"
      ? {
          Icon: CircleCheckIcon,
          toneClassName: PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
        }
      : {
          Icon: CircleDotIcon,
          toneClassName: PULL_REQUEST_STATE_PRESENTATION.open.toneClassName,
          ...unknown,
        };
  }
  return { Icon: LinkIcon, toneClassName: "text-muted-foreground" };
}

export function WorkflowReferenceMark({ reference }: { readonly reference: Shown }) {
  const glyph = referenceGlyph(reference);
  return <glyph.Icon aria-hidden className={cn("size-3 shrink-0", glyph.toneClassName)} />;
}

/** A thing the run touched, as a chip that opens it beside the run. */
export function WorkflowReferenceChip({
  reference,
  open,
  small = false,
  onOpen,
}: {
  readonly reference: Shown;
  /** It shows in the pane now, so another click closes it. */
  readonly open: boolean;
  /** On a step, where the label is enough. */
  readonly small?: boolean;
  readonly onOpen: () => void;
}) {
  const label = workflowReferenceLabel(reference);
  const title = reference.title === label ? "" : reference.title;
  const name = title === "" ? label : `${label} ${title}`;
  return (
    <button
      type="button"
      aria-pressed={open}
      aria-label={name}
      className={cn(
        "inline-flex min-w-0 max-w-72 cursor-pointer items-center gap-1.5 rounded-full border bg-card text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
        small ? "py-px ps-1.5 pe-2 text-2xs" : "py-0.5 ps-2 pe-2.5 text-xs",
        open ? "border-primary ring-1 ring-primary" : "border-border",
      )}
      onClick={onOpen}
    >
      <WorkflowReferenceMark reference={reference} />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {small || title === "" ? null : <span className="min-w-0 truncate">{title}</span>}
    </button>
  );
}

const shortcutContext = () => ({
  terminalFocus: isTerminalFocused(),
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: !isElectron,
  isDesktop: isElectron,
});

/** Opens the reference on its own page, where it has the whole window. Null for a kind with none. */
export function useOpenReferencePage(
  environmentId: EnvironmentId,
): (reference: WorkflowRunReference) => (() => void) | null {
  const navigate = useNavigate();
  return (reference) => {
    const issue = workflowReferenceIssue(reference);
    if (issue !== null) {
      return () => {
        // The Issues page shows the issue its panel has open; the address keeps the list's place.
        useRightPanelStore.getState().openIssue(ISSUES_PANEL_REF, {
          environmentId,
          projectId: issue.projectId,
          tracker: issue.tracker,
          ...(issue.host === undefined ? {} : { host: issue.host }),
          scope: issue.scope,
          key: issue.key,
          ...(reference.url === null ? {} : { url: reference.url }),
        });
        void navigate({
          to: "/issues",
          search: {
            ...readIssueListPreferences(),
            selectedEnvironmentId: environmentId,
            selectedProjectId: issue.projectId,
            ...(issue.host === undefined ? {} : { selectedHost: issue.host }),
            tracker: issue.tracker,
            scope: issue.scope,
            key: issue.key,
          },
        });
      };
    }
    const pullRequest = workflowReferencePullRequest(reference);
    if (pullRequest !== null) {
      return () =>
        void navigate({
          to: "/pull-requests",
          search: {
            involvement: "all",
            state: "all",
            repository: pullRequest.repository,
            number: pullRequest.number,
            ...(pullRequest.host === undefined ? {} : { selectedHost: pullRequest.host }),
            selectedProjectId: pullRequest.projectId,
            selectedEnvironmentId: environmentId,
          },
        });
    }
    return null;
  };
}

/** A reference opened beside its run: the Issues or Pull requests page's own view of it. */
export function WorkflowReferencePanel({
  environmentId,
  reference,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: WorkflowRunReference;
}) {
  const issue = workflowReferenceIssue(reference);
  if (issue !== null) {
    return <IssueDetailPanel environmentId={environmentId} reference={issue} />;
  }
  const pullRequest = workflowReferencePullRequest(reference);
  if (pullRequest !== null) {
    return (
      <PullRequestDetailPanel
        environmentId={environmentId}
        reference={pullRequest}
        shortcutsEnabled={false}
        getShortcutContext={shortcutContext}
      />
    );
  }
  // A kind this client does not know yet: what the run knows of it, and where it lives.
  return (
    <div className="space-y-2 p-4">
      <h3 className="text-base font-semibold break-words">
        {reference.title === "" ? workflowReferenceLabel(reference) : reference.title}
      </h3>
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <WorkflowReferenceMark reference={reference} />
        <span>{reference.kind}</span>
        {reference.state === null ? null : (
          <>
            <span aria-hidden>·</span>
            <span>{reference.state}</span>
          </>
        )}
      </p>
      {reference.url === null ? null : (
        <Button
          size="sm"
          variant="outline"
          render={<a href={reference.url} target="_blank" rel="noreferrer" />}
        >
          <T>Open</T>
          <ExternalLinkIcon aria-hidden />
        </Button>
      )}
    </div>
  );
}
