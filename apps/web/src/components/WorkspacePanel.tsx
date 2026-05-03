import type { EnvironmentId, ScopedProjectRef } from "@forma/contracts";

import { type ThreadRouteTarget } from "../threadRoutes";
import DiffPanel, { DiffWorkerPoolProvider } from "./DiffPanel";
import { type DiffPanelMode } from "./DiffPanelShell";
import { WorkspaceFilesPanel } from "./WorkspaceFilesPanel";

interface WorkspacePanelProps {
  mode?: DiffPanelMode;
  routeTarget: ThreadRouteTarget;
  environmentId: EnvironmentId;
  panelKey: string;
  workspaceRoot: string | null;
  activeProjectRef: ScopedProjectRef | null;
  supportsDiff: boolean;
  requestedDiffToggleNonce?: number | undefined;
}

export default function WorkspacePanel(props: WorkspacePanelProps) {
  const modeProps = props.mode ? { mode: props.mode } : {};
  const content = (
    <WorkspaceFilesPanel
      {...modeProps}
      routeTarget={props.routeTarget}
      environmentId={props.environmentId}
      panelKey={props.panelKey}
      workspaceRoot={props.workspaceRoot}
      activeProjectRef={props.activeProjectRef}
      supportsDiff={props.supportsDiff}
      requestedDiffToggleNonce={props.requestedDiffToggleNonce}
      DiffBrowserComponent={DiffPanel}
    />
  );

  return props.supportsDiff ? <DiffWorkerPoolProvider>{content}</DiffWorkerPoolProvider> : content;
}
