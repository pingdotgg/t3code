import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { useState } from "react";

import { PublishRepositoryDialog } from "../GitActionsControl";
import { SourceControlPanelView } from "./SourceControlPanelView";
import { useSourceControlPanelController } from "./useSourceControlPanelController";
import type { SourceControlPeerSyncTarget } from "./SourceControlPanel.logic";

export interface SourceControlEnvironmentPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly peerSyncTargets: readonly SourceControlPeerSyncTarget[];
  readonly repositoryAction?: ReactNode;
  readonly onThreadRefChange?: (input: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) => Promise<void> | void;
}

export function SourceControlEnvironmentPanel(props: SourceControlEnvironmentPanelProps) {
  const [publishRepositoryCwd, setPublishRepositoryCwd] = useState<string | null>(null);

  return (
    <>
      <SourceControlPanelView
        controller={useSourceControlPanelController(props, setPublishRepositoryCwd)}
        repositoryAction={props.repositoryAction}
      />
      <PublishRepositoryDialog
        open={publishRepositoryCwd !== null}
        onOpenChange={(open) => {
          if (!open) setPublishRepositoryCwd(null);
        }}
        environmentId={props.environmentId}
        threadRef={props.activeThreadRef}
        gitCwd={publishRepositoryCwd ?? props.cwd}
      />
    </>
  );
}
