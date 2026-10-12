import type { PullRequestRef } from "@t3tools/contracts";

import { PullRequestDetailPanel } from "~/components/pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "~/components/pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "~/components/pullRequest/PullRequestsUnavailableState";
import type { ShortcutMatchContext } from "~/keybindings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironment } from "~/state/environments";

import { usePanelHost } from "../panelHost";

interface PullRequestSidePanelProps {
  reference: PullRequestRef;
  context: "page" | "thread";
  /** True only while this surface is the visible, active tab. */
  shortcutsEnabled: boolean;
  getShortcutContext: () => ShortcutMatchContext;
  /** Back to the thread's linked pull requests; only offered when there is more than one. */
  onBack?: (() => void) | undefined;
}

// No onClose: the surface tab's own X owns closing here, and a second X in the header would be
// the same action twice.
export default function PullRequestSidePanel({
  reference,
  context,
  shortcutsEnabled,
  getShortcutContext,
  onBack,
}: PullRequestSidePanelProps) {
  const { threadRef, composerDraftTarget } = usePanelHost();
  const serverConfig = useEnvironment(threadRef.environmentId)?.serverConfig ?? null;
  if (serverConfig === null) return <PullRequestDetailGhost />;
  if (serverConfig.environment.capabilities.pullRequests !== true) {
    return (
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's T3 Code server to browse pull requests."
      />
    );
  }
  return (
    <PullRequestDetailPanel
      getShortcutContext={getShortcutContext}
      shortcutsEnabled={shortcutsEnabled}
      environmentId={threadRef.environmentId}
      onSelectPullRequest={(selected) => {
        useRightPanelStore.getState().openPullRequest(threadRef, {
          projectId: selected.projectId,
          repository: selected.repository,
          number: selected.number,
          ...(selected.host ? { host: selected.host } : {}),
        });
      }}
      threadRef={threadRef}
      reference={reference}
      context={context}
      composerDraftTarget={composerDraftTarget}
      onBack={onBack}
    />
  );
}
