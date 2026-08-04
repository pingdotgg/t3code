import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { SourceControlPanelView } from "./SourceControlPanelView";
import { useSourceControlPanelController } from "./useSourceControlPanelController";

export interface SourceControlEnvironmentPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly filePanelThreadRef: ScopedThreadRef | null;
  readonly onThreadRefChange?: (input: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) => Promise<void> | void;
}

export function SourceControlEnvironmentPanel(props: SourceControlEnvironmentPanelProps) {
  return <SourceControlPanelView controller={useSourceControlPanelController(props)} />;
}
