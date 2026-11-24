import {
  workflowReferenceIssue,
  workflowReferenceLabel,
  workflowReferencePullRequest,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunReference } from "@t3tools/contracts";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/** The mark a reference wears: its kind's icon, in the ink its state has on its own page. */
function referenceGlyph(reference: WorkflowRunReference) {
  if (workflowReferencePullRequest(reference) !== null) {
    const state =
      reference.state === "closed" || reference.state === "merged" ? reference.state : "open";
    return PULL_REQUEST_STATE_PRESENTATION[state];
  }
  if (workflowReferenceIssue(reference) !== null) {
    return reference.state === "closed"
      ? {
          Icon: CircleCheckIcon,
          toneClassName: PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
        }
      : { Icon: CircleDotIcon, toneClassName: PULL_REQUEST_STATE_PRESENTATION.open.toneClassName };
  }
  return { Icon: LinkIcon, toneClassName: "text-muted-foreground" };
}

export function WorkflowReferenceMark({ reference }: { readonly reference: WorkflowRunReference }) {
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
  readonly reference: WorkflowRunReference;
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
    <Button
      variant={open ? "secondary" : "pill"}
      size={small ? "chip" : "xs-pill"}
      aria-pressed={open}
      aria-label={name}
      className="min-w-0 max-w-72"
      onClick={onOpen}
    >
      <WorkflowReferenceMark reference={reference} />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {small || title === "" ? null : <span className="min-w-0 truncate">{title}</span>}
    </Button>
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
    <div className="space-y-3 p-4">
      <div className="space-y-1.5">
        <h3 className="text-title break-words">
          {reference.title === "" ? workflowReferenceLabel(reference) : reference.title}
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <WorkflowReferenceMark reference={reference} />
            <span>{reference.kind}</span>
          </span>
          {reference.state === null ? null : (
            <Badge variant="secondary" size="sm">
              {reference.state}
            </Badge>
          )}
        </div>
      </div>
      {reference.url === null ? null : (
        <Button
          size="sm"
          variant="secondary"
          render={<a href={reference.url} target="_blank" rel="noreferrer" />}
        >
          <T>Open</T>
          <ExternalLinkIcon aria-hidden />
        </Button>
      )}
    </div>
  );
}
