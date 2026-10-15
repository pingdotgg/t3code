import type {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import type { EnvironmentPresentation } from "../state/environments";
import { IssueDetailPanel } from "./issue/IssueDetailPanel";
import { PullRequestDetailGhost } from "./pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "./pullRequest/PullRequestsUnavailableState";

export function ChatViewIssuePanel({
  surface,
  threadRef,
  environmentById,
}: {
  surface: Extract<RightPanelSurface, { kind: "issue" }>;
  threadRef: ScopedThreadRef;
  environmentById: ReadonlyMap<EnvironmentId, Pick<EnvironmentPresentation, "serverConfig">>;
}) {
  const environmentId =
    (surface.environmentId as EnvironmentId | undefined) ?? threadRef.environmentId;
  const serverConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  if (serverConfig === null) return <PullRequestDetailGhost />;
  if (serverConfig.environment.capabilities.issues !== true) {
    return (
      <PullRequestsUnavailableState
        title="Issues unavailable"
        error="Update this environment's T3 Code server to browse issues."
      />
    );
  }
  return (
    <IssueDetailPanel
      environmentId={environmentId}
      reference={{
        projectId: surface.projectId as ProjectId,
        tracker: surface.tracker as IssueTrackerKind,
        ...(surface.host ? { host: surface.host } : {}),
        scope: surface.scope,
        key: surface.key,
      }}
      threadRef={threadRef}
      onSelectPullRequest={(target) => {
        useRightPanelStore.getState().openPullRequest(threadRef, {
          ...target,
          ...(surface.environmentId === undefined ? {} : { environmentId: surface.environmentId }),
        });
      }}
    />
  );
}
