import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { type IssueSurface, useRightPanelStore } from "~/rightPanelStore";

import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { IssueDetailPanel } from "./IssueDetailPanel";

export function ThreadIssueSurface({
  environmentId,
  threadRef,
  surface,
  supported,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  surface: IssueSurface;
  supported: boolean;
}) {
  const reference = useMemo(
    () => ({
      projectId: surface.projectId as ProjectId,
      ...(surface.host === undefined ? {} : { host: surface.host }),
      repository: surface.repository,
      number: surface.number,
    }),
    [surface.host, surface.number, surface.projectId, surface.repository],
  );
  const openAsPullRequest = useCallback(
    (url: string) => {
      const panel = useRightPanelStore.getState();
      panel.openPullRequest(threadRef, { ...reference, url });
      panel.closeSurface(threadRef, surface.id);
    },
    [reference, surface.id, threadRef],
  );
  if (!supported) {
    return (
      <PullRequestsUnavailableState
        title="Issues unavailable"
        error="Update this environment's T3 Code server to read issues here."
        {...(surface.url === undefined ? {} : { gitHubUrl: surface.url })}
      />
    );
  }
  return (
    <IssueDetailPanel
      environmentId={environmentId}
      threadRef={threadRef}
      reference={reference}
      url={surface.url}
      onPullRequest={openAsPullRequest}
    />
  );
}
