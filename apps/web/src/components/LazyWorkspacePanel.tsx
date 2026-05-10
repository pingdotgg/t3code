import { Suspense, lazy, type ComponentProps } from "react";

import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import type WorkspacePanelComponent from "./WorkspacePanel";

type WorkspacePanelModule = typeof import("./WorkspacePanel");
type WorkspacePanelProps = ComponentProps<typeof WorkspacePanelComponent>;

let workspacePanelPromise: Promise<WorkspacePanelModule> | null = null;

function loadWorkspacePanel(): Promise<WorkspacePanelModule> {
  workspacePanelPromise ??= import("./WorkspacePanel")
    .then((module) => {
      module.preloadWorkspacePanelRuntime();
      return module;
    })
    .catch((error: unknown) => {
      workspacePanelPromise = null;
      throw error;
    });
  return workspacePanelPromise;
}

const WorkspacePanel = lazy(loadWorkspacePanel);

function WorkspacePanelFallback(props: { mode: DiffPanelMode }) {
  return (
    <DiffPanelShell mode={props.mode}>
      <div aria-hidden="true" className="min-h-0 flex-1 bg-background" />
    </DiffPanelShell>
  );
}

export function preloadWorkspacePanel(): void {
  void loadWorkspacePanel().catch(() => undefined);
}

export function LazyWorkspacePanel(props: WorkspacePanelProps) {
  return (
    <Suspense fallback={<WorkspacePanelFallback mode={props.mode ?? "inline"} />}>
      <WorkspacePanel {...props} />
    </Suspense>
  );
}
