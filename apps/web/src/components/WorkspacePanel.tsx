import { useSearch } from "@tanstack/react-router";
import type { EnvironmentId, ScopedProjectRef } from "@forma/contracts";

import { parseDiffRouteSearch, resolveWorkspacePanelDisplayMode } from "../diffRouteSearch";
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
}

export default function WorkspacePanel(props: WorkspacePanelProps) {
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const displayMode = resolveWorkspacePanelDisplayMode(diffSearch);
  const shouldRenderFilesPanel =
    !props.supportsDiff || displayMode === "files" || displayMode === "editor-files";
  const modeProps = props.mode ? { mode: props.mode } : {};

  if (shouldRenderFilesPanel) {
    return (
      <WorkspaceFilesPanel
        {...modeProps}
        routeTarget={props.routeTarget}
        environmentId={props.environmentId}
        panelKey={props.panelKey}
        workspaceRoot={props.workspaceRoot}
        activeProjectRef={props.activeProjectRef}
      />
    );
  }

  return (
    <DiffWorkerPoolProvider>
      <DiffPanel {...modeProps} />
    </DiffWorkerPoolProvider>
  );
}
